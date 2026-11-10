/**
 * Тосты (7.6): обычные — role=status и исчезают через 6 с (таймер стоит,
 * пока курсор или фокус на тосте); ошибки — role=alert и сами не исчезают.
 * Стопка до трёх. Если за тостом стоит отложенное действие, hold ставит на паузу
 * и его (M-2): отсчёт тоста и окно отмены — одно целое.
 */
import { signal } from '@preact/signals';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'status' | 'error';
  action?: ToastAction;
  /** Мс до исчезновения; null — висит, пока не закроют. */
  ttl: number | null;
  /** Курсор или фокус на тосте (true) и ушёл (false): пауза действия за тостом. */
  hold?: (held: boolean) => void;
}

export const UNDO_MS = 6000;
export const toasts = signal<Toast[]>([]);
let seq = 0;

export function showToast(input: Omit<Toast, 'id' | 'ttl' | 'kind'> & Partial<Pick<Toast, 'ttl' | 'kind'>>): number {
  seq += 1;
  const toast: Toast = { id: seq, kind: input.kind ?? 'status', ttl: input.ttl === undefined ? UNDO_MS : input.ttl, ...input };
  toasts.value = [...toasts.value, toast].slice(-3);
  return toast.id;
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

/** Тост с «Отменить»: отмена закрывает тост и вызывает undo; hold — пауза окна отмены. */
export function undoToast(text: string, undo: () => void, actionLabel: string, hold?: (held: boolean) => void): number {
  let id = 0;
  id = showToast({ text, action: { label: actionLabel, run: () => { dismissToast(id); undo(); } }, ...(hold ? { hold } : {}) });
  return id;
}
