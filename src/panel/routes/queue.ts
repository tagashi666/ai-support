import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';

/** Поиск, очередь, SLA, фильтры, шаблоны и статистика. */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store, operations, actorOf } = ctx;

  app.get<{ Querystring: { q?: string } }>('/api/search', async (request) => (
    operations.search(actorOf(request), request.query.q)
  ));

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

  // --- шаблоны и статистика ------------------------------------------

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
}
