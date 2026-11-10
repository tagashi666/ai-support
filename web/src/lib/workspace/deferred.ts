/**
 * Отложенная фиксация (план, 7.6, ярус 0): у действий со следом вне панели
 * («Решено» синхронизирует заявку и ставит диалог в обучение, «Важно» шлёт
 * уведомление в Telegram) запрос уходит только после окна отмены. Панель
 * показывает итог сразу; «Отменить» снимает запрос, и сервер ничего не узнаёт.
 * При скрытии или закрытии вкладки отложенное уходит сразу (keepalive):
 * человек уже нажал кнопку.
 *
 * Отправка ответа с окном отмены (6.3.5) — тот же механизм с другим окном.
 */
import { dismissToast, undoToast, UNDO_MS } from '@/lib/actions/toasts';

export interface DeferredTask {
  /** Один ключ — одно отложенное: повтор того же действия заменяет прежнее. */
  key: string;
  /** Запрос к серверу; keepalive — вкладку закрывают. */
  commit(keepalive: boolean): Promise<void>;
  /** Вернуть показ как было (отмена или ошибка запроса). */
  revert(): void;
  /** Запрос не прошёл: панель уже вернула показ, здесь — тост с причиной. */
  failed?(err: unknown): void;
  /** Запрос ушёл и принят. */
  done?(): void;
  /** Запрос уходит (по таймеру, «сейчас» или при скрытии вкладки): закрыть тост с «Отменить». */
  started?(): void;
}

interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const browserTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class DeferredQueue {
  /** left ≠ null — на паузе, столько мс останется после resume. */
  private readonly tasks = new Map<string, { task: DeferredTask; handle: unknown; at: number; left: number | null }>();

  constructor(private readonly timers: Timers = browserTimers) {}

  /** Поставить действие: показ уже изменён, запрос — через `delay` мс. */
  schedule(task: DeferredTask, delay: number): void {
    const known = this.tasks.get(task.key);
    if (known) {
      this.timers.clear(known.handle);
      this.tasks.delete(task.key);
    }
    if (delay <= 0) { void this.run(task, false); return; }
    this.tasks.set(task.key, { task, handle: this.arm(task.key, delay), at: Date.now() + delay, left: null });
  }

  /** Пауза окна отмены (курсор или фокус на тосте, M-2): запрос не уйдёт, пока не resume. */
  pause(key: string): void {
    const known = this.tasks.get(key);
    if (!known || known.left !== null) return;
    this.timers.clear(known.handle);
    known.left = Math.max(0, known.at - Date.now());
  }

  /** Снять паузу: окно продолжается с того места, где встало. */
  resume(key: string): void {
    const known = this.tasks.get(key);
    if (!known || known.left === null) return;
    known.at = Date.now() + known.left;
    known.handle = this.arm(key, known.left);
    known.left = null;
  }

  private arm(key: string, delay: number): unknown {
    return this.timers.set(() => {
      const known = this.tasks.get(key);
      if (!known) return;
      this.tasks.delete(key);
      void this.run(known.task, false);
    }, delay);
  }

  /** «Отменить»: запрос не уходит, показ возвращается. false — уже ушёл. */
  cancel(key: string): boolean {
    const known = this.tasks.get(key);
    if (!known) return false;
    this.timers.clear(known.handle);
    this.tasks.delete(key);
    known.task.revert();
    return true;
  }

  /** Отправить сейчас (повторное ⌘↵, кнопка «Отправить сейчас»). */
  now(key: string): boolean {
    const known = this.tasks.get(key);
    if (!known) return false;
    this.timers.clear(known.handle);
    this.tasks.delete(key);
    void this.run(known.task, false);
    return true;
  }

  /** Вкладка скрывается или закрывается: всё отложенное уходит сразу. */
  flush(keepalive = true): void {
    const all = [...this.tasks.values()];
    this.tasks.clear();
    for (const { task, handle } of all) {
      this.timers.clear(handle);
      void this.run(task, keepalive);
    }
  }

  has(key: string): boolean { return this.tasks.has(key); }

  /** Когда уйдёт запрос (для «отправим через 4 с»). */
  dueAt(key: string): number | null {
    const known = this.tasks.get(key);
    return known && known.left === null ? known.at : null;
  }

  get size(): number { return this.tasks.size; }

  private async run(task: DeferredTask, keepalive: boolean): Promise<void> {
    task.started?.();
    try {
      await task.commit(keepalive);
      task.done?.();
    } catch (err) {
      task.revert();
      task.failed?.(err);
    }
  }
}

/** Общая очередь панели: при скрытии вкладки уходит всё отложенное. */
export const deferred = new DeferredQueue();

/**
 * Отложенное действие с тостом «Отменить» (M-2): тост и окно отмены — одно целое.
 * Курсор или фокус на тосте ставят на паузу и отсчёт, и запрос; запрос ушёл
 * (таймер, «сейчас», скрытие вкладки) — тост закрывается. Возвращает id тоста.
 */
export function deferWithUndo(task: DeferredTask, text: string, label: string, onUndo?: () => void, queue: DeferredQueue = deferred): number {
  let id = 0;
  queue.schedule({ ...task, started: () => { dismissToast(id); task.started?.(); } }, UNDO_MS);
  id = undoToast(text, () => { if (queue.cancel(task.key)) onUndo?.(); }, label,
    (held) => { if (held) queue.pause(task.key); else queue.resume(task.key); });
  return id;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') deferred.flush(true); });
  addEventListener('pagehide', () => deferred.flush(true));
}
