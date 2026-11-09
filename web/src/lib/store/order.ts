/**
 * Порядок списка и заморозка (план, 7.1). Всё здесь — чистые функции:
 * их проверяют тесты, а компонент списка только вызывает их.
 *
 * В рабочей панели ранг придёт с сервера готовым (src/shared/conversation-order.ts,
 * этап 2). В прототипе «сервер» — модуль demo, и ранг считает rankOf().
 */
import { reasonTier, SECTION_ORDER } from '@/lib/labels';
import type { Chat, Section } from '@/lib/types';

const KEY_MAX = 9_999_999_999_999;
const pad13 = (n: number): string => String(Math.max(0, Math.min(KEY_MAX, Math.round(n)))).padStart(13, '0');

/**
 * Ранг — строка `секция|ярус|ключ|id`, сравнивается как текст.
 * «Ждут вас»: ярус причины, затем кто дольше ждёт (время начала ожидания ↑).
 * Остальные секции: новые сверху (максимум минус активность).
 */
export function rankOf(chat: Chat): string {
  const section = SECTION_ORDER.indexOf(chat.section);
  const tier = chat.section === 'mine' ? reasonTier(chat.reason) : 0;
  const key = chat.section === 'mine'
    ? pad13(chat.waitingSince ?? chat.lastAt)
    : pad13(KEY_MAX - chat.lastAt);
  const id = pad13(KEY_MAX - Number.parseInt(chat.id.replace(/\D/g, '') || '0', 10));
  return `${section}|${tier}|${key}|${id}`;
}

export function serverOrder(chats: readonly Chat[]): Chat[] {
  return [...chats].sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
}

/** Строка в показанном порядке: под каким заголовком она стоит сейчас. */
export interface Placed {
  id: string;
  section: Section;
}

/** Индексы наибольшей возрастающей подпоследовательности: эти строки стоят на месте. */
function longestIncreasing(values: readonly number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i] ?? 0;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((values[tails[mid] ?? 0] ?? 0) < value) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? (tails[lo - 1] ?? -1) : -1;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  let at = tails.length > 0 ? (tails[tails.length - 1] ?? -1) : -1;
  while (at >= 0) { keep.add(at); at = prev[at] ?? -1; }
  return keep;
}

/**
 * Сколько изменений накопилось между показанным и серверным порядком:
 * новые строки + исчезнувшие + переезды (смена секции или места).
 * Переездов — минимальное число строк, которые надо передвинуть.
 */
export function pendingChanges(shown: readonly Placed[], server: readonly Placed[]): string[] {
  const serverIndex = new Map(server.map((entry, index) => [entry.id, index]));
  const shownIds = new Set(shown.map((entry) => entry.id));
  const changed: string[] = [];
  for (const entry of server) if (!shownIds.has(entry.id)) changed.push(entry.id);
  for (const entry of shown) if (!serverIndex.has(entry.id)) changed.push(entry.id);

  const common = shown.filter((entry) => serverIndex.has(entry.id));
  const moved = new Set<string>();
  for (const entry of common) {
    if (server[serverIndex.get(entry.id) ?? -1]?.section !== entry.section) moved.add(entry.id);
  }
  const stay = common.filter((entry) => !moved.has(entry.id));
  const keep = longestIncreasing(stay.map((entry) => serverIndex.get(entry.id) ?? 0));
  stay.forEach((entry, index) => { if (!keep.has(index)) moved.add(entry.id); });
  return [...changed, ...moved];
}

/**
 * Применить серверный порядок. Открытый диалог не уезжает (7.1 п.6): он
 * остаётся под прежним заголовком и рядом с прежним соседом сверху.
 */
export function applyServer(shown: readonly Placed[], server: readonly Placed[], pinnedId: string | null): Placed[] {
  const pinned = pinnedId ? shown.find((entry) => entry.id === pinnedId) : undefined;
  if (!pinned || !server.some((entry) => entry.id === pinnedId)) return [...server];
  const rest = server.filter((entry) => entry.id !== pinnedId);
  const before = shown.slice(0, shown.indexOf(pinned)).reverse().find((entry) =>
    entry.section === pinned.section && rest.some((other) => other.id === entry.id && other.section === pinned.section));
  const anchor = before ? rest.findIndex((entry) => entry.id === before.id) + 1
    : Math.max(0, rest.findIndex((entry) => SECTION_ORDER.indexOf(entry.section) >= SECTION_ORDER.indexOf(pinned.section)));
  const at = anchor < 0 ? rest.length : anchor;
  return [...rest.slice(0, at), pinned, ...rest.slice(at)];
}

/** Свои действия применяются сразу (7.1 п.5): строку убрать или вернуть на место. */
export function removeShown(shown: readonly Placed[], id: string): { list: Placed[]; index: number; entry?: Placed } {
  const index = shown.findIndex((entry) => entry.id === id);
  if (index < 0) return { list: [...shown], index: -1 };
  return { list: [...shown.slice(0, index), ...shown.slice(index + 1)], index, entry: shown[index] };
}

export function restoreShown(shown: readonly Placed[], entry: Placed, index: number): Placed[] {
  const without = shown.filter((other) => other.id !== entry.id);
  const at = Math.max(0, Math.min(index, without.length));
  return [...without.slice(0, at), entry, ...without.slice(at)];
}
