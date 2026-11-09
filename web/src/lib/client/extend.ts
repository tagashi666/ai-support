/**
 * Продление подписки Bedolaga (6.4, проверки №38 классики). Двойное
 * продление блокируется дважды: здесь кнопка неактивна, пока операция идёт
 * или её исход неясен, а на сервере — идемпотентность по operationId и замок
 * по подписке (routes/customers.ts). Повтора запроса нет: автоматический
 * повтор удвоил бы начисление.
 */
import { signal } from '@preact/signals';
import type { ExtendResponse } from './types';

export type ExtendState = 'idle' | 'pending' | 'uncertain';
export type ExtendOutcome =
  | { kind: 'done'; warning?: string }
  | { kind: 'unknown'; warning: string }
  | { kind: 'error'; message: string }
  | { kind: 'blocked' };

export const DAYS_MIN = 1;
export const DAYS_MAX = 36_500;
export const validDays = (days: number): boolean => Number.isSafeInteger(days) && days >= DAYS_MIN && days <= DAYS_MAX;

export interface ExtendDeps {
  /** POST с ключом; бросает при обрыве связи; ответ сервера с кодом. */
  post: (path: string, body: unknown) => Promise<{ status: number; body: ExtendResponse & { error?: string } }>;
  uuid: () => string;
}

export class ExtensionGuard {
  private readonly pending = new Set<number>();
  private readonly uncertain = new Set<number>();
  /** Будит интерфейс при смене состояния. */
  readonly tick = signal(0);

  state(subscriptionId: number): ExtendState {
    void this.tick.value;
    if (this.pending.has(subscriptionId)) return 'pending';
    if (this.uncertain.has(subscriptionId)) return 'uncertain';
    return 'idle';
  }

  /** «Срок проверен» — после обновления карточки исход больше не неясен. */
  clearUncertain(subscriptionId: number): void {
    if (this.uncertain.delete(subscriptionId)) this.tick.value += 1;
  }

  async run(conversationId: number, subscriptionId: number, days: number, deps: ExtendDeps): Promise<ExtendOutcome> {
    if (!validDays(days)) return { kind: 'error', message: 'days' };
    if (this.pending.has(subscriptionId) || this.uncertain.has(subscriptionId)) return { kind: 'blocked' };
    this.pending.add(subscriptionId);
    this.tick.value += 1;
    const operationId = deps.uuid();
    try {
      let response: Awaited<ReturnType<ExtendDeps['post']>>;
      try {
        response = await deps.post(`/api/conversations/${conversationId}/bedolaga/subscriptions/${subscriptionId}/extend`, { days, operationId });
      } catch {
        // Связь оборвалась после отправки — Bedolaga могла продлить. Не повторяем.
        this.uncertain.add(subscriptionId);
        return { kind: 'unknown', warning: 'network' };
      }
      if (response.status === 202 || response.body.outcome === 'unknown') {
        this.uncertain.add(subscriptionId);
        return { kind: 'unknown', warning: response.body.warning ?? 'unknown' };
      }
      if (response.status < 200 || response.status >= 300) return { kind: 'error', message: response.body.error ?? `HTTP ${response.status}` };
      return { kind: 'done', ...(response.body.warning ? { warning: response.body.warning } : {}) };
    } finally {
      this.pending.delete(subscriptionId);
      this.tick.value += 1;
    }
  }
}

export const extensions = new ExtensionGuard();
