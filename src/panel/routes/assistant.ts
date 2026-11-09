import type { FastifyInstance } from 'fastify';
import { runtime } from '../../core/settings.js';
import { clearPause, pauseState, setPause, validPauseUntil } from '../../core/pause.js';
import type { ActivityResponse, AssistantPauseResponse, FeedbackReason, FeedbackResponse } from '../../shared/api-types.js';
import { ACTIVITY_LIMIT_MAX, listActivity, pauseView } from '../assistant.js';
import type { RouteContext } from '../context.js';
import { apiError } from '../errors.js';

const DAY_MS = 24 * 60 * 60_000;
const FEEDBACK_REASONS: readonly FeedbackReason[] = ['fact', 'tone', 'topic', 'no_kb'];

/**
 * Помощник в новой панели (план редизайна, 10.4): пауза везде, лента
 * «Что делал помощник», отметка «Это неверно». Только добавки: старые
 * маршруты и поведение классики не меняются.
 */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store, operations, actorOf, live } = ctx;

  const announce = (actor: { key: string; name: string }): void => {
    live.settingsChanged(['aiPause'], {
      aiMode: runtime.aiMode, minConfidence: runtime.minConfidence,
      actor: { id: actor.key, name: actor.name }, pause: pauseView(pauseState()),
    });
  };

  // Право — как у режима (setting:aiMode): пауза меняет то, что получают клиенты.
  app.post<{ Body: { until?: unknown } }>('/api/assistant/pause', async (request, reply): Promise<AssistantPauseResponse | void> => {
    const actor = actorOf(request);
    if (!operations.can(actor, 'setting:aiMode')) {
      return reply.code(403).send(apiError('permission', 'Ставить помощника на паузу может тот, кто меняет его режим'));
    }
    const body = request.body ?? {};
    if (!('until' in body)) return reply.code(400).send(apiError('bad_request', 'Нужно поле until: время конца паузы или null'));
    const until = validPauseUntil(body.until);
    if (until === undefined) return reply.code(400).send(apiError('bad_request', 'Конец паузы — в будущем и не дальше месяца'));
    const pause = setPause(store, until, actor);
    store.logEvent('ai_paused', null, { until, by: actor.key });
    announce(actor);
    return { ok: true, pause: pauseView(pause) };
  });

  app.delete('/api/assistant/pause', async (request, reply): Promise<AssistantPauseResponse | void> => {
    const actor = actorOf(request);
    if (!operations.can(actor, 'setting:aiMode')) {
      return reply.code(403).send(apiError('permission', 'Снимать паузу помощника может тот, кто меняет его режим'));
    }
    if (clearPause(store)) store.logEvent('ai_resumed', null, { by: actor.key });
    announce(actor);
    return { ok: true, pause: null };
  });

  app.get<{ Querystring: { since?: string; before?: string; limit?: string } }>(
    '/api/assistant/activity',
    async (request, reply): Promise<ActivityResponse | void> => {
      const now = Date.now();
      const raw = request.query ?? {};
      const since = raw.since === undefined ? now - DAY_MS : Number(raw.since);
      if (!Number.isSafeInteger(since) || since < 0) return reply.code(400).send(apiError('bad_request', 'since — время в мс'));
      const before = raw.before === undefined ? undefined : Number(raw.before);
      if (before !== undefined && (!Number.isSafeInteger(before) || before <= since)) {
        return reply.code(400).send(apiError('bad_request', 'before — время в мс позже since'));
      }
      const limit = raw.limit === undefined ? 50 : Number(raw.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > ACTIVITY_LIMIT_MAX) {
        return reply.code(400).send(apiError('bad_request', `limit — целое от 1 до ${ACTIVITY_LIMIT_MAX}`));
      }
      return listActivity(store.db, { since, limit, ...(before !== undefined ? { before } : {}) }, now);
    },
  );

  // «Это неверно» на ответе помощника (10.4 п.6). Отметка — в журнале event:
  // по ней лента и итоги показывают, где помощник ошибся.
  app.post<{ Params: { id: string }; Body: { verdict?: unknown; reason?: unknown; note?: unknown } }>(
    '/api/messages/:id/feedback',
    async (request, reply): Promise<FeedbackResponse | void> => {
      const id = Number(request.params.id);
      const body = request.body ?? {};
      if (body.verdict !== 'wrong') return reply.code(400).send(apiError('bad_request', 'verdict — только wrong'));
      const reason = body.reason === undefined || body.reason === null ? null : body.reason;
      if (reason !== null && !FEEDBACK_REASONS.includes(reason as FeedbackReason)) {
        return reply.code(400).send(apiError('bad_request', 'Причина — fact, tone, topic или no_kb'));
      }
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
      const message = store.db.prepare(`SELECT id, conversation_id, direction, author, suggestion_id FROM message WHERE id = ?`)
        .get(id) as { id: number; conversation_id: number; direction: string; author: string; suggestion_id: number | null } | undefined;
      if (!message) return reply.code(404).send(apiError('not_found', 'Сообщение не найдено'));
      if (message.direction !== 'out' || message.author !== 'ai') {
        return reply.code(400).send(apiError('bad_request', 'Отметить можно только ответ помощника'));
      }
      const actor = actorOf(request);
      store.logEvent('ai_feedback', message.conversation_id, {
        message: message.id, suggestion: message.suggestion_id, verdict: 'wrong', reason, ...(note ? { note } : {}), by: actor.key,
      });
      return { ok: true, message_id: message.id };
    },
  );
}
