import type { Bot } from 'grammy';
import { TelegramBotRegistry } from '../channels/tgdm.js';
import type { BedolagaClient } from '../channels/bedolaga.js';
import type { MinishopClient } from '../channels/minishop.js';
import { log } from '../config.js';
import type { Notifier } from '../core/notify.js';
import type { Operations, Actor, Permission } from '../core/operations.js';
import type { Outbox } from '../core/outbox.js';
import type { SourceManager } from '../core/sources.js';
import type { Conversation, Store } from '../core/store.js';
import type { UpdateManager } from '../core/update.js';
import { runMining } from '../ai/mining.js';
import type { LiveHub } from './live.js';
import type { CustomerDirectory } from '../integrations/customers.js';
import type { NodeState, RemnawaveClient } from '../integrations/remnawave.js';

export interface WebDeps {
  store: Store;
  outbox: Outbox;
  bot?: Bot | TelegramBotRegistry;
  notifier?: Notifier;
  nodes?: { get(): { at: number; nodes: NodeState[]; error?: string }; refresh(): Promise<unknown> };
  customers?: CustomerDirectory;
  remnawave?: RemnawaveClient;
  remnawaves?: { id: string; name: string; client: RemnawaveClient; readOnly: boolean }[];
  bedolaga?: BedolagaClient;
  minishop?: MinishopClient;
  onKbChanged?: () => void;
  /** Оператор прочитал диалог (POST /read): отметить прочтение во внешнем канале. */
  onOpened?: (conversation: Conversation) => void;
}

export type MiningOptions = Parameters<typeof runMining>[1];
export type MiningReport = Awaited<ReturnType<typeof runMining>>;

/**
 * Общие зависимости маршрутов панели. Собирается один раз в startWeb и
 * передаётся в register(app, ctx) каждого модуля из routes/.
 */
export interface RouteContext extends Omit<WebDeps, 'remnawaves'> {
  remnawaves: NonNullable<WebDeps['remnawaves']>;
  operations: Operations;
  updates: UpdateManager;
  sources: SourceManager;
  /** Оператор запроса; без авторизации (тесты, внутренние вызовы) — root. */
  actorOf(request: object): Actor;
  /** Живые данные новой панели: журнал кадров и пересчёт строк списка. */
  live: LiveHub;
  /** Кадр всем WS-подписчикам с правом `permission` (по умолчанию conversation:read). */
  broadcast(frame: unknown, permission?: Permission): void;
  /**
   * Фоновый проход майнинга: прогресс и итог пишутся в журнал задач и уходят
   * по WS тем, у кого есть право на этот вид задач. `onDone` выполняется до
   * события «done»; если он бросит, задача помечается упавшей.
   */
  runJob(jobId: number, kind: 'mine' | 'auto-learn', options: MiningOptions, onDone: (report: MiningReport) => void): void;
  /** Состояние бизнес-подключения Telegram; null — подключения нет. */
  businessConnectionState(): Promise<{ enabled: boolean; canReply: boolean } | null>;
}

export function createRouteContext(
  deps: WebDeps,
  parts: Pick<RouteContext, 'operations' | 'updates' | 'sources' | 'actorOf' | 'broadcast' | 'live'>,
): RouteContext {
  const { store, bot } = deps;
  const { broadcast } = parts;

  const runJob: RouteContext['runJob'] = (jobId, kind, options, onDone) => {
    const permission: Permission = kind === 'mine' ? 'knowledge:mine' : 'knowledge:review';
    void (async () => {
      try {
        const report = await runMining(store, options, (message) => {
          store.updateJob(jobId, message);
          broadcast({ type: 'job', kind, status: 'running', progress: message }, permission);
        });
        store.finishJob(jobId, report);
        onDone(report);
        broadcast({ type: 'job', kind, status: 'done', report }, permission);
      } catch (err) {
        const message = (err as Error).message;
        store.finishJob(jobId, undefined, message);
        broadcast({ type: 'job', kind, status: 'failed', error: message }, permission);
      }
    })();
  };

  /**
   * Апдейт business_connection приходит один раз, в момент подключения бота.
   * Если процесс тогда не работал, таблица пуста — но id есть в диалогах,
   * и подключение можно дотянуть напрямую из Telegram.
   */
  const businessConnectionState = async (): Promise<{ enabled: boolean; canReply: boolean } | null> => {
    const id = store.activeBusinessConnectionId() ?? store.anyBusinessConnectionId();
    if (!id || !bot) return id ? { enabled: true, canReply: true } : null;
    try {
      const saved = store.businessConnection(id);
      const selectedBot = bot instanceof TelegramBotRegistry ? bot.botBySource(saved?.source_id) : bot;
      if (!selectedBot) return { enabled: true, canReply: true };
      const connection = await selectedBot.api.getBusinessConnection(id);
      store.saveBusinessConnection({
        id: connection.id,
        userId: connection.user.id,
        userChatId: connection.user_chat_id,
        isEnabled: connection.is_enabled,
        rights: connection.rights,
        connectedAt: connection.date * 1000,
      });
      return { enabled: connection.is_enabled, canReply: connection.rights?.can_reply === true };
    } catch (err) {
      log.debug('Не удалось получить бизнес-подключение', err);
      return { enabled: true, canReply: true };
    }
  };

  return { ...deps, remnawaves: deps.remnawaves ?? [], ...parts, runJob, businessConnectionState };
}
