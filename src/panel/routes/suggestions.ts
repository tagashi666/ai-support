import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';

/** Предложения AI: принять или отклонить. */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store } = ctx;

  // --- предложения AI --------------------------------------------------

  app.post<{ Params: { id: string }; Body: { status?: string } }>(
    '/api/suggestions/:id/decide',
    async (request, reply) => {
      const suggestion = store.getSuggestion(Number(request.params.id));
      if (!suggestion) return reply.code(404).send({ error: 'Предложка не найдена' });
      const status = request.body?.status === 'rejected' ? 'rejected' : 'superseded';
      store.decideSuggestion(suggestion.id, status);
      // Решение видят и другие вкладки: иначе отклонённая предложка висела у
      // них до переоткрытия диалога и её можно было отправить клиенту.
      const conversation = store.getConversation(suggestion.conversation_id);
      const decided = store.getSuggestion(suggestion.id);
      if (conversation && decided) store.emit('suggestion', { conversation, suggestion: decided });
      return { ok: true };
    },
  );
}
