import type { FastifyInstance } from 'fastify';
import { settingOverrides } from '../../core/settings.js';
import { config, version } from '../../config.js';
import { runtime } from '../../core/settings.js';
import type { ConnectionsResponse, ProblemsResponse } from '../../shared/api-types.js';
import { systemProblems } from '../problems.js';
import type { RouteContext } from '../context.js';
import { channelAvailability } from '../helpers.js';

/** Диагностика и проверка здоровья. */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store, outbox, bot, nodes, customers, remnawave, bedolaga, minishop, operations, notifier, sources, remnawaves } = ctx;

  app.get('/api/diagnostics', async () => ({
    application: { version, uptime: process.uptime(), memory: process.memoryUsage() },
    database: operations.diagnostics(),
    channels: channelAvailability(outbox),
    integrations: {
      telegram: Boolean(bot), bedolaga: Boolean(bedolaga), minishop: Boolean(minishop), remnawave: Boolean(remnawave), customers: Boolean(customers), nodes: Boolean(nodes),
    },
    cursors: { bedolaga: store.getState('bedolaga:last_poll') ?? null, minishop: store.getState('minishop:last_poll') ?? null },
    kb: store.kbCount(),
    settingOverrides: settingOverrides().filter((item) => !['replyStyle', 'handoffMessage', 'customerLinks'].includes(item.key)),
  }));

  app.get('/api/health', async () => ({
    ok: true,
    kb: store.kbCount(),
    businessConnection: Boolean(store.activeBusinessConnectionId() ?? store.anyBusinessConnectionId()),
    lastBedolagaPoll: store.getState('bedolaga:last_poll') ?? null,
    lastMinishopPoll: store.getState('minishop:last_poll') ?? null,
  }));

  // Этап 6: неполадки для «Нужно внимание» и «Системы» — без сетевых вызовов.
  app.get('/api/system/problems', async (): Promise<ProblemsResponse> => ({ problems: systemProblems(ctx), checkedAt: Date.now() }));

  // «Система → Уведомления» (6.9): настроены ли и что присылать. Без вызова Telegram.
  app.get('/api/system/notifications', async () => ({
    configured: notifier?.state().configured ?? false,
    level: runtime.notifyLevel,
    lastError: notifier?.state().lastError ?? null,
  }));

  // «Подключения» (6.11): то же, что в /api/settings, но без запроса в Telegram и без секретов.
  app.get('/api/connections', async (): Promise<ConnectionsResponse> => ({
    sources: store.sourceAccounts().map(({ id, kind, name, enabled }) => ({ id, kind, name, enabled: Boolean(enabled) })),
    serviceProfiles: store.serviceProfiles(),
    businessConnections: store.businessConnections().map((connection) => ({
      id: connection.id, name: connection.display_name ?? null, username: connection.username ?? null, enabled: Boolean(connection.is_enabled),
    })),
    remnawave: remnawaves.length > 0
      ? remnawaves.map((panel) => ({ id: panel.id, name: panel.name, readOnly: panel.readOnly }))
      : remnawave ? [{ id: 'remnawave', name: 'Remnawave', readOnly: config.remnawave.readOnly }] : [],
    bedolaga: { enabled: Boolean(bedolaga), lastPoll: store.getState('bedolaga:last_poll') ?? null },
    minishop: { enabled: Boolean(minishop), lastPoll: store.getState('minishop:last_poll') ?? null },
    sourceManagement: await sources.state() as ConnectionsResponse['sourceManagement'],
  }));
}
