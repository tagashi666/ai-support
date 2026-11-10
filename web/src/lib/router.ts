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
  /** sub — подраздел: /next/assistant/activity (6.7); item — статья или идея: /next/knowledge/articles/<имя> (6.6). */
  | { name: 'section'; key: SectionKey; sub?: string; item?: string };

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const SECTIONS: readonly SectionKey[] = ['knowledge', 'assistant', 'reports', 'connections', 'team', 'system', 'device'];

export function parse(pathname: string): Route {
  const path = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  const parts = path.split('/').filter(Boolean);
  const [head, second, third] = parts;
  const decode = (value: string): string => { try { return decodeURIComponent(value); } catch { return value; } };
  if (!head) return { name: 'home' };
  if (head === 'today') return { name: 'today' };
  if (head === 'chats') {
    const id = second ? decodeURIComponent(second) : null;
    return id && third === 'client' ? { name: 'chats', id, client: true } : { name: 'chats', id };
  }
  if (head === 'more') return { name: 'more' };
  if ((SECTIONS as readonly string[]).includes(head)) {
    if (!second) return { name: 'section', key: head as SectionKey };
    return third ? { name: 'section', key: head as SectionKey, sub: decode(second), item: decode(third) } : { name: 'section', key: head as SectionKey, sub: decode(second) };
  }
  return { name: 'home' };
}

export function href(route: Route): string {
  switch (route.name) {
    case 'home': return `${BASE}/`;
    case 'today': return `${BASE}/today`;
    case 'chats': return route.id ? `${BASE}/chats/${encodeURIComponent(route.id)}${route.client ? '/client' : ''}` : `${BASE}/chats`;
    case 'more': return `${BASE}/more`;
    case 'section': return `${BASE}/${route.key}${route.sub ? `/${encodeURIComponent(route.sub)}${route.item ? `/${encodeURIComponent(route.item)}` : ''}` : ''}`;
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

/**
 * Страж ухода (6.6, inv-manage P1-5): редактор с несохранённым текстом
 * возвращает false и сам спрашивает «Сохранить как черновик / Не сохранять /
 * Остаться», а потом повторяет переход с force.
 */
type Guard = (next: Route) => boolean;
let guard: Guard | null = null;
export function setLeaveGuard(next: Guard | null): void { guard = next; }

export function navigate(next: Route, replace = false, force = false): void {
  if (!force && guard && !guard(next)) return;
  const url = href(next);
  if (url !== location.pathname) {
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }
  route.value = next;
}

addEventListener('popstate', () => {
  const next = parse(location.pathname);
  if (guard && !guard(next)) {
    // «Назад» с несохранённым: адрес возвращаем, вопрос задаёт редактор.
    history.pushState(null, '', href(route.value));
    return;
  }
  route.value = next;
});
