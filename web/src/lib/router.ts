/**
 * Маршруты на History API (план, 5.3 и 11.3): у каждого экрана свой адрес
 * под /next/. Системное «Назад» на телефоне идёт по шагам.
 */
import { signal } from '@preact/signals';

export type SectionKey = 'knowledge' | 'assistant' | 'reports' | 'connections' | 'team' | 'system' | 'device';

export type Route =
  | { name: 'home' }
  | { name: 'today' }
  | { name: 'chats'; id: string | null }
  | { name: 'more' }
  | { name: 'section'; key: SectionKey };

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const SECTIONS: readonly SectionKey[] = ['knowledge', 'assistant', 'reports', 'connections', 'team', 'system', 'device'];

export function parse(pathname: string): Route {
  const path = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  const parts = path.split('/').filter(Boolean);
  const [head, second] = parts;
  if (!head) return { name: 'home' };
  if (head === 'today') return { name: 'today' };
  if (head === 'chats') return { name: 'chats', id: second ? decodeURIComponent(second) : null };
  if (head === 'more') return { name: 'more' };
  if ((SECTIONS as readonly string[]).includes(head)) return { name: 'section', key: head as SectionKey };
  return { name: 'home' };
}

export function href(route: Route): string {
  switch (route.name) {
    case 'home': return `${BASE}/`;
    case 'today': return `${BASE}/today`;
    case 'chats': return route.id ? `${BASE}/chats/${encodeURIComponent(route.id)}` : `${BASE}/chats`;
    case 'more': return `${BASE}/more`;
    case 'section': return `${BASE}/${route.key}`;
  }
}

export const route = signal<Route>(parse(location.pathname));

export function navigate(next: Route, replace = false): void {
  const url = href(next);
  if (url !== location.pathname) {
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }
  route.value = next;
}

addEventListener('popstate', () => { route.value = parse(location.pathname); });
