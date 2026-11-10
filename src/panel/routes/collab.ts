import type { FastifyInstance } from 'fastify';
import type { DraftResponse, PresenceResponse } from '../../shared/api-types.js';
import { parseDraftInput } from '../../core/drafts.js';
import type { RouteContext } from '../context.js';
import { apiError } from '../errors.js';
import { AUTHOR_EVENT, presenceAll } from '../thread.js';

const HANDOVER_REPEAT_MS = 60_000;

/**
 * Совместная работа новой панели (этап 7, 10.6 п.5, 6, 8): черновики на
 * сервере, присутствие во всех диалогах, «Попросить передать». Права — в
 * src/panel/permissions.ts (черновик и просьба — conversation:reply).
 */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store, operations, actorOf, pushV2, drafts } = ctx;
  const asked = new Map<string, number>();

  app.get('/api/presence', async (): Promise<PresenceResponse> => ({ items: presenceAll(store.db, operations) }));

  app.get<{ Params: { id: string } }>('/api/conversations/:id/draft', async (request, reply): Promise<DraftResponse | void> => {
    const id = Number(request.params.id);
    if (!store.getConversation(id)) return reply.code(404).send(apiError('not_found', 'Диалог не найден'));
    return { draft: drafts.get(actorOf(request).key, id) };
  });

  app.put<{ Params: { id: string } }>('/api/conversations/:id/draft', async (request, reply): Promise<DraftResponse | void> => {
    const id = Number(request.params.id);
    if (!store.getConversation(id)) return reply.code(404).send(apiError('not_found', 'Диалог не найден'));
    const input = parseDraftInput(request.body);
    if (typeof input === 'string') return reply.code(400).send(apiError('bad_request', input));
    const actor = actorOf(request);
    const draft = drafts.put(actor.key, id, input);
    pushV2({ type: 'thread', kind: 'draft', conversation_id: id, draft }, (key) => key === actor.key);
    return { draft };
  });

  app.delete<{ Params: { id: string } }>('/api/conversations/:id/draft', async (request, reply) => {
    const id = Number(request.params.id);
    if (!store.getConversation(id)) return reply.code(404).send(apiError('not_found', 'Диалог не найден'));
    const actor = actorOf(request);
    if (drafts.delete(actor.key, id)) pushV2({ type: 'thread', kind: 'draft', conversation_id: id, draft: null }, (key) => key === actor.key);
    return { ok: true };
  });

  /**
   * «Попросить передать» (6.3.7): заметка для команды и кадр тому, кто ведёт.
   * «Передать» у него — POST /release. Повтор чаще раза в минуту не шлётся.
   */
  app.post<{ Params: { id: string } }>('/api/conversations/:id/handover-request', async (request, reply) => {
    const id = Number(request.params.id);
    const conversation = store.getConversation(id);
    if (!conversation) return reply.code(404).send(apiError('not_found', 'Диалог не найден'));
    const actor = actorOf(request);
    const owner = (operations.collaboration(id) as { owner: { key: string; name: string } | null }).owner;
    if (!owner || owner.key === actor.key) return reply.code(409).send(apiError('bad_request', 'Диалог сейчас никто другой не ведёт'));
    const key = `${actor.key}|${id}`;
    const now = Date.now();
    if ((asked.get(key) ?? 0) > now - HANDOVER_REPEAT_MS) return { ok: true, repeated: true };
    asked.set(key, now);
    if (asked.size > 1000) for (const [entry, at] of asked) if (at < now - HANDOVER_REPEAT_MS) asked.delete(entry);
    const added = store.addNote(id, `${actor.name} просит передать диалог (${owner.name} сейчас ведёт).`);
    try { store.logEvent(AUTHOR_EVENT, id, { message_id: added.message.id, actor: actor.key }); } catch { /* подпись не обязательна */ }
    operations.audit(actor, 'conversation.handover_request', 'conversations', id, { owner: owner.key }, request.ip);
    pushV2({
      type: 'thread', kind: 'handover_request', conversation_id: id,
      from: { id: actor.key, name: actor.name }, customer: conversation.display_name ?? conversation.username ?? null,
    }, (target) => target === owner.key);
    return { ok: true, message: added.message };
  });
}
