import { log } from '../config.js';
import type { BedolagaTicketStatus } from '../channels/bedolaga.js';
import type { Conversation, Store } from './store.js';

export const AUTO_RESOLVE_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 100;

interface BedolagaStatusWriter {
  setStatus(ticketId: number, status: BedolagaTicketStatus): Promise<void>;
}

function bedolagaTicketId(conversation: Conversation): number {
  const id = Number(conversation.remote_external_id ?? conversation.external_id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Диалог ${conversation.id}: некорректный ID тикета Bedolaga`);
  }
  return id;
}

/**
 * Завершает диалоги без активности за последние 24 часа. Для Bedolaga
 * удалённое закрытие выполняется первым: при ошибке локальная карточка
 * остаётся активной и не расходится с исходной системой.
 */
export class ConversationLifecycle {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly bedolaga?: BedolagaStatusWriter,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
    private readonly batchSize = DEFAULT_BATCH_SIZE,
  ) {}

  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(now = Date.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let resolved = 0;

    try {
      const cutoff = now - AUTO_RESOLVE_AFTER_MS;
      for (const candidate of this.store.inactiveConversations(cutoff, this.batchSize)) {
        // Проверяем повторно непосредственно перед возможным сетевым вызовом:
        // за время обработки предыдущих карточек могло прийти новое сообщение.
        const conversation = this.store.getConversation(candidate.id);
        if (!conversation?.last_message_at || conversation.last_message_at > cutoff) continue;
        if (conversation.status === 'closed' || conversation.status === 'resolved') continue;

        try {
          if (conversation.channel === 'bedolaga') {
            if (!this.bedolaga) {
              log.warn(`Диалог ${conversation.id}: авто-закрытие Bedolaga пропущено — интеграция отключена`);
              continue;
            }
            await this.bedolaga.setStatus(bedolagaTicketId(conversation), 'closed');
          }
          if (this.store.setStatus(conversation.id, 'resolved')) {
            this.store.logEvent('auto_resolved', conversation.id, {
              inactive_ms: now - conversation.last_message_at,
            });
            resolved += 1;
          }
        } catch (err) {
          log.error(`Диалог ${conversation.id}: авто-закрытие не удалось`, err);
        }
      }
    } finally {
      this.running = false;
    }

    return resolved;
  }
}
