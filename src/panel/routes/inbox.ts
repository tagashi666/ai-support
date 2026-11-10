import type { FastifyInstance } from 'fastify';
import { config, version } from '../../config.js';
import { runtime } from '../../core/settings.js';
import { pauseState } from '../../core/pause.js';
import { pauseView } from '../assistant.js';
import type { BootstrapResponse, EventsResponse, InboxResponse, InboxView } from '../../shared/api-types.js';
import { SECTION_ORDER } from '../../shared/conversation-order.js';
import type { Section } from '../../shared/attention.js';
import type { RouteContext } from '../context.js';
import { channelAvailability } from '../helpers.js';
import { countsFor, listInbox, openProjections, type InboxQuery } from '../inbox.js';
import { frameFor } from '../live.js';
import { systemProblems } from '../problems.js';
import { apiError } from '../errors.js';

const VIEWS: readonly InboxView[] = ['waiting', 'open', 'resolved'];
const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

type InboxQuerystring = Partial<Record<'view' | 'section' | 'source' | 'folder' | 'assignee' | 'only' | 'q' | 'limit' | 'cursor', string>>;

/** Разбор параметров списка; строка — текст ошибки 400. */
function parseInboxQuery(raw: InboxQuerystring): InboxQuery | string {
  const view = (raw.view ?? 'open') as InboxView;
  if (!VIEWS.includes(view)) return 'Неизвестный вид списка';
  const section = raw.section as Section | undefined;
  if (section !== undefined && !SECTION_ORDER.includes(section)) return 'Неизвестная секция';
  const limit = raw.limit === undefined ? LIMIT_DEFAULT : Number(raw.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) return `limit — целое от 1 до ${LIMIT_MAX}`;
  const folder = raw.folder === undefined ? undefined : Number(raw.folder);
  if (folder !== undefined && (!Number.isSafeInteger(folder) || folder <= 0)) return 'Некорректная папка';
  if (raw.only !== undefined && raw.only !== 'important' && raw.only !== 'not_found') return 'only — important или not_found';
  if (raw.assignee !== undefined && !/^(?:me|none|root|op:\d{1,12})$/.test(raw.assignee)) return 'Некорректный ответственный';
  if (raw.cursor !== undefined && !/^[0-4]\|[01]\|\d{13}\|\d{13}$/.test(raw.cursor)) return 'Некорректный курсор';
  const q = raw.q?.trim().slice(0, 200);
  return {
    view,
    ...(section ? { section } : {}),
    ...(raw.source ? { source: raw.source.slice(0, 200) } : {}),
    ...(folder !== undefined ? { folder } : {}),
    ...(raw.assignee ? { assignee: raw.assignee } : {}),
    ...(raw.only ? { only: raw.only as 'important' | 'not_found' } : {}),
    ...(q ? { q } : {}),
    limit,
    ...(raw.cursor ? { cursor: raw.cursor } : {}),
  };
}

/** Новая панель: список по рангу сервера, догон событий, лёгкий старт. */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store, outbox, operations, updates, actorOf, live, bedolaga, minishop, remnawave, remnawaves, nodes } = ctx;

  app.get<{ Querystring: InboxQuerystring }>('/api/inbox', async (request, reply): Promise<InboxResponse | void> => {
    const query = parseInboxQuery(request.query ?? {});
    if (typeof query === 'string') return reply.code(400).send(apiError('bad_request', query));
    // Снимок и номер кадра берутся в одном синхронном проходе: кадры с seq
    // больше этого применяются поверх снимка, остальные в нём уже учтены.
    const seq = live.events.seq;
    const page = listInbox(store.db, query, actorOf(request).key);
    return { ...page, seq, epoch: live.events.epoch };
  });

  app.get<{ Querystring: { since?: string; epoch?: string } }>('/api/events', async (request, reply): Promise<EventsResponse | void> => {
    const since = Number(request.query?.since);
    if (request.query?.since === undefined || !Number.isSafeInteger(since) || since < 0) {
      return reply.code(400).send(apiError('bad_request', 'Нужен параметр since'));
    }
    const { events } = live;
    const entries = events.since(since, String(request.query?.epoch ?? ''));
    if (!entries) return { reset: true, epoch: events.epoch, seq: events.seq };
    const viewer = actorOf(request).key;
    return {
      epoch: events.epoch,
      seq: events.seq,
      events: entries.map((entry) => frameFor(entry, events.epoch, viewer)),
      counts: countsFor(live.watcher.projections(), viewer),
    };
  });

  // Без сетевых вызовов: GET /api/settings спрашивает Telegram о бизнес-подключении.
  app.get('/api/bootstrap', async (request): Promise<BootstrapResponse> => {
    const actor = actorOf(request);
    const counts = countsFor(openProjections(store.db), actor.key);
    const aiKeys = config.ai.apiKeys.length > 0;
    const canUpdate = operations.can(actor, 'settings:update');
    const cached = canUpdate ? updates.cachedAvailability() : null;
    const canDiagnose = operations.can(actor, 'diagnostics:read');
    const problems = canDiagnose ? systemProblems(ctx) : [];
    return {
      me: { id: actor.key, name: actor.name, role: actor.role, permissions: operations.permissionsFor(actor) },
      version,
      capabilities: {
        nodes: Boolean(nodes),
        update: config.update.enabled,
        bedolaga: Boolean(bedolaga),
        minishop: Boolean(minishop),
        remnawave: Boolean(remnawave) || remnawaves.length > 0,
        aiKeys,
        inbox: true,
        events: true,
        typingWithoutClaim: true,
      },
      assistant: { mode: runtime.aiMode, minConfidence: runtime.minConfidence, keys: aiKeys, pause: pauseView(pauseState()) },
      channels: channelAvailability(outbox),
      sources: store.sourceAccounts().map(({ id, kind, name, enabled }) => ({ id, kind, name, enabled: Boolean(enabled) })),
      folders: store.folders(),
      counts: {
        mine: counts.sections.mine,
        waiting: counts.waiting,
        ideas: operations.can(actor, 'knowledge:review') ? operations.candidates('pending').length : null,
        problems: canDiagnose ? problems.length : null,
      },
      problems: canDiagnose ? problems : null,
      update: canUpdate ? { available: cached?.available ?? false, latest: cached?.latest ?? null } : null,
      live: { seq: live.events.seq, epoch: live.events.epoch },
    };
  });
}
