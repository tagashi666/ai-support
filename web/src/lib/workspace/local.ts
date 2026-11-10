/**
 * Свои действия видны сразу (план, 7.1 п.5): «Решено», «Убрать», «Важно»
 * меняют строку до ответа сервера, «Отменить» возвращает как было.
 * Поверх строки с сервера лежит заплатка; она живёт, пока сервер не прислал
 * версию новее той, на которую её положили (7.1 п.7: старое не затирает
 * новое, но и своё неподтверждённое не теряется).
 */
import { signal } from '@preact/signals';
import type { InboxItem } from '@shared/api-types';

export interface LocalPatch {
  /** updated_at строки, поверх которой положена заплатка. */
  base: number;
  patch: Partial<InboxItem>;
  /** Строку убрать из показа (скрыть из списка). */
  removed?: boolean;
  /**
   * Отложенное действие ещё в окне отмены: заплатка держится и поверх более
   * новых кадров (чужая печать, присутствие), пока запрос не ушёл (L-1).
   */
  held?: boolean;
}

export const patches = signal<ReadonlyMap<number, LocalPatch>>(new Map());

export function setPatch(id: number, value: LocalPatch): void {
  const next = new Map(patches.peek());
  next.set(id, value);
  patches.value = next;
}

export function dropPatch(id: number): void {
  if (!patches.peek().has(id)) return;
  const next = new Map(patches.peek());
  next.delete(id);
  patches.value = next;
}

/** Строка с учётом своей заплатки; null — убрана из показа. */
export function patched(item: InboxItem, map: ReadonlyMap<number, LocalPatch> = patches.value): InboxItem | null {
  const local = map.get(item.id);
  if (!local || (!local.held && item.updated_at > local.base)) return item;
  if (local.removed) return null;
  return { ...item, ...local.patch };
}

/** Отпечаток последнего сообщения строки: сменился и автор — клиент, значит клиент написал. */
export const lastSign = (item: InboxItem | undefined): string =>
  (item?.last ? `${item.last.author}|${item.last.at}|${item.last.kind}|${item.last.text}` : '');

/** Клиент написал после отпечатка `before` (L-1: «Решено» в окне отмены уже не к месту). */
export const clientWrote = (before: string, item: InboxItem | undefined): boolean =>
  item?.last?.author === 'client' && lastSign(item) !== before;
