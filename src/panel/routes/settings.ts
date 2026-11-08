import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { config, log, version } from '../../config.js';
import { applySettings, runtime } from '../../core/settings.js';
import type { Permission } from '../../core/operations.js';
import type { RouteContext } from '../context.js';
import { channelAvailability } from '../helpers.js';

/** Настройки, внешние сервисы, источники и центр обновлений. */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store, outbox, notifier, nodes, remnawave, remnawaves, operations, updates, sources, actorOf, businessConnectionState } = ctx;

  // --- настройки ---------------------------------------------------------

  app.post('/api/settings/test-alert', async (_request, reply) => {
    if (!notifier) return reply.code(501).send({ error: 'Уведомления не настроены' });
    const result = await notifier.test();
    return result.ok ? { ok: true } : reply.code(502).send({ error: result.error });
  });

  app.get('/api/settings', async () => ({
    version,
    runtime,
    businessConnectionLive: await businessConnectionState(),
    channels: channelAvailability(outbox),
    remnawave: remnawave ? { ...remnawave.capabilities(), index: remnawave.indexState() } : null,
    remnawaves: remnawaves.map((panel) => ({
      id: panel.id,
      name: panel.name,
      readOnly: panel.readOnly,
      ...panel.client.capabilities(),
      index: panel.client.indexState(),
    })),
    sources: store.sourceAccounts().map(({ id, kind, name, enabled }) => ({ id, kind, name, enabled: Boolean(enabled) })),
    folders: store.folders(),
    serviceProfiles: store.serviceProfiles(),
    sourceManagement: await sources.state(),
    businessConnections: store.businessConnections().map((connection) => ({
      id: connection.id,
      name: connection.display_name,
      username: connection.username,
      enabled: Boolean(connection.is_enabled),
    })),
    alerts: notifier?.state() ?? null,
    nodes: nodes ? { known: nodes.get().nodes.length, at: nodes.get().at } : null,
    readOnly: config.remnawave.readOnly,
    ai: { keys: config.ai.apiKeys.length, model: runtime.model, fallback: runtime.fallbackModel || null },
    kb: store.kbCount(),
    businessConnection: Boolean(store.activeBusinessConnectionId() ?? store.anyBusinessConnectionId()),
    lastBedolagaPoll: store.getState('bedolaga:last_poll') ?? null,
    lastMinishopPoll: store.getState('minishop:last_poll') ?? null,
  }));

  app.post<{ Body: Record<string, unknown> }>('/api/settings', async (request, reply) => {
    const values = request.body ?? {};
    const actor = actorOf(request);
    const forbidden = Object.keys(values).filter((key) => !operations.can(actor, `setting:${key}` as Permission));
    if (forbidden.length) {
      return reply.code(403).send({ error: `Нет права изменять настройки: ${forbidden.join(', ')}` });
    }
    if (values['aiMode'] !== undefined && values['aiMode'] !== 'off' && !config.ai.apiKeys.length) {
      return reply.code(400).send({ error: 'Сначала задайте AI_API_KEY на сервере' });
    }
    const result = applySettings(store, values);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return { ok: true, runtime };
  });

  app.post<{
    Params: { id: string };
    Body: { serviceName?: unknown; greetingMessage?: unknown; handoffMessage?: unknown };
  }>('/api/settings/services/:id', async (request, reply) => {
    try {
      const profile = store.saveServiceProfile(request.params.id, request.body ?? {});
      store.logEvent('service_profile_updated', null, {
        sourceId: profile.sourceId,
        serviceName: profile.serviceName,
      });
      return { ok: true, profile, serviceProfiles: store.serviceProfiles() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/api/sources/status', async () => sources.state());

  app.post<{ Body: Record<string, unknown> }>('/api/sources/request', async (request, reply) => {
    try {
      const state = await sources.request(request.body ?? {}, store.sourceAccounts().map((source) => source.id));
      store.logEvent('source_add_requested', null, {
        kind: request.body?.['kind'], id: state.progress?.id, name: state.progress?.name,
      });
      return { ok: true, sourceManagement: state };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get<{ Querystring: { force?: string } }>('/api/update', async (request) => ({
    ...await updates.state(request.query?.force === '1'),
    history: operations.updateHistory(),
  }));

  app.post<{ Body: { action?: string; force?: boolean } }>('/api/update/request', async (request, reply) => {
    const actor = actorOf(request);
    const requestedAction = request.body?.action;
    if (requestedAction !== 'update' && requestedAction !== 'rollback') {
      return reply.code(400).send({ error: 'Допустимые действия: update или rollback' });
    }
    const action = requestedAction;
    try {
      const update = await updates.request(action, { force: request.body?.force === true });
      // Запрос уже атомарно передан host-updater. Локальный журнал не должен
      // превращать успешную постановку в ошибку и провоцировать повторный запуск.
      try {
        operations.recordUpdate(action, action === 'update' ? update.latest : update.current, 'queued', actor, {
          safety: update.compatibility,
        });
      } catch (err) {
        log.warn(`Не удалось записать локальный аудит обновления: ${err instanceof Error ? err.message : String(err)}`);
      }
      let history: ReturnType<typeof operations.updateHistory> = [];
      try { history = operations.updateHistory(); }
      catch (err) {
        log.warn(`Не удалось прочитать локальную историю обновлений: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { ok: true, update: { ...update, history } };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
