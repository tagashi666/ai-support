/**
 * M-2 (audit/ui-polish/motion.md): «Отменить» в тосте не должно молча не работать
 * после паузы. Отсчёт тоста и окно отмены действия — одно целое: пауза тоста
 * держит и запрос, запрос ушёл — тост закрывается.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toasts, UNDO_MS } from '@/lib/actions/toasts';
import { DeferredQueue, deferWithUndo } from './deferred';

describe('тост «Отменить» и отложенное действие (M-2)', () => {
  let queue: DeferredQueue;
  beforeEach(() => {
    vi.useFakeTimers();
    queue = new DeferredQueue();
    toasts.value = [];
  });
  afterEach(() => { vi.useRealTimers(); });
  const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
  const only = () => { expect(toasts.value).toHaveLength(1); return toasts.value[0]!; };

  it('пауза тоста держит запрос сколько угодно; «Отменить» после паузы работает', async () => {
    const commit = vi.fn(async () => undefined);
    const revert = vi.fn();
    const undone = vi.fn();
    deferWithUndo({ key: 'resolve:1', commit, revert }, 'Решено', 'Отменить', undone, queue);
    const toast = only();
    vi.advanceTimersByTime(2000);
    toast.hold?.(true);
    vi.advanceTimersByTime(UNDO_MS * 3);
    await settle();
    expect(commit).not.toHaveBeenCalled();
    toast.action?.run();
    await settle();
    expect(commit).not.toHaveBeenCalled();
    expect(revert).toHaveBeenCalledOnce();
    expect(undone).toHaveBeenCalledOnce();
    expect(toasts.value).toHaveLength(0);
  });

  it('после паузы окно продолжается с того же места', async () => {
    const commit = vi.fn(async () => undefined);
    deferWithUndo({ key: 'k', commit, revert: vi.fn() }, 'Скрыт', 'Отменить', undefined, queue);
    const toast = only();
    vi.advanceTimersByTime(4000);
    toast.hold?.(true);
    vi.advanceTimersByTime(60_000);
    toast.hold?.(false);
    vi.advanceTimersByTime(UNDO_MS - 4000 - 10);
    await settle();
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    await settle();
    expect(commit).toHaveBeenCalledWith(false);
  });

  it('запрос ушёл — тост закрывается, «Отменить» больше не висит', async () => {
    const commit = vi.fn(async () => undefined);
    deferWithUndo({ key: 'k', commit, revert: vi.fn() }, 'Решено', 'Отменить', undefined, queue);
    only();
    vi.advanceTimersByTime(UNDO_MS);
    await settle();
    expect(commit).toHaveBeenCalledOnce();
    expect(toasts.value).toHaveLength(0);
  });

  it('скрытие вкладки отправляет и закрывает тост даже на паузе', async () => {
    const commit = vi.fn(async () => undefined);
    deferWithUndo({ key: 'k', commit, revert: vi.fn() }, 'Решено', 'Отменить', undefined, queue);
    only().hold?.(true);
    queue.flush(true);
    await settle();
    expect(commit).toHaveBeenCalledWith(true);
    expect(toasts.value).toHaveLength(0);
  });

  it('пока на паузе, dueAt молчит; resume без паузы ничего не ломает', () => {
    deferWithUndo({ key: 'k', commit: vi.fn(async () => undefined), revert: vi.fn() }, 'x', 'y', undefined, queue);
    expect(queue.dueAt('k')).not.toBeNull();
    queue.resume('k');
    queue.pause('k');
    queue.pause('k');
    expect(queue.dueAt('k')).toBeNull();
    expect(queue.has('k')).toBe(true);
  });
});
