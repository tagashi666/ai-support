import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bot } from 'grammy';
import type { Notifier } from '../core/notify.js';
import type { WebSocket } from 'ws';
import { config, log } from '../config.js';
import { replyWindow, type Conversation, type Store } from '../core/store.js';
import { NoSenderError, Outbox, WindowClosedError } from '../core/outbox.js';
import type { CustomerDirectory } from '../integrations/customers.js';
import { applySettings, runtime } from '../core/settings.js';
import { listDocs, publishDraft, readDoc, removeDoc, slugFromTitle, writeDoc, type Area } from './kbfiles.js';
import { runMining } from '../ai/mining.js';
import { AiProvider } from '../ai/provider.js';
import { decide } from '../ai/gate.js';
import { tryDraft } from '../ai/responder.js';
import { parseExportObject } from '../integrations/tgexport.js';
import type { NodeState, RemnawaveClient } from '../integrations/remnawave.js';
import { version } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));
// Панель лежит в корне проекта, а этот файл — в src/panel и dist/panel.
// Поднимаемся на два уровня, чтобы путь не зависел от глубины вложенности.
const publicDir = join(here, '..', '..', 'public');

const MEDIA_MIME: Record<string, string> = {
  photo: 'image/jpeg',
  video: 'video/mp4',
  voice: 'audio/ogg',
  audio: 'audio/mpeg',
  video_note: 'video/mp4',
  animation: 'video/mp4',
  sticker: 'image/webp',
};

function decorate(conversation: Conversation) {
  const window = replyWindow(conversation);
  return {
    ...conversation,
    window: {
      applies: window.applies,
      open: window.open,
      msLeft: Number.isFinite(window.msLeft) ? window.msLeft : null,
    },
  };
}

export interface WebDeps {
  store: Store;
  outbox: Outbox;
  bot?: Bot;
  notifier?: Notifier;
  nodes?: { get(): { at: number; nodes: NodeState[]; error?: string }; refresh(): Promise<unknown> };
  customers?: CustomerDirectory;
  remnawave?: RemnawaveClient;
  onKbChanged?: () => void;
  onOpened?: (conversation: Conversation) => void;
}

