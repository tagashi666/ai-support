import { config, log } from '../config.js';
import { runtime } from './settings.js';
import type { Notifier } from './notify.js';
import type { Store } from './store.js';

/**
 * Следит за первым ответом. Уведомление уходит один раз на диалог —
 * повторные пинги про один и тот же тикет быстро учат их игнорировать.
 */
export class SlaWatcher {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: Store,
    private readonly notifier: Notifier,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.check(), config.sla.checkSeconds * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(): Promise<number> {
    const overdue = this.store.overdueConversations(runtime.slaFirstResponseMinutes, config.sla.maxAgeHours);
    let alerted = 0;
    let attempted = 0;

    for (const conversation of overdue) {
      // Потолок на цикл: пачка из полусотни уведомлений подряд ничем не лучше
      // молчания — её так же перестают читать.
      if (attempted >= config.sla.maxAlertsPerCycle) {
        log.warn(`Ещё ${overdue.length - attempted} диалогов без ответа — уведомления придут следующим циклом`);
        break;
      }
      const key = `sla:alerted:${conversation.id}`;
      if (this.store.getState(key)) continue;
      attempted += 1;

      const waited = Math.round((Date.now() - (conversation.last_inbound_at ?? 0)) / 60_000);
      const last = this.store.lastInboundMessage(conversation.id);
      const delivered = await this.notifier.notify('sla', conversation, {
        reason: `без ответа ${waited} мин`,
        excerpt: last?.text ?? conversation.subject ?? undefined,
      });
      if (!delivered) continue;
      this.store.setState(key, String(Date.now()));
      this.store.logEvent('sla_breach', conversation.id, { waiting_min: waited });
      alerted += 1;
    }
    return alerted;
  }
}
