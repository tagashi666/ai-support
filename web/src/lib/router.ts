/**
 * Маршруты на History API (план, 5.3 и 11.3): у каждого экрана свой адрес
 * под /next/. Системное «Назад» на телефоне идёт по шагам.
 */
import { signal } from '@preact/signals';

export type SectionKey = 'knowledge' | 'assistant' | 'reports' | 'connections' | 'team' | 'system' | 'device';

export type Route =
  | { name: 'home' }
  | { name: 'today' }
  | { name: 'chats'; id: string | null; client?: boolean }
  | { name: 'more' }
  /** sub — подраздел: /next/assistant/activity (6.7). */
  | { name: 'section'; key: SectionKey; sub?: string };

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const SECTIONS: readonly SectionKey[] = ['knowledge', 'assistant', 'reports', 'connections', 'team', 'system', 'device'];

export function parse(pathname: string): Route {
  const path = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  const parts = path.split('/').filter(Boolean);
  const [head, second, third] = parts;
  if (!head) return { name: 'home' };
  if (head === 'today') return { name: 'today' };
  if (head === 'chats') {
    const id = second ? decodeURIComponent(second) : null;
    return id && third === 'client' ? { name: 'chats', id, client: true } : { name: 'chats', id };
  }
  if (head === 'more') return { name: 'more' };
  if ((SECTIONS as readonly string[]).includes(head)) {
    return second ? { name: 'section', key: head as SectionKey, sub: decodeURIComponent(second) } : { name: 'section', key: head as SectionKey };
  }
  return { name: 'home' };
}

export function href(route: Route): string {
  switch (route.name) {
    case 'home': return `${BASE}/`;
    case 'today': return `${BASE}/today`;
    case 'chats': return route.id ? `${BASE}/chats/${encodeURIComponent(route.id)}${route.client ? '/client' : ''}` : `${BASE}/chats`;
    case 'more': return `${BASE}/more`;
    case 'section': return `${BASE}/${route.key}${route.sub ? `/${encodeURIComponent(route.sub)}` : ''}`;
  }
}

/**
 * Ссылка `/#c<id>` (уведомления в Telegram, 7.7) открывает нужный интерфейс:
 * с cookie ui=next сервер отправляет в /next/, а фрагмент адреса сохраняется.
 */
function initialRoute(): Route {
  const hashed = /^#c(\d{1,15})$/.exec(location.hash);
  if (!hashed) return parse(location.pathname);
  const next: Route = { name: 'chats', id: hashed[1] ?? null };
  history.replaceState(null, '', href(next));
  return next;
}

export const route = signal<Route>(initialRoute());

export function navigate(next: Route, replace = false): void {
  const url = href(next);
  if (url !== location.pathname) {
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }
  route.value = next;
}

addEventListener('popstate', () => { route.value = parse(location.pathname); });
