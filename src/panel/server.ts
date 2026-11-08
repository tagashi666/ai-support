import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fastifyCompress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import { constants as zlibConstants } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { config, log } from '../config.js';
import { UpdateManager } from '../core/update.js';
import { SourceManager } from '../core/sources.js';
import { Operations, type Actor, type Permission } from '../core/operations.js';
import { decorate, registerStatusSyncs } from './helpers.js';
import { createRouteContext, type WebDeps } from './context.js';
import { register as registerConversations } from './routes/conversations.js';
import { register as registerMedia } from './routes/media.js';
import { register as registerReplies } from './routes/replies.js';
import { register as registerCustomers } from './routes/customers.js';
import { register as registerTeam } from './routes/team.js';
import { register as registerQueue } from './routes/queue.js';
import { register as registerSystem } from './routes/system.js';
import { register as registerSuggestions } from './routes/suggestions.js';
import { register as registerAi } from './routes/ai.js';
import { register as registerSettings } from './routes/settings.js';
import { register as registerNodes } from './routes/nodes.js';
import { register as registerKnowledge } from './routes/knowledge.js';
import { register as registerInterfaceKb } from './routes/interface-kb.js';

const here = dirname(fileURLToPath(import.meta.url));
// Панель лежит в корне проекта, а этот файл — в src/panel и dist/panel.
// Поднимаемся на два уровня, чтобы путь не зависел от глубины вложенности.
const publicDir = join(here, '..', '..', 'public');
const lottiePlayer = readFileSync(join(here, '..', '..', 'node_modules', 'lottie-web', 'build', 'player', 'lottie_light.min.js'));

