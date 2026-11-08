import type { FastifyInstance } from 'fastify';
import { version } from '../../config.js';
import { PERMISSION_CATALOG } from '../../core/operations.js';
import type { RouteContext } from '../context.js';

/** Операторы, роли, личная статистика и журнал аудита. */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { operations, actorOf } = ctx;

  app.get('/api/me', async (request) => {
    const actor = actorOf(request);
    return { actor: { ...actor, permissions: operations.permissionsFor(actor) }, version };
  });

  app.get('/api/operators', async (request, reply) => {
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

  app.post<{ Params: { id: string }; Body: { active?: boolean; rotate?: boolean; name?: string; role?: string } }>('/api/operators/:id', async (request, reply) => {
    const id = Number(request.params.id);
    try {
      if (request.body?.rotate) return { ok: true, token: operations.rotateOperator(id) };
      if (request.body?.name !== undefined || request.body?.role !== undefined) {
        const operator = operations.updateOperator(id, request.body);
        if (!operator) return reply.code(404).send({ error: 'Оператор не найден' });
        return { ok: true, operator };
      }
      if (typeof request.body?.active !== 'boolean') return reply.code(400).send({ error: 'Нужно active, rotate, name или role' });
      if (!operations.setOperatorActive(id, request.body.active)) return reply.code(404).send({ error: 'Оператор не найден' });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/api/roles', async () => ({
    catalog: PERMISSION_CATALOG,
    roles: operations.rolePermissions(),
    defaults: operations.defaultRolePermissions(),
  }));

  app.put<{ Params: { role: string }; Body: { permissions?: unknown } }>('/api/roles/:role', async (request, reply) => {
    try {
      const permissions = operations.setRolePermissions(request.params.role, request.body?.permissions);
      return { ok: true, role: request.params.role, permissions };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Querystring: { days?: string } }>('/api/operator-stats', async (request) => (
    operations.operatorStats(Number(request.query.days ?? 30))
  ));

  app.get<{ Querystring: { limit?: string } }>('/api/audit', async (request, reply) => {
    if (!operations.can(actorOf(request), 'audit:read')) return reply.code(403).send({ error: 'Недостаточно прав' });
    return { events: operations.listAudit(Number(request.query.limit ?? 200)) };
  });
}
