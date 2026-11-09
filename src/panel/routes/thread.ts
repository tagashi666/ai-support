import type { FastifyInstance } from 'fastify';
import type { ThreadResponse, ThreadSuggestion } from '../../shared/api-types.js';
import type { RouteContext } from '../context.js';
import { apiError } from '../errors.js';
import { livePendingSuggestion } from '../helpers.js';
import { projectMessages, projectSuggestion, threadEvents, threadHead } from '../thread.js';

const PAGE = 100;
const FIRST_PAGE = 200;
const ID = /^\d{1,15}$/;

/**
 * Диалог в новой панели (этап 3а): шапка, лента, черновик помощника и
 * события одной явной проекцией. `before` — ранняя история, `after` —
 * догон после разрыва связи (сообщения новее и события после `since`).
 */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store, outbox, operations, actorOf } = ctx;

  app.get<{ Params: { id: string }; Querystring: { before?: string; after?: string; since?: string } }>(
    '/api/thread/:id',
    async (request, reply): Promise<ThreadResponse | void> => {
      const conversation = store.getConversation(Number(request.params.id));
      if (!conversation) return reply.code(404).send(apiError('not_found', 'Диалог не найден'));
      const { before, after, since } = request.query ?? {};
      for (const value of [before, after, since]) {
        if (value !== undefined && !ID.test(value)) return reply.code(400).send(apiError('bad_request', 'Некорректный параметр'));
      }
      const head = threadHead(store, outbox, operations, conversation, actorOf(request).key);
      if (!head) return reply.code(404).send(apiError('not_found', 'Диалог не найден'));
      let rows;
      let hasMore = false;
      if (before !== undefined) {
        rows = store.listMessagesBefore(conversation.id, Number(before), PAGE);
        hasMore = rows.length === PAGE;
      } else if (after !== undefined) {
        rows = store.listMessagesAfter(conversation.id, Number(after), FIRST_PAGE);
      } else {
        rows = store.listMessages(conversation.id, FIRST_PAGE);
        hasMore = rows.length === FIRST_PAGE;
      }
      const messages = projectMessages(store.db, conversation.id, rows);
      // События — в пределах страницы: для ранней истории между её краями, иначе от первого сообщения.
      const from = since !== undefined ? Number(since) : (rows[0]?.created_at ?? conversation.created_at) - 1;
      const upTo = before !== undefined ? (store.listMessagesAfter(conversation.id, Number(before) - 1, 1)[0]?.created_at ?? Infinity) : Infinity;
      const events = threadEvents(store.db, conversation, from).filter((event) => event.at < upTo);
      return {
        head,
        messages,
        has_more: hasMore,
        suggestion: before !== undefined ? null : projectSuggestion(livePendingSuggestion(store, conversation)),
        events,
      };
    },
  );

  /** Черновик по id: «Почему так?» у ответа помощника (10.3 п.5). */
  app.get<{ Params: { id: string } }>('/api/suggestions/:id', async (request, reply): Promise<{ suggestion: ThreadSuggestion } | void> => {
    if (!ID.test(request.params.id)) return reply.code(400).send(apiError('bad_request', 'Некорректный номер'));
    const suggestion = projectSuggestion(store.getSuggestion(Number(request.params.id)));
    if (!suggestion) return reply.code(404).send(apiError('not_found', 'Черновик не найден'));
    return { suggestion };
  });
}
