/**
 * Фильтр списка (план, 6.2): откуда, папки, ответственный, «только важные»,
 * «не нашли в базе подписчиков». Всё, по чему фильтруем, уже есть в строке
 * с сервера, поэтому фильтр работает на живых данных и не ломает заморозку.
 * Запоминается на устройстве.
 */
import type { InboxItem } from '@shared/api-types';

export interface ListFilter {
  source?: string;
  folder?: number;
  /** «Ответственный»: тот, кто вёл диалог последним (assignee), даже после конца закрепления. */
  assignee?: 'me' | 'none';
  important?: boolean;
  notFound?: boolean;
}

const KEY = 'next.chatsFilter';

export function filterItems(items: readonly InboxItem[], filter: ListFilter, me: string): InboxItem[] {
  if (filterSize(filter) === 0) return items as InboxItem[];
  return items.filter((item) => {
    if (filter.source && item.source?.id !== filter.source) return false;
    if (filter.folder !== undefined && !item.folder_ids.includes(filter.folder)) return false;
    if (filter.assignee === 'me' && item.assignee?.id !== me) return false;
    if (filter.assignee === 'none' && item.assignee !== null) return false;
    if (filter.important && !item.flags.important) return false;
    if (filter.notFound && !item.flags.not_found) return false;
    return true;
  });
}

export const filterSize = (filter: ListFilter): number =>
  [filter.source, filter.folder, filter.assignee, filter.important || undefined, filter.notFound || undefined]
    .filter((value) => value !== undefined).length;

export function readFilter(): ListFilter {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) as ListFilter : {};
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch { return {}; }
}

export function saveFilter(filter: ListFilter): void {
  try { localStorage.setItem(KEY, JSON.stringify(filter)); } catch { /* фильтр живёт до перезагрузки */ }
}