const inlineScripts = Array.from(
  readFileSync(join(publicDir, 'index.html'), 'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),
);
if (inlineScripts.length !== 1 || inlineScripts[0]?.[1] === undefined) {
  throw new Error('Для строгой CSP в public/index.html должен быть ровно один встроенный script');
}
const PANEL_SCRIPT_HASH = `'sha256-${createHash('sha256').update(inlineScripts[0][1]).digest('base64')}'`;

/**
 * Стили панели отдаются с версией в URL и кэшируются навсегда, а сама
 * страница — с ETag и обязательной перепроверкой: после обновления браузер
 * получит новую разметку одним 304/200 и сразу новые стили по новой версии.
 */
const contentVersion = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('base64url').slice(0, 16);
const panelStyles = new Map<string, { body: Buffer; version: string }>();
const panelHtml = Buffer.from(readFileSync(join(publicDir, 'index.html'), 'utf8')
  .replace(/(<link\b[^>]*\bhref=")\/([A-Za-z0-9._-]+\.css)(")/g, (_match, head: string, name: string, tail: string) => {
    const body = readFileSync(join(publicDir, name));
    const version = contentVersion(body);
    panelStyles.set(name, { body, version });
    return `${head}/${name}?v=${version}${tail}`;
  }));
const PANEL_HTML_ETAG = `W/"${contentVersion(panelHtml)}"`;

/** Совпадает ли ETag из If-None-Match; слабые и сильные варианты считаем равными. */
function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) return false;
  const bare = etag.replace(/^W\//, '');
  return value.split(',').some((item) => {
    const candidate = item.trim();
    return candidate === '*' || candidate.replace(/^W\//, '') === bare;
  });
}

const MEDIA_COOKIE = 'ais_media';
const TICKET_TTL_MS = 10 * 60_000;

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

export type { WebDeps } from './context.js';

export async function startWeb(deps: WebDeps) {
  const { store, outbox, bedolaga, minishop } = deps;
  // Доверяем заголовку X-Forwarded-For только от локального nginx: без этого
  // все запросы выглядят как 127.0.0.1, и блокировка за подбор токена заперла
  // бы оператора вместе с атакующим. Доверять произвольным адресам нельзя —
  // подделать заголовок может кто угодно.
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, trustProxy: 'loopback' });
  // JSON остаётся под маленьким глобальным лимитом. Только этот media type
  // передаётся обработчику потоком и имеет собственный жёсткий предел 45 МБ.
  app.addContentTypeParser('application/vnd.ai-support.attachment', (_request, payload, done) => done(null, payload));
  const updates = new UpdateManager();
  const sources = new SourceManager();
  const operations = new Operations(store);
  // Статус тикета во внешних каналах меняется через Outbox, до локальной записи.
  registerStatusSyncs(outbox, { bedolaga, minishop });
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
      "default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
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
    // Присутствие, удержание и прочтение — фоновые heartbeat'ы панели, а не
    // действия оператора: раньше они забивали журнал почти целиком.
    if (/^\/api\/conversations\/\d+\/(?:presence|engage|read)$/.test(path)) return;
    const parts = path.split('/').filter(Boolean);
    operations.audit(actor, `${request.method} ${path}`, parts[1] ?? 'api', parts[2],
      path.endsWith('/attachments') ? undefined : request.body, request.ip);
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
  // Сжимаем только текст (HTML, CSS, JSON, JS): картинки и видео уже сжаты, а
  // их типы mime-db помечает несжимаемыми. Brotli на умеренном уровне —
  // максимальный ощутимо грузит процессор на каждом JSON-ответе.
  await app.register(fastifyCompress, {
    global: true,
    encodings: ['br', 'gzip'],
    threshold: 1024,
    brotliOptions: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } },
  });
  // Прочая статика без версии в имени: браузер хранит копию, но каждый раз
  // перепроверяет её по ETag. Главная страница и стили отдаются ниже.
  await app.register(fastifyStatic, {
    root: publicDir,
    index: false,
    cacheControl: false,
    setHeaders: (res) => { res.header('cache-control', 'no-cache'); },
  });

  const sendPanel = (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('etag', PANEL_HTML_ETAG).header('cache-control', 'no-cache');
    if (etagMatches(request.headers['if-none-match'], PANEL_HTML_ETAG)) return reply.code(304).send();
    return reply.type('text/html; charset=utf-8').send(panelHtml);
  };
  app.get('/', async (request, reply) => sendPanel(request, reply));
  app.get('/index.html', async (request, reply) => sendPanel(request, reply));
  for (const [name, style] of panelStyles) {
    const etag = `W/"${style.version}"`;
    app.get<{ Querystring: { v?: string } }>(`/${name}`, async (request, reply) => {
      reply.header('etag', etag)
        .header('cache-control', request.query.v === style.version ? 'public, max-age=31536000, immutable' : 'no-cache');
      if (etagMatches(request.headers['if-none-match'], etag)) return reply.code(304).send();
      return reply.type('text/css; charset=utf-8').send(style.body);
    });
  }

  app.get('/vendor/lottie.min.js', async (_request, reply) => reply
    .header('cache-control', 'public, max-age=31536000, immutable')
    .type('application/javascript; charset=utf-8')
    .send(lottiePlayer));

  const sockets = new Set<WebSocket>();
  const socketIps = new Map<string, number>();
  const socketOwners = new WeakMap<WebSocket, string>();
  const socketActors = new WeakMap<WebSocket, string>();
  const socketExpires = new WeakMap<WebSocket, number>();
  const removeSocket = (socket: WebSocket): void => {
    if (!sockets.delete(socket)) return;
    const ip = socketOwners.get(socket);
    if (!ip) return;
    const count = socketIps.get(ip) ?? 0;
    if (count <= 1) socketIps.delete(ip);
    else socketIps.set(ip, count - 1);
  };
  const broadcast = (frame: unknown, permission: Permission = 'conversation:read'): void => {
    const payload = JSON.stringify(frame);
    for (const socket of sockets) {
      const actor = operations.actorByKey(socketActors.get(socket) ?? '');
      if (!actor || !operations.can(actor, 'conversation:read')) {
        socket.close(1008, 'Permission revoked');
        continue;
      }
      // События фоновых задач видят только роли с соответствующим правом,
      // но отсутствие этого дополнительного права не должно ронять сокет.
      if (!operations.can(actor, permission)) continue;
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  };

  const expected = Buffer.from(config.panelToken);
  // Сравнение за постоянное время: обычное === утекает длину общего префикса.

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
  const makeTicket = (actor: Actor): string => {
    const until = Date.now() + TICKET_TTL_MS;
    const actorKey = Buffer.from(actor.key).toString('base64url');
    const mac = createHmac('sha256', ticketSecret).update(`${until}.${actorKey}`).digest('base64url').slice(0, 32);
    return `${until}.${actorKey}.${mac}`;
  };
  const ticketGrant = (value: unknown): { actor: Actor; until: number } | null => {
    if (typeof value !== 'string') return null;
    const [untilRaw, actorRaw, mac] = value.split('.');
    const until = Number(untilRaw);
    if (!Number.isFinite(until) || until < Date.now() || !actorRaw || !mac) return null;
    const expected = createHmac('sha256', ticketSecret).update(`${until}.${actorRaw}`).digest('base64url').slice(0, 32);
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    let key: string;
    try { key = Buffer.from(actorRaw, 'base64url').toString('utf8'); }
    catch { return null; }
    const actor = operations.actorByKey(key);
    if (!actor || !operations.can(actor, 'conversation:read')) return null;
    return { actor, until };
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

  // Чтение, доступное любому оператору с conversation:read. Раньше это было
  // правилом по умолчанию для всех GET, а любой неописанный POST получал
  // conversation:status — новый маршрут молча открывался агенту.
  const CONVERSATION_READ_ROUTES = /^\/api\/(?:conversations(?:\/\d+(?:\/(?:avatar|customer|profile))?)?|inbox\/meta|me|search|attachments\/\d+(?:\/lottie)?|health|ticket)(?:\?|$)/;

  const permissionFor = (method: string, url: string): Permission | undefined => {
    if (url.startsWith('/api/roles')) return 'roles:manage';
    if (url.startsWith('/api/operators')) return method === 'GET' ? 'team:read' : 'operators:manage';
    if (url.startsWith('/api/operator-stats')) return 'operator_stats:read';
    if (method === 'POST' && /^\/api\/attachments\/\d+\/retry(?:\?|$)/.test(url)) return 'conversation:read';
    if (url.startsWith('/api/audit')) return 'audit:read';
    if (url.startsWith('/api/diagnostics')) return 'diagnostics:read';
    if (url.startsWith('/api/update')) return 'settings:update';
    if (url.startsWith('/api/sources')) return 'settings:sources';
    if (url.startsWith('/api/learning')) return 'knowledge:review';
    if (url.startsWith('/api/ai/keys') || url.startsWith('/api/ai/models') || url.startsWith('/api/ai/ping')) {
      return 'settings:ai_tools';
    }
    if (url.startsWith('/api/ai/try')) return 'settings:ai_tools';
    if (url.startsWith('/api/stats/reset')) return 'stats:reset';
    if (url.startsWith('/api/stats')) return 'stats:read';
    if (url.startsWith('/api/inbox/folders') && method !== 'GET') return 'settings:sources';
    if (url.startsWith('/api/sla') && method !== 'GET') return 'queue:manage';
    if (url.startsWith('/api/queue') || url.startsWith('/api/sla')) return 'queue:read';
    if (url.startsWith('/api/filters')) return 'queue:read';
    if (url.startsWith('/api/templates') && method !== 'GET') return 'templates:manage';
    if (url.startsWith('/api/templates')) return 'templates:read';
    if (url.startsWith('/api/suggestions')) return 'conversation:reply';
    if (url.startsWith('/api/interface-kb')) return method === 'GET' || method === 'HEAD' ? 'knowledge:read' : 'knowledge:manage';
    if (url.startsWith('/api/kb/mine')) return 'knowledge:mine';
    if (method === 'GET' && /^\/api\/kb\/draft(?:\/|\?|$)/.test(url)) return 'knowledge:review';
    if (url.startsWith('/api/kb') && method !== 'GET') return 'knowledge:manage';
    if (url.startsWith('/api/kb')) return 'knowledge:read';
    if (/^\/api\/conversations\/\d+\/bedolaga\/subscriptions\/\d+\/extend(?:\?|$)/.test(url)) {
      return 'bedolaga:extend';
    }
    if (/^\/api\/conversations\/\d+\/bedolaga\/customer(?:\?|$)/.test(url)) {
      return 'bedolaga:view';
    }
    if (url.includes('/subscription/action')) return 'bedolaga:devices';
    if (url.includes('/subscription')) return 'bedolaga:view';
    if (/\/conversations\/\d+\/attachments(?:\?|$)/.test(url)) return 'conversation:attachments';
    if (/\/conversations\/\d+\/reply(?:\?|$)/.test(url)) return 'conversation:reply';
    if (/\/conversations\/\d+\/(?:note|profile\/notes)(?:\?|$)/.test(url)) return 'conversation:notes';
    if (/\/conversations\/\d+\/(?:read|presence)(?:\?|$)/.test(url)) return 'conversation:read';
    if (/\/conversations\/\d+\/customer\/refresh(?:\?|$)/.test(url)) return 'conversation:profile';
    if (/\/conversations\/\d+\/profile(?:\?|$)/.test(url) && method !== 'GET') return 'conversation:profile';
    if (/\/conversations\/\d+\/(?:state|engage|release)(?:\?|$)/.test(url)) return 'conversation:status';
    if (url.startsWith('/api/settings/services/')) return 'settings:services';
    if (url.startsWith('/api/settings/test-alert')) return 'settings:alerts';
    if (url.startsWith('/api/nodes')) return 'settings:nodes';
    if (url === '/api/settings' || url.startsWith('/api/settings?')) return 'settings:read';
    if ((method === 'GET' || method === 'HEAD') && CONVERSATION_READ_ROUTES.test(url)) return 'conversation:read';
    return undefined;
  };

  // Маршрут без правила выше доступен только тому, кто может менять роли.
  // Ошибка в эту сторону видна сразу (403 у оператора), а не через утечку.
  const DENY_BY_DEFAULT: Permission = 'roles:manage';

  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api')) return;
    const sample = route.url.replace(/:[A-Za-z]+/g, '1');
    for (const method of [route.method].flat()) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      if (!permissionFor(method, sample)) {
        log.warn(`Маршрут ${method} ${route.url} не описан в permissionFor — доступен только с правом ${DENY_BY_DEFAULT}`);
      }
    }
  });

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
    //
    // Cookie-билет (выдаётся вместе с билетом в /api/ticket) принимается ТОЛЬКО
    // на GET/HEAD медиа-маршрутах без побочных эффектов: вложения, lottie и
    // аватарка. Поэтому CSRF через него невозможен: изменяющие маршруты, API
    // и WebSocket cookie не читают. Так URL картинок не содержит меняющийся
    // токен и браузер может держать их в кэше.
    const safeMethod = request.method === 'GET' || request.method === 'HEAD';
    const mediaRoute = safeMethod && (
      /^\/api\/attachments\/\d+(?:\/lottie)?(?:\?|$)/.test(request.url)
      || /^\/api\/conversations\/\d+\/avatar(?:\?|$)/.test(request.url)
      || /^\/api\/interface-kb\/images\//.test(request.url)
    );
    const readOnlyRoute = mediaRoute || (safeMethod && /^\/ws(?:\?|$)/.test(request.url));
    if (readOnlyRoute) {
      const grant = ticketGrant(query)
        ?? (mediaRoute ? ticketGrant(cookieValue(request.headers.cookie, MEDIA_COOKIE)) : null);
      if (grant) { actors.set(request, grant.actor); return; }
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
    if (!operations.can(actor, permissionFor(request.method, request.url) ?? DENY_BY_DEFAULT)) {
      return reply.code(403).send({ error: 'Недостаточно прав для этого действия' });
    }
  });

  // Маршруты по областям. Все регистрируются после хуков авторизации выше:
  // onRoute проверяет карту прав, onRequest — токен и право на маршрут.
  const ctx = createRouteContext(deps, { operations, updates, sources, actorOf, broadcast });
  registerConversations(app, ctx);
  registerMedia(app, ctx);
  registerReplies(app, ctx);
  registerCustomers(app, ctx);
  registerTeam(app, ctx);
  registerQueue(app, ctx);
  registerSystem(app, ctx);
  registerSuggestions(app, ctx);
  registerAi(app, ctx);
  registerSettings(app, ctx);
  registerNodes(app, ctx);
  registerKnowledge(app, ctx);
  registerInterfaceKb(app, ctx);

  // --- билет для медиа и WS -----------------------------------------

  // Билет уходит и в cookie: её браузер сам приложит к <img>/<video> на
  // медиа-маршрутах, и URL картинок перестают меняться при каждой ротации.
  app.get('/api/ticket', async (request, reply) => {
    const ticket = makeTicket(actorOf(request));
    reply.header('set-cookie', `${MEDIA_COOKIE}=${ticket}; Path=/api/; Max-Age=${Math.floor(TICKET_TTL_MS / 1000)}; `
      + `HttpOnly; SameSite=Strict${request.protocol === 'https' ? '; Secure' : ''}`);
    return { ticket };
  });

  // --- живое обновление ------------------------------------------------

  app.get('/ws', { websocket: true }, (socket, request) => {
    const grant = ticketGrant((request.query as Record<string, unknown> | undefined)?.token);
    if (!grant) {
      socket.close(1008, 'Ticket expired');
      return;
    }
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
    socketActors.set(socket, grant.actor.key);
    socketExpires.set(socket, grant.until);
    socketIps.set(request.ip, ipCount + 1);
    socket.once('close', () => removeSocket(socket));
  });

  // Nginx и мобильные сети могут закрывать тихое WebSocket-соединение.
  // Ping держит канал живым; клиент всё равно имеет короткий HTTP fallback.
  const socketHeartbeat = setInterval(() => {
    for (const socket of sockets) {
      const actor = operations.actorByKey(socketActors.get(socket) ?? '');
      if ((socketExpires.get(socket) ?? 0) < Date.now()
          || !actor || !operations.can(actor, 'conversation:read')) {
        socket.close(1008, 'Ticket expired or permission revoked');
      } else if (socket.readyState === socket.OPEN) {
        socket.ping();
        // Protocol ping браузеру не виден. Кадр tick позволяет панели заметить
        // тихо умерший сокет (сон, смена сети, iOS в фоне) и переподключиться.
        socket.send(tickFrame());
      } else removeSocket(socket);
    }
  }, 20_000);
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
  store.on('message_updated', ({ conversation, message }) =>
    broadcast({
      type: 'message_updated',
      conversation: decorate(conversation, store, operations),
      message,
      attachments: store.attachmentsFor([message.id]),
    }),
  );
  store.on('message_deleted', ({ conversation, message }) =>
    broadcast({
      type: 'message_deleted',
      conversation: decorate(conversation, store, operations),
      message,
    }),
  );
  store.on('conversation_deleted', (conversation) =>
    broadcast({ type: 'conversation_deleted', conversation }),
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

const tickFrame = () => JSON.stringify({ type: 'tick', at: Date.now() });
