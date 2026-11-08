import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';

/** Узлы Remnawave: состояние, обновление и подписи. */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store, nodes } = ctx;

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
}
