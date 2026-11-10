/**
 * Уведомления в панели (план, 7.7): только о том, что требует человека —
 * диалог вошёл в «Ждут вас» (один раз на вход). Заголовок вкладки «(2) …»,
 * точка на значке, тост «Анна К. ждёт вас · Открыть», если вы не в
 * «Диалогах», звук (6.12) и уведомление браузера, если вкладка скрыта и это
 * включено в «Этом устройстве». Учебный диалог ни в одном счётчике нет.
 */
import { useEffect, useRef } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { showToast } from '@/lib/actions/toasts';
import { browserNotify, playWaitSound, waitSound } from '@/lib/device';
import { liveName } from '@/lib/live/labels';
import { liveItems, liveMine, loading, mode } from '@/lib/live/store';
import { navigate, route } from '@/lib/router';

const BASE_TITLE = typeof document === 'undefined' ? '' : document.title;
let baseIcon: string | null = null;

/** Значок с точкой: тот же квадрат и точка внимания в углу (data: — разрешён CSP img-src). */
const DOT_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2563EB"/><path d="M9 11.5c0-1.4 1.1-2.5 2.5-2.5h9c1.4 0 2.5 1.1 2.5 2.5v6c0 1.4-1.1 2.5-2.5 2.5H15l-4 3.5V20h0c-1.1-.2-2-1.2-2-2.4z" fill="#fff"/><circle cx="25" cy="7" r="6.5" fill="#E5484D" stroke="#fff" stroke-width="1.5"/></svg>')}`;

export function tabTitle(mine: number, base = BASE_TITLE): string { return mine > 0 ? `(${mine}) ${base}` : base; }

function setIcon(dot: boolean): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  baseIcon ??= link.getAttribute('href');
  const next = dot ? DOT_ICON : baseIcon ?? '';
  if (link.getAttribute('href') !== next) link.setAttribute('href', next);
}

export function useAttention(): void {
  const live = mode.value === 'live';
  const mine = live ? liveMine.value : 0;
  const ready = loading.value === 'ready';
  const known = useRef<Set<number> | null>(null);
  const last = useRef<number | null>(null);

  useEffect(() => {
    document.title = tabTitle(mine);
    setIcon(mine > 0);
    if (live && waitSound.peek() && last.current !== null && mine > last.current) playWaitSound();
    last.current = live ? mine : null;
  }, [mine, live]);

  const items = liveItems.value;
  useEffect(() => {
    if (!live || !ready) { known.current = null; return; }
    const waiting = items.filter((item) => item.section === 'mine');
    const ids = new Set(waiting.map((item) => item.id));
    const before = known.current;
    known.current = ids;
    if (!before) return;
    const fresh = waiting.filter((item) => !before.has(item.id));
    if (!fresh.length) return;
    const where = route.peek();
    const first = fresh[0]!;
    const open = (): void => navigate({ name: 'chats', id: String(first.id) });
    if (where.name !== 'chats') {
      showToast(fresh.length === 1
        ? { text: t('notify.waits', { name: liveName(first) }), action: { label: t('notify.open'), run: open } }
        : { text: t('notify.waitsMany', { n: fresh.length }), action: { label: t('notify.open'), run: () => navigate({ name: 'chats', id: null }) } });
    }
    if (browserNotify.peek() && document.visibilityState === 'hidden' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        const note = new Notification(fresh.length === 1 ? t('notify.waits', { name: liveName(first) }) : t('notify.waitsMany', { n: fresh.length }),
          { tag: `waits-${first.id}`, body: fresh.length === 1 ? first.last?.text ?? '' : '' });
        note.onclick = () => { focus(); open(); note.close(); };
      } catch { /* браузер без конструктора Notification (Android Chrome) — только тост и звук */ }
    }
  }, [items, live, ready]);
}
