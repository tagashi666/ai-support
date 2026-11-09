import type { FastifyInstance } from 'fastify';
import { settingOverrides } from '../../core/settings.js';
import { version } from '../../config.js';
import type { RouteContext } from '../context.js';
import { channelAvailability } from '../helpers.js';

/** Диагностика и проверка здоровья. */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store, outbox, bot, nodes, customers, remnawave, bedolaga, minishop, operations } = ctx;

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
}