export async function startWeb({ store, outbox, bot, notifier, customers, remnawave, nodes, onKbChanged, onOpened }: WebDeps) {
  // Доверяем заголовку X-Forwarded-For только от локального nginx: без этого
  // все запросы выглядят как 127.0.0.1, и блокировка за подбор токена заперла
  // бы оператора вместе с атакующим. Доверять произвольным адресам нельзя —
  // подделать заголовок может кто угодно.
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, trustProxy: 'loopback' });

  // Fastify отбивает POST с content-type: application/json и пустым телом
  // (FST_ERR_CTP_EMPTY_JSON_BODY) ещё до обработчика. А половина наших
  // действий — именно такие: опубликовать, отметить прочитанным, обновить
  // карточку. Клиент теперь заголовок без тела не шлёт, но сервер обязан
  // быть терпимым: иначе любой curl из документации упирается в 400.
  /**
   * Заголовки безопасности. Стили панели лежат рядом со статикой, никаких
   * сторонних CDN или шрифтов нет, поэтому политика остаётся жёсткой.
   */
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('content-security-policy',
      "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('cross-origin-opener-policy', 'same-origin');
    return payload;
  });

  /**
   * Общий предел частоты. Токен защищён отдельно, но и с верным токеном
   * панель не должна быть источником нагрузки: перебор диалогов или
   * вложений тысячами запросов роняет процесс не хуже подбора.
   */
  const hits = new Map<string, { n: number; resetAt: number }>();
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api') && !request.url.startsWith('/ws')) return;
    const now = Date.now();
    const entry = hits.get(request.ip) ?? { n: 0, resetAt: now + 60_000 };
    if (entry.resetAt < now) { entry.n = 0; entry.resetAt = now + 60_000; }
    entry.n += 1;
    hits.set(request.ip, entry);
    if (entry.n > 600) {
      return reply.code(429).header('retry-after', '60').send({ error: 'Слишком много запросов' });
    }
  });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  // Выгрузка приходит сырым телом, её парсим сами.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, { root: publicDir });

  const sockets = new Set<WebSocket>();
  const broadcast = (frame: unknown): void => {
    const payload = JSON.stringify(frame);
    for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.send(payload);
  };

  const expected = Buffer.from(config.panelToken);
  // Сравнение за постоянное время: обычное === утекает длину общего префикса.
  /**
   * Апдейт business_connection приходит один раз, в момент подключения бота.
   * Если процесс тогда не работал, таблица пуста — но id есть в диалогах,
   * и подключение можно дотянуть напрямую из Telegram.
   */
  const businessConnectionState = async (): Promise<{ id: string | null; enabled: boolean; canReply: boolean } | null> => {
    const id = store.activeBusinessConnectionId() ?? store.anyBusinessConnectionId();
    if (!id || !bot) return id ? { id, enabled: true, canReply: true } : null;
    try {
      const connection = await bot.api.getBusinessConnection(id);
      store.saveBusinessConnection({
        id: connection.id,
        userId: connection.user.id,
        userChatId: connection.user_chat_id,
        isEnabled: connection.is_enabled,
        rights: connection.rights,
        connectedAt: connection.date * 1000,
      });
      return { id, enabled: connection.is_enabled, canReply: connection.rights?.can_reply === true };
    } catch (err) {
      log.debug('Не удалось получить бизнес-подключение', err);
      return { id, enabled: true, canReply: true };
    }
  };

  /**
   * Защита от подбора токена.
   *
   * Панель закрыта одним секретом, и без ограничения частоты его можно
   * перебирать сколько угодно: тысячи попыток в секунду по сети — вопрос
   * нескольких часов для короткого токена. Считаем неудачи по адресу и
   * запираем с нарастающей паузой.
   */
  const failures = new Map<string, { count: number; until: number }>();

  const lockedUntil = (ip: string): number => failures.get(ip)?.until ?? 0;

  const noteFailure = (ip: string): void => {
    const entry = failures.get(ip) ?? { count: 0, until: 0 };
    entry.count += 1;
    // Первые пять попыток — свободно: оператор мог ошибиться при вводе.
    if (entry.count > 5) {
      const waitMs = Math.min(15 * 60_000, 2 ** (entry.count - 5) * 1000);
      entry.until = Date.now() + waitMs;
      log.warn(`Адрес ${ip}: неудачных входов ${entry.count}, заперт на ${Math.round(waitMs / 1000)} с`);
    }
    failures.set(ip, entry);
  };

  const noteSuccess = (ip: string): void => { failures.delete(ip); };

  // Записи о давних неудачах не держим вечно: иначе карта растёт без предела.
  // Тем же проходом чистим и счётчики частоты: за trustProxy: loopback ключ —
  // реальный IP клиента, и без уборки карта hits росла бы неограниченно.
  const forgetTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of failures) {
      if (entry.until < now - 3_600_000) failures.delete(ip);
    }
    for (const [ip, entry] of hits) {
      if (entry.resetAt < now) hits.delete(ip);
    }
  }, 600_000);
  forgetTimer.unref();

  /**
   * Одноразовые билеты для вложений и WebSocket.
   *
   * Раньше туда шёл сам токен панели: он попадал в адресную строку, в
   * историю браузера и в access-лог nginx. Билет живёт десять минут, даёт
   * доступ только к чтению вложений и подписке на события, и по нему нельзя
   * ни отправить сообщение, ни поменять настройку.
   */
  const ticketSecret = randomBytes(32);
  const makeTicket = (): string => {
    const until = Date.now() + 10 * 60_000;
    const mac = createHmac('sha256', ticketSecret).update(String(until)).digest('base64url').slice(0, 32);
    return `${until}.${mac}`;
  };
  const validTicket = (value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    const [untilRaw, mac] = value.split('.');
    const until = Number(untilRaw);
    if (!Number.isFinite(until) || until < Date.now() || !mac) return false;
    const expected = createHmac('sha256', ticketSecret).update(String(until)).digest('base64url').slice(0, 32);
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const authorized = (token: unknown): boolean => {
    if (typeof token !== 'string') return false;
    const given = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api') && !request.url.startsWith('/ws')) return;
    const header = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    const query = (request.query as Record<string, unknown> | undefined)?.token;
    const ip = request.ip;
    const until = lockedUntil(ip);
    if (until > Date.now()) {
      return reply
        .code(429)
        .header('retry-after', String(Math.ceil((until - Date.now()) / 1000)))
        .send({ error: 'Слишком много неудачных попыток. Подождите.' });
    }

    // Билет годится только для чтения вложений и подписки на события. Провал
    // билета НЕ засчитываем в брутфорс-локаут: секрет билетов пересоздаётся
    // при каждом рестарте, и автопереподключение WebSocket со старым билетом —
    // норма, а не подбор. Раньше это запирало вход для всех за общим IP прокси.
    const readOnlyRoute = request.url.startsWith('/api/attachments/') || request.url.startsWith('/ws');
    if (readOnlyRoute) {
      if (validTicket(query) || authorized(header)) return;
      return reply.code(401).send({ error: 'Нужен действующий билет' });
    }

    if (!authorized(header)) {
      noteFailure(ip);
      return reply.code(401).send({ error: 'Нужен токен панели' });
    }
    noteSuccess(ip);
  });

  // --- диалоги ---------------------------------------------------------

  app.get('/api/conversations', async () => ({
    conversations: store.listConversations().map(decorate),
    channels: { tg_dm: outbox.has('tg_dm'), bedolaga: outbox.has('bedolaga') },
    aiMode: runtime.aiMode,
  }));

  app.get<{ Params: { id: string } }>('/api/conversations/:id', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });

    const messages = store.listMessages(conversation.id);
    onOpened?.(conversation);

    return {
      conversation: decorate(conversation),
      messages,
      attachments: store.attachmentsFor(messages.map((message) => message.id)),
      suggestion: store.pendingSuggestion(conversation.id) ?? null,
      // Только кэш: за свежей карточкой панель сходит отдельным запросом,
      // уже показав переписку.
      ...(customers ? (({ profile, stale }) => ({ customer: profile, customerStale: stale }))(customers.peek(conversation)) : { customer: null, customerStale: false }),
    };
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/read', async (request, reply) => {
    const id = Number(request.params.id);
    if (!store.getConversation(id)) return reply.code(404).send({ error: 'Диалог не найден' });
    store.markRead(id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { text?: string; suggestionId?: number; edited?: boolean; replyTo?: string; replyExcerpt?: string } }>(
    '/api/conversations/:id/reply',
    async (request, reply) => {
      const text = request.body?.text?.trim();
      if (!text) return reply.code(400).send({ error: 'Пустое сообщение' });
      const conversationId = Number(request.params.id);
      const suggestionId = request.body?.suggestionId;
      if (suggestionId !== undefined) {
        const suggestion = store.getSuggestion(suggestionId);
        if (!suggestion || suggestion.conversation_id !== conversationId) {
          return reply.code(400).send({ error: 'Предложка не относится к этому диалогу' });
        }
      }
      try {
        const sent = await outbox.send(
          conversationId,
          { text, replyToExternalId: request.body?.replyTo, replyExcerpt: request.body?.replyExcerpt },
          'agent',
          request.body?.suggestionId,
        );
        if (request.body?.suggestionId) {
          store.decideSuggestion(request.body.suggestionId, request.body.edited ? 'edited' : 'sent');
        }
        return { ok: true, message: sent.message };
      } catch (err) {
        if (err instanceof WindowClosedError) return reply.code(409).send({ error: err.message });
        if (err instanceof NoSenderError) return reply.code(501).send({ error: err.message });
        log.error('Отправка не удалась', err);
        return reply.code(502).send({ error: `Отправить не удалось: ${(err as Error).message}` });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    '/api/conversations/:id/note',
    async (request, reply) => {
      const text = request.body?.text?.trim();
      if (!text) return reply.code(400).send({ error: 'Пустая заметка' });
      const id = Number(request.params.id);
      if (!store.getConversation(id)) return reply.code(404).send({ error: 'Диалог не найден' });
      const added = store.addNote(id, text);
      return { ok: true, message: added.message };
    },
  );

  app.post<{ Params: { id: string }; Body: { status?: string; aiMode?: string; escalated?: boolean; handoff?: boolean } }>(
    '/api/conversations/:id/state',
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!store.getConversation(id)) return reply.code(404).send({ error: 'Диалог не найден' });
      const { status, aiMode, escalated, handoff } = request.body ?? {};
      if (status && !['open', 'pending', 'resolved'].includes(status)) {
        return reply.code(400).send({ error: 'Неизвестный статус диалога' });
      }
      if (aiMode !== undefined && !['inherit', 'off', 'suggest', 'auto'].includes(aiMode)) {
        return reply.code(400).send({ error: 'Неизвестный режим AI' });
      }
      if (typeof handoff === 'boolean') store.setHandoff(id, handoff ? Date.now() : null);
      if (status) store.setStatus(id, status);
      if (aiMode === 'inherit' || aiMode === 'off' || aiMode === 'suggest' || aiMode === 'auto') store.setAiMode(id, aiMode);
      if (typeof escalated === 'boolean') {
        store.setEscalated(id, escalated, escalated ? 'high' : undefined);
        if (escalated) {
          const conversation = store.getConversation(id)!;
          void notifier?.notify('escalated', conversation, {
            excerpt: store.lastInboundMessage(id)?.text ?? undefined,
            reason: 'отмечен важным в панели',
          });
        }
      }
      return { ok: true, conversation: decorate(store.getConversation(id)!) };
    },
  );

  /** Карточка со всеми источниками. Может ходить в сеть — вызывается фоном. */
  app.get<{ Params: { id: string } }>('/api/conversations/:id/customer', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    if (!customers) return reply.code(501).send({ error: 'Источники карточки не настроены' });
    return { customer: await customers.get(conversation).catch(() => null) };
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/customer/refresh', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    if (!customers) return reply.code(501).send({ error: 'Источники карточки не настроены' });
    return { ok: true, customer: await customers.build(conversation) };
  });

  // --- предложения AI --------------------------------------------------

  app.post<{ Params: { id: string }; Body: { status?: string } }>(
    '/api/suggestions/:id/decide',
    async (request, reply) => {
      const suggestion = store.getSuggestion(Number(request.params.id));
      if (!suggestion) return reply.code(404).send({ error: 'Предложка не найдена' });
      const status = request.body?.status === 'rejected' ? 'rejected' : 'superseded';
      store.decideSuggestion(suggestion.id, status);
      return { ok: true };
    },
  );

  // --- шаблоны, статистика, вложения -----------------------------------

  app.get('/api/templates', async () => ({ templates: store.listTemplates() }));

  app.post<{ Body: { shortcut?: string; title?: string; body?: string } }>(
    '/api/templates',
    async (request, reply) => {
      const { shortcut, title, body } = request.body ?? {};
      if (!shortcut || !title || !body) return reply.code(400).send({ error: 'Нужны shortcut, title и body' });
      store.upsertTemplate(shortcut.trim(), title.trim(), body);
      return { ok: true, templates: store.listTemplates() };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/templates/:id', async (request) => {
    store.deleteTemplate(Number(request.params.id));
    return { ok: true, templates: store.listTemplates() };
  });

  app.get<{ Querystring: { days?: string } }>('/api/stats', async (request) => {
    const days = Math.min(90, Math.max(1, Number(request.query.days ?? 14) || 14));
    return store.stats(days);
  });

  app.get<{ Params: { id: string } }>('/api/attachments/:id', async (request, reply) => {
    const attachment = store.getAttachment(Number(request.params.id));
    if (!attachment?.local_path) return reply.code(404).send({ error: 'Вложение ещё не скачано' });
    return reply
      .type(MEDIA_MIME[attachment.media_type ?? ''] ?? 'application/octet-stream')
      .send(createReadStream(attachment.local_path));
  });

  app.get('/api/health', async () => ({
    ok: true,
    kb: store.kbCount(),
    businessConnection: store.activeBusinessConnectionId() ?? null,
    lastBedolagaPoll: store.getState('bedolaga:last_poll') ?? null,
  }));

  // --- подписка клиента --------------------------------------------------

  /**
   * Идентификатор в Remnawave ищется тем же путём, что и карточка клиента:
   * поле в данных бедолаги, затем поиск по telegram id и нику, включая
   * свободное описание. Отдельная упрощённая логика здесь уже приводила
   * к «нет идентификатора» на клиентах, которые в панели есть.
   */
  const resolveRef = async (conversation: Conversation): Promise<string | undefined> => {
    if (!customers) return undefined;
    const profile = await customers.get(conversation).catch(() => null);
    return profile?.remnawaveRef;
  };

  /** Разбор связки с Remnawave: показывает, что искали и что нашли. */
  app.get<{ Params: { id: string } }>('/api/conversations/:id/subscription/explain', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    if (!remnawave) return reply.code(501).send({ error: 'Панель Remnawave не подключена' });
    const profile = customers ? await customers.build(conversation).catch(() => null) : null;
    return remnawave.explain(
      profile?.identity?.telegramId ?? conversation.tg_user_id ?? undefined,
      profile?.identity?.username ?? conversation.username ?? undefined,
    );
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/subscription', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    if (!remnawave) return reply.code(501).send({ error: 'Панель Remnawave не подключена' });

    const ref = await resolveRef(conversation);
    if (!ref) {
      return reply.code(404).send({
        error: `Клиент не найден в Remnawave ни по telegram id, ни по нику. Проверьте, что он есть в панели — при необходимости впишите ${conversation.tg_user_id ?? 'telegram id'} в поле «Описание» его записи.`,
      });
    }

    const profile = await remnawave.profile(ref);
    const devices = await remnawave.devices(ref);
    return { ref, profile: profile ?? null, devices: devices ?? null, capabilities: remnawave.capabilities() };
  });

  /**
   * Разрушающие действия. Оператор подтверждает их в панели, а не AI —
   * сброс устройств и перевыпуск ключа клиент почувствует немедленно.
   */
  app.post<{ Params: { id: string }; Body: { action?: string; hwid?: string } }>(
    '/api/conversations/:id/subscription/action',
    async (request, reply) => {
      const conversation = store.getConversation(Number(request.params.id));
      if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
      if (!remnawave) return reply.code(501).send({ error: 'Панель Remnawave не подключена' });

      const ref = await resolveRef(conversation);
      if (!ref) return reply.code(404).send({ error: 'Клиент не найден в Remnawave' });

      const { action, hwid } = request.body ?? {};
      let ok = false;
      if (action === 'reset-devices') ok = await remnawave.resetDevices(ref);
      else if (action === 'revoke') ok = await remnawave.revoke(ref);
      else if (action === 'delete-device' && hwid) ok = await remnawave.deleteDevice(ref, hwid);
      else return reply.code(400).send({ error: 'Неизвестное действие' });

      store.logEvent(`remnawave_${action}`, conversation.id, { ref, hwid, ok });
      if (!ok) return reply.code(502).send({ error: 'Панель Remnawave отклонила операцию' });

      // След в переписке: через неделю никто не вспомнит, кто сбросил устройства.
      const label = action === 'reset-devices' ? 'сброшены все устройства'
        : action === 'revoke' ? 'подписка перевыпущена'
        : `удалено устройство ${hwid}`;
      store.addNote(conversation.id, `Оператор: ${label}`);
      return { ok: true };
    },
  );

  // --- AI: связь, модели, песочница --------------------------------------

  app.get('/api/ai/keys', async () => {
    const provider = new AiProvider();
    return { keys: provider.maskedKeys(), bound: { model: runtime.modelKey, fallback: runtime.fallbackKey } };
  });

  app.get('/api/ai/models', async (_request, reply) => {
    if (!config.ai.apiKeys.length) return reply.code(501).send({ error: 'AI_API_KEY не задан' });
    try {
      return { models: await new AiProvider().listModels() };
    } catch (err) {
      return reply.code(502).send({ error: `Список моделей недоступен: ${(err as Error).message}` });
    }
  });

  app.post('/api/ai/ping', async (_request, reply) => {
    if (!config.ai.apiKeys.length) return reply.code(501).send({ error: 'AI_API_KEY не задан' });
    const provider = new AiProvider();
    const started = Date.now();
    try {
      await provider.ping();
      return { ok: true, ms: Date.now() - started, model: runtime.model, keys: provider.keyState() };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message, keys: provider.keyState() });
    }
  });

  /**
   * Песочница: тот же путь, что и для клиента, но без диалога и без отправки.
   * Нужна, чтобы проверять правки промпта и базы знаний на реальных вопросах,
   * а не на живых людях.
   */
  app.post<{ Body: { text?: string } }>('/api/ai/try', async (request, reply) => {
    const text = request.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: 'Пустой вопрос' });
    if (!config.ai.apiKeys.length) return reply.code(501).send({ error: 'AI_API_KEY не задан' });

    const hits = store.searchKb(text, config.ai.kbLimit);
    const started = Date.now();
    try {
      const draft = await tryDraft(text, hits);
      if (!draft) return reply.code(502).send({ error: 'Модель вернула ответ, который не разобрался' });

      // Показываем и вердикт ворот: почему такой ответ ушёл бы или не ушёл.
      const probe: Conversation = {
        ...(store.listConversations(1)[0] ?? ({} as Conversation)),
        id: -1, channel: 'tg_dm', escalated: 0, handoff_at: null,
        ai_mode: 'auto', last_inbound_at: Date.now(),
      } as Conversation;
      const verdict = decide(store, probe, text, draft, hits.length);

      return {
        draft,
        ms: Date.now() - started,
        model: runtime.model,
        sources: hits.map((hit) => hit.title),
        verdict,
      };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // --- настройки ---------------------------------------------------------

  app.post('/api/settings/test-alert', async (_request, reply) => {
    if (!notifier) return reply.code(501).send({ error: 'Уведомления не настроены' });
    const result = await notifier.test();
    return result.ok ? { ok: true } : reply.code(502).send({ error: result.error });
  });

  app.get('/api/nodes', async (_request, reply) => {
    if (!nodes) return reply.code(501).send({ error: 'Состояние узлов выключено (NODES_STATUS_ENABLED=false)' });
    const snap = nodes.get();
    const aliases = store.nodeAliases();
    // rawName и текущий псевдоним нужны панели: оператор видит внутреннее имя
    // и правит ярлык, который увидит модель. Наружу (клиенту) rawName не идёт.
    return { ...snap, nodes: snap.nodes.map((n) => ({ ...n, alias: aliases[n.rawName] ?? null })) };
  });

  app.post('/api/nodes/refresh', async (_request, reply) => {
    if (!nodes) return reply.code(501).send({ error: 'Состояние узлов выключено' });
    return nodes.refresh();
  });

  // Псевдоним узла для модели: пустая строка снимает его.
  app.post<{ Body: { name?: string; alias?: string } }>('/api/nodes/alias', async (request, reply) => {
    if (!nodes) return reply.code(501).send({ error: 'Состояние узлов выключено' });
    const name = request.body?.name?.trim();
    if (!name) return reply.code(400).send({ error: 'Не указан узел' });
    const alias = (request.body?.alias ?? '').trim();
    if (alias.length > 40) return reply.code(400).send({ error: 'Псевдоним не длиннее 40 символов' });
    store.setNodeAlias(name, alias);
    return { ok: true };
  });

  app.get('/api/ticket', async () => ({ ticket: makeTicket() }));

  app.get('/api/settings', async () => ({
    version,
    runtime,
    businessConnectionLive: await businessConnectionState(),
    channels: { tg_dm: outbox.has('tg_dm'), bedolaga: outbox.has('bedolaga') },
    remnawave: remnawave ? { ...remnawave.capabilities(), index: remnawave.indexState() } : null,
    alerts: notifier?.state() ?? null,
    nodes: nodes ? { known: nodes.get().nodes.length, at: nodes.get().at } : null,
    readOnly: config.remnawave.readOnly,
    ai: { keys: config.ai.apiKeys.length, model: runtime.model, fallback: runtime.fallbackModel || null },
    kb: store.kbCount(),
    businessConnection: store.activeBusinessConnectionId() ?? null,
    lastBedolagaPoll: store.getState('bedolaga:last_poll') ?? null,
  }));

  app.post<{ Body: Record<string, unknown> }>('/api/settings', async (request, reply) => {
    const values = request.body ?? {};
    if (values['aiMode'] !== undefined && values['aiMode'] !== 'off' && !config.ai.apiKeys.length) {
      return reply.code(400).send({ error: 'Сначала задайте AI_API_KEY на сервере' });
    }
    const result = applySettings(store, values);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return { ok: true, runtime };
  });

  // --- база знаний -------------------------------------------------------

  app.get('/api/kb', async () => ({
    kb: await listDocs('kb'),
    drafts: await listDocs('draft'),
  }));

  app.get<{ Params: { area: string; name: string } }>('/api/kb/:area/:name', async (request, reply) => {
    const area = request.params.area === 'draft' ? 'draft' : 'kb';
    try {
      return { name: request.params.name, text: await readDoc(area as Area, request.params.name) };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.put<{ Params: { area: string; name: string }; Body: { text?: string } }>(
    '/api/kb/:area/:name',
    async (request, reply) => {
      const area = request.params.area === 'draft' ? 'draft' : 'kb';
      const text = request.body?.text;
      if (typeof text !== 'string' || !text.trim()) return reply.code(400).send({ error: 'Пустой текст' });
      try {
        await writeDoc(area as Area, request.params.name, text);
        if (area === 'kb') onKbChanged?.();
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Body: { title?: string; text?: string } }>('/api/kb', async (request, reply) => {
    const { title, text } = request.body ?? {};
    if (!title?.trim() || !text?.trim()) return reply.code(400).send({ error: 'Нужны заголовок и текст' });
    const name = slugFromTitle(title);
    await writeDoc('kb', name, `# ${title.trim()}\n\n${text.trim()}\n`);
    onKbChanged?.();
    return { ok: true, name };
  });

  app.delete<{ Params: { area: string; name: string } }>('/api/kb/:area/:name', async (request, reply) => {
    const area = request.params.area === 'draft' ? 'draft' : 'kb';
    try {
      await removeDoc(area as Area, request.params.name);
      if (area === 'kb') onKbChanged?.();
      return { ok: true };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { name: string } }>('/api/kb/publish/:name', async (request, reply) => {
    try {
      await publishDraft(request.params.name);
      onKbChanged?.();
      return { ok: true };
    } catch (err) {
      const message = (err as NodeJS.ErrnoException).code === 'EACCES'
        ? `Нет прав на запись в каталог базы знаний. На сервере: chown -R 1000:1000 kb`
        : (err as Error).message;
      log.error(`Публикация ${request.params.name} не удалась`, err);
      return reply.code(400).send({ error: message });
    }
  });

  /**
   * Выгрузка Telegram Desktop. Файл приходит сырым телом: экспорт бывает
   * в десятки мегабайт, и json-парсер Fastify с общим лимитом его не примет.
   */
  app.post<{ Querystring: { me?: string } }>(
    '/api/kb/mine/export',
    { bodyLimit: 96 * 1024 * 1024 },
    async (request, reply) => {
      const raw = request.body;
      if (!Buffer.isBuffer(raw) || !raw.length) return reply.code(400).send({ error: 'Пустой файл' });

      let parsed: { name?: string; messages?: unknown[] };
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'Это не JSON. Нужен result.json из экспорта Telegram Desktop.' });
      }
      if (!Array.isArray(parsed.messages)) {
        return reply.code(400).send({ error: 'В файле нет списка сообщений — похоже, это не выгрузка переписки.' });
      }

      const { chatName, participants, exchanges } = parseExportObject(parsed, request.query.me);
      if (!request.query.me) {
        return { needsMe: true, chatName, participants };
      }
      if (!exchanges.length) return reply.code(400).send({ error: 'Пар «вопрос-ответ» не нашлось' });

      const jobId = store.startJob('mine');
      if (jobId < 0) return reply.code(409).send({ error: 'Сбор уже идёт' });

      void (async () => {
        try {
          const report = await runMining(store, { source: 'export', exchanges }, (message) => {
            store.updateJob(jobId, message);
            broadcast({ type: 'job', kind: 'mine', status: 'running', progress: message });
          });
          store.finishJob(jobId, report);
          if (report.articles.length) onKbChanged?.();
          broadcast({ type: 'job', kind: 'mine', status: 'done', report });
        } catch (err) {
          const message = (err as Error).message;
          store.finishJob(jobId, undefined, message);
          broadcast({ type: 'job', kind: 'mine', status: 'failed', error: message });
        }
      })();

      return { ok: true, chatName, pairs: exchanges.length };
    },
  );

  // --- майнинг как фоновая задача ----------------------------------------

  app.get('/api/kb/mine', async () => ({ job: store.latestJob('mine') ?? null }));

  app.post<{ Body: { source?: string; status?: string; limit?: number; dryRun?: boolean; all?: boolean } }>(
    '/api/kb/mine',
    async (request, reply) => {
      const jobId = store.startJob('mine');
      if (jobId < 0) return reply.code(409).send({ error: 'Сбор уже идёт' });

      const options = request.body ?? {};
      // Запускаем в фоне: проход с паузами против лимитов длится минуты,
      // держать ради него HTTP-соединение незачем.
      void (async () => {
        try {
          const report = await runMining(
            store,
            {
              source: options.source === 'panel' ? 'panel' : 'archive',
              status: options.status,
              limit: options.limit,
              all: options.all,
              dryRun: options.dryRun,
            },
            (message) => {
              store.updateJob(jobId, message);
              broadcast({ type: 'job', kind: 'mine', status: 'running', progress: message });
            },
          );
          store.finishJob(jobId, report);
          if (!report.dryRun && report.articles.length) onKbChanged?.();
          broadcast({ type: 'job', kind: 'mine', status: 'done', report });
        } catch (err) {
          const message = (err as Error).message;
          store.finishJob(jobId, undefined, message);
          broadcast({ type: 'job', kind: 'mine', status: 'failed', error: message });
        }
      })();

      return { ok: true, jobId };
    },
  );

  // --- живое обновление ------------------------------------------------

  app.get('/ws', { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  store.on('message', ({ conversation, message }) =>
    broadcast({
      type: 'message',
      conversation: decorate(conversation),
      message,
      attachments: store.attachmentsFor([message.id]),
    }),
  );
  store.on('suggestion', ({ conversation, suggestion }) =>
    broadcast({ type: 'suggestion', conversation: decorate(conversation), suggestion }),
  );

  await app.listen({ port: config.panelPort, host: config.panelHost });
  log.info(`Панель слушает http://${config.panelHost}:${config.panelPort}`);
  return app;
}
