/**
 * Живой список: чистые функции слияния снимка и кадров (план, 7.1 правило 7
 * и 11.3). Порядок и секцию считает сервер; здесь только вставка по рангу.
 *
 * Каждая строка помнит seq, с которым пришла: снимок /api/inbox — свой seq,
 * кадр — свой. Кадр не старше известного применяется; запись с меньшим
 * updated_at отбрасывается (старое не затирает новое).
 */
import type { InboxCounts, InboxItem, LiveFrame } from '@shared/api-types';
import type { Section } from '@shared/attention';

export interface LiveEntry {
  item: InboxItem;
  seq: number;
}

export interface InboxState {
  entries: ReadonlyMap<number, LiveEntry>;
  /** Снятые строки и seq снятия: запоздавший старый кадр строку не вернёт. */
  gone: ReadonlyMap<number, number>;
  /** seq последнего снимка: кадр не новее уже учтён в снимке и не применяется. */
  base: number;
  counts: InboxCounts | null;
}

export const emptyInbox = (): InboxState => ({ entries: new Map(), gone: new Map(), base: 0, counts: null });

/**
 * Снимок поверх известного. Строки снимка берутся как есть; строка, которой
 * в снимке нет, удаляется, кроме пришедших кадром после снимка (их seq больше).
 * `scope` — какие секции покрывает снимок: строки других секций не трогаются.
 */
export function mergeSnapshot(state: InboxState, items: readonly InboxItem[], seq: number, counts: InboxCounts | null,
  scope?: ReadonlySet<Section>, base = seq): InboxState {
  const entries = new Map<number, LiveEntry>();
  for (const [id, entry] of state.entries) {
    const covered = !scope || scope.has(entry.item.section);
    if (!covered || entry.seq > seq) entries.set(id, entry);
  }
  const gone = new Map([...state.gone].filter(([, removedAt]) => removedAt > base));
  for (const item of items) {
    const known = entries.get(item.id);
    if ((known && known.seq > seq) || (gone.get(item.id) ?? -1) > seq) continue;
    entries.set(item.id, { item, seq });
  }
  return { entries, gone, base, counts: counts ?? state.counts };
}

/** Пачка кадров по порядку seq. Возвращает тот же объект, если ничего не изменилось. */
export function applyFrames(state: InboxState, frames: readonly LiveFrame[], counts?: InboxCounts): InboxState {
  let entries: Map<number, LiveEntry> | null = null;
  let gone: Map<number, number> | null = null;
  const current = (): ReadonlyMap<number, LiveEntry> => entries ?? state.entries;
  for (const frame of frames) {
    if (frame.seq <= state.base) continue;
    if (frame.type === 'inbox_item') {
      const known = current().get(frame.item.id);
      if (known && (known.seq >= frame.seq || known.item.updated_at > frame.item.updated_at)) continue;
      if (((gone ?? state.gone).get(frame.item.id) ?? -1) >= frame.seq) continue;
      (entries ??= new Map(state.entries)).set(frame.item.id, { item: frame.item, seq: frame.seq });
    } else if (frame.type === 'inbox_remove') {
      const known = current().get(frame.id);
      if (known && known.seq >= frame.seq) continue;
      if (((gone ?? state.gone).get(frame.id) ?? -1) >= frame.seq) continue;
      if (known) (entries ??= new Map(state.entries)).delete(frame.id);
      (gone ??= new Map(state.gone)).set(frame.id, frame.seq);
    }
  }
  const lastCounts = counts ?? [...frames].reverse().find((frame): frame is Extract<LiveFrame, { counts?: InboxCounts }> =>
    (frame.type === 'inbox_item' || frame.type === 'inbox_remove') && frame.counts !== undefined)?.counts;
  if (!entries && !gone && !lastCounts) return state;
  return { ...state, entries: entries ?? state.entries, gone: gone ?? state.gone, counts: lastCounts ?? state.counts };
}

/** Строки в серверном порядке: ранг сравнивается как текст. */
export function ordered(state: InboxState): InboxItem[] {
  return [...state.entries.values()].map((entry) => entry.item).sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
}
