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
  if (!local || item.updated_at > local.base) return item;
  if (local.removed) return null;
  return { ...item, ...local.patch };
}

/** Заплатки, которые сервер уже перекрыл более новой версией, — снять. */
export function prunePatches(items: readonly InboxItem[]): void {
  const map = patches.peek();
  if (map.size === 0) return;
  const stale = items.filter((item) => (map.get(item.id)?.base ?? Infinity) < item.updated_at).map((item) => item.id);
  if (stale.length === 0) return;
  const next = new Map(map);
  for (const id of stale) next.delete(id);
  patches.value = next;
}
