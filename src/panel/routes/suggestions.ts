import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';

/** Причины «Не подходит»: неверный факт, не тот тон, не по теме, нет в знаниях, просто не нужно. */
export const REJECT_REASONS = new Set(['wrong_fact', 'tone', 'off_topic', 'not_in_kb', 'not_needed']);

/** Предложения AI: принять или отклонить. */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store } = ctx;

  // --- предложения AI --------------------------------------------------

  app.post<{ Params: { id: string }; Body: { status?: string; reason?: string } }>(
    '/api/suggestions/:id/decide',
    async (request, reply) => {
      const suggestion = store.getSuggestion(Number(request.params.id));
      if (!suggestion) return reply.code(404).send({ error: 'Предложка не найдена' });
      const status = request.body?.status === 'rejected' ? 'rejected' : 'superseded';
      store.decideSuggestion(suggestion.id, status);
      // Причина «Не подходит» (6.3.4) — в журнал событий: материал для обучения и итогов (10.4).
      if (status === 'rejected' && typeof request.body?.reason === 'string' && REJECT_REASONS.has(request.body.reason)) {
        store.logEvent('suggestion_rejected', suggestion.conversation_id, { suggestion_id: suggestion.id, reason: request.body.reason });
      }
      // Решение видят и другие вкладки: иначе отклонённая предложка висела у
      // них до переоткрытия диалога и её можно было отправить клиенту.
      const conversation = store.getConversation(suggestion.conversation_id);
      const decided = store.getSuggestion(suggestion.id);
      if (conversation && decided) store.emit('suggestion', { conversation, suggestion: decided });
      return { ok: true };
    },
  );
}
