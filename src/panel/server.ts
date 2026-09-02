import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bot } from 'grammy';
import { TelegramBotRegistry } from '../channels/tgdm.js';
import type { Notifier } from '../core/notify.js';
import type { WebSocket } from 'ws';
import { config, log } from '../config.js';
import { readLimitedBody } from '../core/http.js';
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
import type { BedolagaClient, BedolagaTicketStatus } from '../channels/bedolaga.js';
import { UpdateManager } from '../core/update.js';
import { SourceManager } from '../core/sources.js';
import { Operations, type Actor, type Permission } from '../core/operations.js';
import { openMediaFile } from '../core/media.js';

const here = dirname(fileURLToPath(import.meta.url));
// Панель лежит в корне проекта, а этот файл — в src/panel и dist/panel.
// Поднимаемся на два уровня, чтобы путь не зависел от глубины вложенности.
const publicDir = join(here, '..', '..', 'public');

const inlineScripts = Array.from(
  readFileSync(join(publicDir, 'index.html'), 'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),
);
if (inlineScripts.length !== 1 || inlineScripts[0]?.[1] === undefined) {
  throw new Error('Для строгой CSP в public/index.html должен быть ровно один встроенный script');
}
const PANEL_SCRIPT_HASH = `'sha256-${createHash('sha256').update(inlineScripts[0][1]).digest('base64')}'`;

const MEDIA_MIME: Record<string, string> = {
  photo: 'image/jpeg',
  video: 'video/mp4',
  voice: 'audio/ogg',
  audio: 'audio/mpeg',
  video_note: 'video/mp4',
  animation: 'video/mp4',
  sticker: 'image/webp',
};

/**
 * Telegram нередко отдаёт фотографии как application/octet-stream. При
 * X-Content-Type-Options: nosniff браузер закономерно отказывается рисовать
 * такой ответ в <img>, поэтому тип определяем по сигнатуре самих байтов.
 */
function imageMime(body: Buffer, declared: string | null): string | null {
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (body.length >= 12 && body.subarray(0, 4).toString('ascii') === 'RIFF'
      && body.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (body.length >= 6 && ['GIF87a', 'GIF89a'].includes(body.subarray(0, 6).toString('ascii'))) return 'image/gif';
  const mime = declared?.split(';', 1)[0]?.trim().toLowerCase();
  return mime && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime) ? mime : null;
}

function decorate(conversation: Conversation, store: Store, operations?: Operations) {
  const window = replyWindow(conversation);
  const sourceIds = store.conversationSourceIds(conversation.id);
  const source = store.sourceAccount(conversation.source_id);
  return {
    ...conversation,
    source_ids: sourceIds,
    source: source ? { id: source.id, kind: source.kind, name: source.name } : null,
    window: {
      applies: window.applies,
      open: window.open,
      msLeft: Number.isFinite(window.msLeft) ? window.msLeft : null,
    },
    ...(operations ? { collaboration: operations.collaboration(conversation.id) } : {}),
  };
}

export interface WebDeps {
  store: Store;
  outbox: Outbox;
  bot?: Bot | TelegramBotRegistry;
  notifier?: Notifier;
  nodes?: { get(): { at: number; nodes: NodeState[]; error?: string }; refresh(): Promise<unknown> };
  customers?: CustomerDirectory;
  remnawave?: RemnawaveClient;
  remnawaves?: { id: string; name: string; client: RemnawaveClient; readOnly: boolean }[];
  bedolaga?: BedolagaClient;
  onKbChanged?: () => void;
  onOpened?: (conversation: Conversation) => void;
}

export async function startWeb({ store, outbox, bot, notifier, customers, remnawave, remnawaves = [], bedolaga, nodes, onKbChanged, onOpened }: WebDeps) {
  // Доверяем заголовку X-Forwarded-For только от локального nginx: без этого
  // все запросы выглядят как 127.0.0.1, и блокировка за подбор токена заперла
  // бы оператора вместе с атакующим. Доверять произвольным адресам нельзя —
  // подделать заголовок может кто угодно.
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, trustProxy: 'loopback' });
  const updates = new UpdateManager();
  const sources = new SourceManager();
  const operations = new Operations(store);
  const actors = new WeakMap<object, Actor>();
  const actorOf = (request: object): Actor => actors.get(request) ?? operations.rootActor();

  // Fastify отбивает POST с content-type: application/json и пустым телом
  // (FST_ERR_CTP_EMPTY_JSON_BODY) ещё до обработчика. А половина наших
  // действий — именно такие: опубликовать, отметить прочитанным, обновить
  // карточку. Клиент теперь заголовок без тела не шлёт, но сервер обязан
  // быть терпимым: иначе любой curl из документации упирается в 400.
  /**
   * Заголовки безопасности. Стили панели лежат рядом со статикой, никаких
   * сторонних CDN или шрифтов нет, поэтому политика остаётся жёсткой.
   */
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('content-security-policy',
      "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      `script-src 'self' ${PANEL_SCRIPT_HASH}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('x-permitted-cross-domain-policies', 'none');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (request.url.startsWith('/api') && !reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
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

  // Централизованный аудит успешных изменений. Поля, похожие на секреты,
  // Operations вычищает перед записью; GET-запросы журнал не раздувают.
  app.addHook('onResponse', async (request, reply) => {
    if (!request.url.startsWith('/api') || ['GET', 'HEAD', 'OPTIONS'].includes(request.method) || reply.statusCode >= 400) return;
    const actor = actors.get(request);
    if (!actor) return;
    const path = request.url.split('?')[0] ?? request.url;
    const parts = path.split('/').filter(Boolean);
    operations.audit(actor, `${request.method} ${path}`, parts[1] ?? 'api', parts[2], request.body, request.ip);
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
  const socketIps = new Map<string, number>();
  const socketOwners = new WeakMap<WebSocket, string>();
  const removeSocket = (socket: WebSocket): void => {
    if (!sockets.delete(socket)) return;
    const ip = socketOwners.get(socket);
    if (!ip) return;
    const count = socketIps.get(ip) ?? 0;
    if (count <= 1) socketIps.delete(ip);
    else socketIps.set(ip, count - 1);
  };
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
  const businessConnectionState = async (): Promise<{ enabled: boolean; canReply: boolean } | null> => {
    const id = store.activeBusinessConnectionId() ?? store.anyBusinessConnectionId();
    if (!id || !bot) return id ? { enabled: true, canReply: true } : null;
    try {
      const saved = store.businessConnection(id);
      const selectedBot = bot instanceof TelegramBotRegistry ? bot.botBySource(saved?.source_id) : bot;
      if (!selectedBot) return { enabled: true, canReply: true };
      const connection = await selectedBot.api.getBusinessConnection(id);
      store.saveBusinessConnection({
        id: connection.id,
        userId: connection.user.id,
        userChatId: connection.user_chat_id,
        isEnabled: connection.is_enabled,
        rights: connection.rights,
        connectedAt: connection.date * 1000,
      });
      return { enabled: connection.is_enabled, canReply: connection.rights?.can_reply === true };
    } catch (err) {
      log.debug('Не удалось получить бизнес-подключение', err);
      return { enabled: true, canReply: true };
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

  const authorizedRoot = (token: unknown): boolean => {
    if (typeof token !== 'string') return false;
    const given = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const identify = (token: unknown): Actor | null => {
    if (typeof token !== 'string') return null;
    if (authorizedRoot(token)) return operations.rootActor();
    return operations.authenticate(token);
  };

  const permissionFor = (method: string, url: string): Permission => {
    // Эти GET-ответы содержат административные данные, поэтому общий
    // read-only допуск ниже для них слишком широк.
    if (url.startsWith('/api/update')) return 'update:manage';
    if (url.startsWith('/api/sources')) return 'settings:write';
    if (url.startsWith('/api/operators')) return 'operators:manage';
    if (url.startsWith('/api/audit')) return 'audit:read';
    if (url.startsWith('/api/diagnostics')) return 'audit:read';
    if (url.startsWith('/api/learning')) return 'knowledge:review';
    if (url.startsWith('/api/ai/keys') || url.startsWith('/api/ai/models') || url.startsWith('/api/ai/ping')) {
      return 'settings:write';
    }
    if (url.startsWith('/api/ai/try')) return 'knowledge:review';
    if (url.startsWith('/api/stats/reset')) return 'settings:write';
    if (url.startsWith('/api/inbox/folders') && method !== 'GET') return 'settings:write';
    // Subscription URL is a live credential, not ordinary conversation data.
    // A viewer may inspect the dialogue, but must not retrieve or copy it.
    // Destructive subscription actions remain admin-only.
    if (url.includes('/subscription/action')) return 'settings:write';
    if (url.includes('/subscription')) return 'conversation:write';
    if (method === 'GET' || method === 'HEAD') return 'conversation:read';
    if (url.startsWith('/api/settings') || url.startsWith('/api/nodes')) return 'settings:write';
    if (url.startsWith('/api/kb') || url.startsWith('/api/templates') || url.startsWith('/api/sla')) return 'knowledge:review';
    return 'conversation:write';
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
    const readOnlyRoute = request.url.startsWith('/api/attachments/')
      || /^\/api\/conversations\/\d+\/avatar(?:\?|$)/.test(request.url)
      || request.url.startsWith('/ws');
    if (readOnlyRoute) {
      if (validTicket(query)) return;
      const actor = identify(header);
      if (actor) { actors.set(request, actor); return; }
      return reply.code(401).send({ error: 'Нужен действующий билет' });
    }

    const actor = identify(header);
    if (!actor) {
      noteFailure(ip);
      return reply.code(401).send({ error: 'Нужен токен панели' });
    }
    noteSuccess(ip);
    actors.set(request, actor);
    if (!operations.can(actor, permissionFor(request.method, request.url))) {
      return reply.code(403).send({ error: 'Недостаточно прав для этого действия' });
    }
  });

  // --- диалоги ---------------------------------------------------------

  app.get('/api/conversations', async () => ({
    conversations: store.listConversations().map((item) => decorate(item, store, operations)),
    channels: { tg_dm: outbox.has('tg_dm'), tg_bot: outbox.has('tg_bot'), bedolaga: outbox.has('bedolaga') },
    aiMode: runtime.aiMode,
  }));

  app.get('/api/inbox/meta', async () => ({
    sources: store.sourceAccounts().map(({ id, kind, name, enabled }) => ({ id, kind, name, enabled: Boolean(enabled) })),
    folders: store.folders(),
    serviceProfiles: store.serviceProfiles(),
  }));

  app.post<{ Body: { id?: number; name?: string; color?: string | null; sourceIds?: string[] } }>(
    '/api/inbox/folders',
    async (request, reply) => {
      try {
        const folder = store.saveFolder({
          id: request.body?.id ? Number(request.body.id) : undefined,
          name: request.body?.name ?? '',
          color: request.body?.color ?? null,
          sourceIds: Array.isArray(request.body?.sourceIds) ? request.body.sourceIds : [],
        });
        return { ok: true, folder, folders: store.folders() };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/inbox/folders/:id', async (request, reply) => {
    if (!store.deleteFolder(Number(request.params.id))) return reply.code(404).send({ error: 'Папка не найдена' });
    return { ok: true, folders: store.folders() };
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });

    const messages = store.listMessages(conversation.id);
    onOpened?.(conversation);

    return {
      conversation: decorate(conversation, store, operations),
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

  /** Присутствие для совместной работы не означает, что оператор забрал ответ у AI. */
  app.post<{ Params: { id: string }; Body: { state?: string } }>('/api/conversations/:id/presence', async (request, reply) => {
    const id = Number(request.params.id);
    if (!store.getConversation(id)) return reply.code(404).send({ error: 'Диалог не найден' });
    operations.presence(id, actorOf(request), request.body?.state);
    return { ok: true, collaboration: operations.collaboration(id) };
  });

  /** Lease не только останавливает AI, но и не даёт двум операторам ответить одновременно. */
  app.post<{ Params: { id: string }; Body: { state?: string; force?: boolean } }>('/api/conversations/:id/engage', async (request, reply) => {
    const id = Number(request.params.id);
    if (!store.getConversation(id)) return reply.code(404).send({ error: 'Диалог не найден' });
    const actor = actorOf(request);
    const force = request.body?.force === true && operations.can(actor, 'conversation:assign');
    const claimed = operations.claim(id, actor, force);
    if (!claimed.ok) {
      return reply.code(409).send({ error: `Диалог уже ведёт ${claimed.owner}`, collaboration: operations.collaboration(id) });
    }
    operations.presence(id, actor, request.body?.state);
    store.markOperatorActive(id);
    return { ok: true, collaboration: operations.collaboration(id) };
  });

  app.post<{ Params: { id: string }; Body: { force?: boolean } }>('/api/conversations/:id/release', async (request, reply) => {
    const actor = actorOf(request);
    const force = request.body?.force === true && operations.can(actor, 'conversation:assign');
    const id = Number(request.params.id);
    if (!operations.release(id, actor, force)) return reply.code(409).send({ error: 'Диалог закреплён за другим оператором' });
    return { ok: true, collaboration: operations.collaboration(id) };
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/avatar', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation?.avatar_file_id || !bot) return reply.code(404).send();
    try {
      const selectedBot = bot instanceof TelegramBotRegistry ? bot.botFor(conversation) : bot;
      const token = bot instanceof TelegramBotRegistry
        ? bot.tokenFor(conversation.avatar_source_id ?? conversation.source_id)
        : config.botToken;
      if (!token) return reply.code(404).send();
      const file = await selectedBot.api.getFile(conversation.avatar_file_id);
      if (!file.file_path) return reply.code(404).send();
      const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return reply.code(502).send();
      const body = await readLimitedBody(response, Math.min(config.mediaMaxFileBytes, 5 * 1024 * 1024));
      const mime = imageMime(body, response.headers.get('content-type'));
      if (!mime) return reply.code(502).send();
      return reply
        .header('cache-control', 'private, max-age=300')
        .type(mime)
        .send(body);
    } catch (err) {
      log.warn('Не удалось загрузить аватар Telegram', err);
      return reply.code(502).send();
    }
  });

  app.post<{ Params: { id: string }; Body: { text?: string; suggestionId?: number; edited?: boolean; replyTo?: string; replyExcerpt?: string } }>(
    '/api/conversations/:id/reply',
    async (request, reply) => {
      const text = request.body?.text?.trim();
      if (!text) return reply.code(400).send({ error: 'Пустое сообщение' });
      const conversationId = Number(request.params.id);
      const actor = actorOf(request);
      const claimed = operations.claim(conversationId, actor);
      if (!claimed.ok) return reply.code(409).send({ error: `Диалог уже ведёт ${claimed.owner}` });
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
      const before = store.getConversation(id);
      if (!before) return reply.code(404).send({ error: 'Диалог не найден' });
      const { status, aiMode, escalated, handoff } = request.body ?? {};
      if (status && !['open', 'pending', 'resolved'].includes(status)) {
        return reply.code(400).send({ error: 'Неизвестный статус диалога' });
      }
      if (aiMode !== undefined && !['inherit', 'off', 'shadow', 'suggest', 'auto'].includes(aiMode)) {
        return reply.code(400).send({ error: 'Неизвестный режим AI' });
      }
      if (status && before.channel === 'bedolaga') {
        if (!bedolaga) return reply.code(503).send({ error: 'Интеграция Bedolaga отключена' });
        // В Bedolaga `answered` означает «администратор ответил, ждём
        // клиента»; `pending` там — отдельное состояние «в обработке».
        const remoteStatus: BedolagaTicketStatus = status === 'resolved' ? 'closed' : status === 'pending' ? 'answered' : 'open';
        const remoteTicketId = Number(before.remote_external_id ?? before.external_id);
        if (!Number.isSafeInteger(remoteTicketId) || remoteTicketId <= 0) {
          return reply.code(409).send({ error: 'У диалога нет корректного ID тикета Bedolaga' });
        }
        try {
          await bedolaga.setStatus(remoteTicketId, remoteStatus);
        } catch (err) {
          log.error('Не удалось изменить статус тикета Bedolaga', err);
          return reply.code(502).send({ error: `Bedolaga не приняла статус: ${(err as Error).message}` });
        }
      }
      if (typeof handoff === 'boolean') store.setHandoff(id, handoff ? Date.now() : null);
      if (status) store.setStatus(id, status);
      if (aiMode === 'inherit' || aiMode === 'off' || aiMode === 'shadow' || aiMode === 'suggest' || aiMode === 'auto') store.setAiMode(id, aiMode);
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
      if (status === 'resolved' && before.status !== 'resolved' && runtime.autoLearn && config.ai.apiKeys.length) {
        const jobId = store.startJob('auto-learn');
        if (jobId > 0) void (async () => {
          try {
            const report = await runMining(store, { source: 'panel', conversationIds: [id], all: true, limit: 1 }, (message) => {
              store.updateJob(jobId, message);
              broadcast({ type: 'job', kind: 'auto-learn', status: 'running', progress: message });
            });
            store.finishJob(jobId, report);
            if (!report.dryRun && report.articles.length) operations.registerCandidates(report.articles, 'auto-learn');
            broadcast({ type: 'job', kind: 'auto-learn', status: 'done', report });
          } catch (err) {
            const message = (err as Error).message;
            store.finishJob(jobId, undefined, message);
            broadcast({ type: 'job', kind: 'auto-learn', status: 'failed', error: message });
          }
        })();
      }
      return { ok: true, conversation: decorate(store.getConversation(id)!, store, operations) };
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

  // --- единый клиент и совместная работа -------------------------------

  app.get<{ Params: { id: string } }>('/api/conversations/:id/profile', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    return { profile: operations.profile(conversation) };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/conversations/:id/profile', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    return { ok: true, profile: operations.updateProfile(conversation, request.body ?? {}) };
  });

  app.post<{ Params: { id: string }; Body: { text?: string } }>('/api/conversations/:id/profile/notes', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    try {
      return { ok: true, note: operations.addProfileNote(conversation, actorOf(request), request.body?.text) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/api/me', async (request) => ({ actor: actorOf(request) }));

  app.get('/api/operators', async (request, reply) => {
    if (!operations.can(actorOf(request), 'operators:manage')) return reply.code(403).send({ error: 'Недостаточно прав' });
    return { operators: operations.listOperators() };
  });

  app.post<{ Body: { name?: string; role?: string } }>('/api/operators', async (request, reply) => {
    try {
      // Токен возвращается только этим ответом; повторно получить его нельзя.
      return { ok: true, ...operations.createOperator(request.body?.name, request.body?.role) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string }; Body: { active?: boolean; rotate?: boolean } }>('/api/operators/:id', async (request, reply) => {
    const id = Number(request.params.id);
    try {
      if (request.body?.rotate) return { ok: true, token: operations.rotateOperator(id) };
      if (typeof request.body?.active !== 'boolean') return reply.code(400).send({ error: 'Нужно active или rotate' });
      if (!operations.setOperatorActive(id, request.body.active)) return reply.code(404).send({ error: 'Оператор не найден' });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/api/audit', async (request, reply) => {
    if (!operations.can(actorOf(request), 'audit:read')) return reply.code(403).send({ error: 'Недостаточно прав' });
    return { events: operations.listAudit(Number(request.query.limit ?? 200)) };
  });

  app.get<{ Querystring: { q?: string } }>('/api/search', async (request) => operations.search(request.query.q));

  app.get('/api/queue', async () => ({ conversations: operations.queue(), policies: operations.slaPolicies() }));
  app.get('/api/sla', async () => ({ policies: operations.slaPolicies() }));
  app.put<{ Params: { priority: string }; Body: { firstResponseMinutes?: number; resolutionMinutes?: number } }>('/api/sla/:priority', async (request, reply) => {
    try {
      operations.updateSla(request.params.priority, Number(request.body?.firstResponseMinutes), Number(request.body?.resolutionMinutes));
      return { ok: true, policies: operations.slaPolicies() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/api/filters', async (request) => ({ filters: operations.savedFilters(actorOf(request)) }));
  app.post<{ Body: { name?: string; query?: unknown } }>('/api/filters', async (request, reply) => {
    try {
      operations.saveFilter(actorOf(request), request.body?.name, request.body?.query);
      return { ok: true, filters: operations.savedFilters(actorOf(request)) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  app.delete<{ Params: { id: string } }>('/api/filters/:id', async (request) => ({ ok: operations.deleteFilter(actorOf(request), Number(request.params.id)) }));

  app.get('/api/diagnostics', async () => ({
    application: { version, uptime: process.uptime(), memory: process.memoryUsage() },
    database: operations.diagnostics(),
    channels: { tg_dm: outbox.has('tg_dm'), tg_bot: outbox.has('tg_bot'), bedolaga: outbox.has('bedolaga') },
    integrations: {
      telegram: Boolean(bot), bedolaga: Boolean(bedolaga), remnawave: Boolean(remnawave), customers: Boolean(customers), nodes: Boolean(nodes),
    },
    cursors: { bedolaga: store.getState('bedolaga:last_poll') ?? null },
    kb: store.kbCount(),
  }));

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
      const cleanShortcut = shortcut.trim();
      const cleanTitle = title.trim();
      if (!cleanShortcut || cleanShortcut.length > 40 || /[\u0000-\u001f\u007f]/u.test(cleanShortcut)) {
        return reply.code(400).send({ error: 'Shortcut должен содержать 1–40 печатных символов' });
      }
      if (!cleanTitle || cleanTitle.length > 160) {
        return reply.code(400).send({ error: 'Заголовок шаблона должен содержать 1–160 символов' });
      }
      if (body.length > 20_000) {
        return reply.code(400).send({ error: 'Текст шаблона слишком большой' });
      }
      store.upsertTemplate(cleanShortcut, cleanTitle, body);
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

  app.post('/api/stats/reset', async () => {
    const resetAt = store.resetStats();
    return { ok: true, resetAt };
  });

  app.get<{ Params: { id: string } }>('/api/attachments/:id', async (request, reply) => {
    const attachment = store.getAttachment(Number(request.params.id));
    if (!attachment?.local_path) return reply.code(404).send({ error: 'Вложение ещё не скачано' });
    try {
      const handle = await openMediaFile(attachment.file_ref);
      return reply
        .header('cache-control', 'private, no-store')
        .type(MEDIA_MIME[attachment.media_type ?? ''] ?? 'application/octet-stream')
        .send(handle.createReadStream({ autoClose: true }));
    } catch {
      // Путь и file_ref могут содержать чувствительные данные, поэтому в
      // ответ и журнал их не выводим. Повреждённая запись выглядит как 404.
      log.warn(`Вложение ${attachment.id}: файл отсутствует или небезопасен`);
      return reply.code(404).send({ error: 'Файл вложения недоступен' });
    }
  });

  app.get('/api/health', async () => ({
    ok: true,
    kb: store.kbCount(),
    businessConnection: Boolean(store.activeBusinessConnectionId() ?? store.anyBusinessConnectionId()),
    lastBedolagaPoll: store.getState('bedolaga:last_poll') ?? null,
  }));

  // --- подписка клиента --------------------------------------------------

  /**
   * Идентификатор в Remnawave ищется тем же путём, что и карточка клиента:
   * поле в данных бедолаги, затем поиск по telegram id и нику, включая
   * свободное описание. Отдельная упрощённая логика здесь уже приводила
   * к «нет идентификатора» на клиентах, которые в панели есть.
   */
  const resolveTarget = async (conversation: Conversation): Promise<{
    ref?: string;
    client?: RemnawaveClient;
    panel?: { id: string; name: string; client: RemnawaveClient; readOnly: boolean };
  }> => {
    if (!customers) return {};
    const profile = await customers.get(conversation).catch(() => null);
    const linked = new Set(store.conversationSourceIds(conversation.id));
    const match = profile?.remnawaveRefs?.find((candidate) => linked.has(candidate.sourceId))
      ?? profile?.remnawaveRefs?.[0];
    const panel = remnawaves.find((candidate) => candidate.id === match?.sourceId)
      ?? remnawaves.find((candidate) => linked.has(candidate.id))
      ?? remnawaves[0];
    return { ref: match?.ref ?? profile?.remnawaveRef, client: panel?.client ?? remnawave, panel };
  };

  /** Разбор связки с Remnawave: показывает, что искали и что нашли. */
  app.get<{ Params: { id: string } }>('/api/conversations/:id/subscription/explain', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    const profile = customers ? await customers.build(conversation).catch(() => null) : null;
    const target = await resolveTarget(conversation);
    if (!target.client) return reply.code(501).send({ error: 'Панель Remnawave не подключена' });
    return target.client.explain(
      profile?.identity?.telegramId ?? conversation.tg_user_id ?? undefined,
      profile?.identity?.username ?? conversation.username ?? undefined,
    );
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/subscription', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    const target = await resolveTarget(conversation);
    if (!target.client) return reply.code(501).send({ error: 'Панель Remnawave не подключена' });
    const ref = target.ref;
    if (!ref) {
      return reply.code(404).send({
        error: `Клиент не найден в Remnawave ни по telegram id, ни по нику. Проверьте, что он есть в панели — при необходимости впишите ${conversation.tg_user_id ?? 'telegram id'} в поле «Описание» его записи.`,
      });
    }

    const profile = await target.client.profile(ref);
    const devices = await target.client.devices(ref);
    return {
      ref,
      panel: target.panel ? { id: target.panel.id, name: target.panel.name } : null,
      profile: profile ?? null,
      devices: devices ?? null,
      capabilities: target.client.capabilities(),
    };
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
      const target = await resolveTarget(conversation);
      if (!target.client) return reply.code(501).send({ error: 'Панель Remnawave не подключена' });
      const ref = target.ref;
      if (!ref) return reply.code(404).send({ error: 'Клиент не найден в Remnawave' });

      const { action, hwid } = request.body ?? {};
      let ok = false;
      if (action === 'reset-devices') ok = await target.client.resetDevices(ref);
      else if (action === 'revoke') ok = await target.client.revoke(ref);
      else if (action === 'delete-device' && hwid) ok = await target.client.deleteDevice(ref, hwid);
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
      return { ok: true, ms: Date.now() - started, model: provider.lastModel, keys: provider.keyState() };
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
    return { ...snap, nodes: snap.nodes.map((n) => ({
      ...n,
      alias: aliases[n.aliasKey ?? n.rawName] ?? aliases[n.rawName] ?? null,
    })) };
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
    channels: { tg_dm: outbox.has('tg_dm'), tg_bot: outbox.has('tg_bot'), bedolaga: outbox.has('bedolaga') },
    remnawave: remnawave ? { ...remnawave.capabilities(), index: remnawave.indexState() } : null,
    remnawaves: remnawaves.map((panel) => ({
      id: panel.id,
      name: panel.name,
      readOnly: panel.readOnly,
      ...panel.client.capabilities(),
      index: panel.client.indexState(),
    })),
    sources: store.sourceAccounts().map(({ id, kind, name, enabled }) => ({ id, kind, name, enabled: Boolean(enabled) })),
    folders: store.folders(),
    serviceProfiles: store.serviceProfiles(),
    sourceManagement: await sources.state(),
    businessConnections: store.businessConnections().map((connection) => ({
      id: connection.id,
      name: connection.display_name,
      username: connection.username,
      enabled: Boolean(connection.is_enabled),
    })),
    alerts: notifier?.state() ?? null,
    nodes: nodes ? { known: nodes.get().nodes.length, at: nodes.get().at } : null,
    readOnly: config.remnawave.readOnly,
    ai: { keys: config.ai.apiKeys.length, model: runtime.model, fallback: runtime.fallbackModel || null },
    kb: store.kbCount(),
    businessConnection: Boolean(store.activeBusinessConnectionId() ?? store.anyBusinessConnectionId()),
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

  app.post<{
    Params: { id: string };
    Body: { serviceName?: unknown; greetingMessage?: unknown; handoffMessage?: unknown };
  }>('/api/settings/services/:id', async (request, reply) => {
    try {
      const profile = store.saveServiceProfile(request.params.id, request.body ?? {});
      store.logEvent('service_profile_updated', null, {
        sourceId: profile.sourceId,
        serviceName: profile.serviceName,
      });
      return { ok: true, profile, serviceProfiles: store.serviceProfiles() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/api/sources/status', async () => sources.state());

  app.post<{ Body: Record<string, unknown> }>('/api/sources/request', async (request, reply) => {
    try {
      const state = await sources.request(request.body ?? {}, store.sourceAccounts().map((source) => source.id));
      store.logEvent('source_add_requested', null, {
        kind: request.body?.['kind'], id: state.progress?.id, name: state.progress?.name,
      });
      return { ok: true, sourceManagement: state };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get<{ Querystring: { force?: string } }>('/api/update', async (request) => ({
    ...await updates.state(request.query?.force === '1'),
    history: operations.updateHistory(),
  }));

  app.post<{ Body: { action?: string; force?: boolean } }>('/api/update/request', async (request, reply) => {
    const actor = actorOf(request);
    const action = request.body?.action === 'rollback' ? 'rollback' : 'update';
    try {
      const update = await updates.request(action, { force: request.body?.force === true });
      operations.recordUpdate(action, action === 'update' ? update.latest : update.current, 'queued', actor, {
        safety: update.compatibility,
      });
      return { ok: true, update: { ...update, history: operations.updateHistory() } };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Очередь обучения отделена от опубликованной базы. Диалоги создают
  // кандидатов; в рабочую KB они попадают только после решения lead/admin.
  app.get<{ Querystring: { status?: string } }>('/api/learning/candidates', async (request) => ({
    candidates: operations.candidates(request.query.status ?? 'pending'),
  }));

  app.post<{ Params: { id: string }; Body: { decision?: string } }>('/api/learning/candidates/:id', async (request, reply) => {
    const actor = actorOf(request);
    if (!operations.can(actor, 'knowledge:review')) return reply.code(403).send({ error: 'Недостаточно прав' });
    const candidate = operations.candidate(Number(request.params.id));
    if (!candidate) return reply.code(404).send({ error: 'Кандидат не найден' });
    if (candidate.status !== 'pending') return reply.code(409).send({ error: 'Кандидат уже рассмотрен' });
    const decision = request.body?.decision;
    if (decision !== 'approved' && decision !== 'rejected') return reply.code(400).send({ error: 'Нужно approved или rejected' });
    try {
      if (decision === 'approved') {
        await publishDraft(String(candidate.file_name));
        onKbChanged?.();
      }
      if (!operations.decideCandidate(Number(request.params.id), decision, actor)) {
        return reply.code(409).send({ error: 'Кандидат уже рассмотрен' });
      }
      return { ok: true, candidates: operations.candidates('pending') };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
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
          if (!report.dryRun && report.articles.length) operations.registerCandidates(report.articles, 'telegram-export');
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
          if (!report.dryRun && report.articles.length) operations.registerCandidates(report.articles, String(options.source ?? 'archive'));
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

  app.get('/ws', { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (origin) {
      let validOrigin = false;
      try {
        const parsed = new URL(origin);
        validOrigin = parsed.host === request.headers.host && parsed.protocol === `${request.protocol}:`;
      } catch {
        validOrigin = false;
      }
      if (!validOrigin) {
        socket.close(1008, 'Origin rejected');
        return;
      }
    }

    const ipCount = socketIps.get(request.ip) ?? 0;
    if (sockets.size >= 200 || ipCount >= 8) {
      socket.close(1013, 'Too many connections');
      return;
    }
    sockets.add(socket);
    socketOwners.set(socket, request.ip);
    socketIps.set(request.ip, ipCount + 1);
    socket.once('close', () => removeSocket(socket));
  });

  // Nginx и мобильные сети могут закрывать тихое WebSocket-соединение.
  // Ping держит канал живым; клиент всё равно имеет короткий HTTP fallback.
  const socketHeartbeat = setInterval(() => {
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.ping();
      else removeSocket(socket);
    }
  }, 25_000);
  socketHeartbeat.unref();
  app.addHook('onClose', async () => {
    clearInterval(socketHeartbeat);
    for (const socket of sockets) socket.close();
    sockets.clear();
    socketIps.clear();
  });

  store.on('message', ({ conversation, message }) =>
    broadcast({
      type: 'message',
      conversation: decorate(conversation, store, operations),
      message,
      attachments: store.attachmentsFor([message.id]),
    }),
  );
  store.on('conversation', (conversation) =>
    broadcast({ type: 'conversation', conversation: decorate(conversation, store, operations) }),
  );
  store.on('suggestion', ({ conversation, suggestion }) =>
    broadcast({ type: 'suggestion', conversation: decorate(conversation, store, operations), suggestion }),
  );

  await app.listen({ port: config.panelPort, host: config.panelHost });
  log.info(`Панель слушает http://${config.panelHost}:${config.panelPort}`);
  return app;
}
