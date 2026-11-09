import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t, tn } from '@/i18n/ru';
import { sectionLabel } from '@/lib/labels';
import { reducedMotion } from '@/lib/media';
import { navigate } from '@/lib/router';
import {
  aiLeads, applyPending, byId, composerText, listFrozen, pending, pendingUrgent, shown, waitingYou,
} from '@/lib/store/state';
import type { Chat, Section } from '@/lib/types';
import { Icon } from '@/ui/Icon';
import { Tabs } from '@/ui/Tabs';
import { ChatRow, previewOf } from './ChatRow';
import { StatusLine } from './StatusLine';
import s from './chats.module.css';

type View = 'waiting' | 'open' | 'done';
const VIEW_SECTIONS: Record<View, readonly Section[]> = {
  waiting: ['mine'],
  open: ['mine', 'colleagues', 'ai', 'client'],
  done: ['done'],
};
const CALM_MS = 1500;
const SCROLL_SETTLE_MS = 1000;

const readView = (): View => {
  try {
    const value = localStorage.getItem('next.chatsView');
    return value === 'waiting' || value === 'done' ? value : 'open';
  } catch {
    return 'open';
  }
};

const matches = (chat: Chat, query: string, draft: string): boolean => {
  if (!query) return true;
  const needle = query.toLocaleLowerCase('ru');
  return chat.name.toLocaleLowerCase('ru').includes(needle)
    || previewOf(chat, draft).text.toLocaleLowerCase('ru').includes(needle);
};

/**
 * Список диалогов (6.2, 7.1). Строки — компоненты с ключом id, порядок
 * меняется только в спокойный момент: пока курсор, палец или фокус на списке,
 * изменения копятся в пилюле «↓ N обновлений» поверх нижнего края.
 */
export function ChatList({ openId }: { openId: string | null }): JSX.Element {
  const [view, setView] = useState<View>(readView);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Partial<Record<Section, boolean>>>({});
  const [active, setActive] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const freeze = useRef({ hover: false, focus: false, touch: false, scrollAt: 0 });
  const flipFrom = useRef<Map<string, number> | null>(null);

  const recompute = (): void => {
    const f = freeze.current;
    const scrolled = (scroller.current?.scrollTop ?? 0) > 8;
    listFrozen.value = f.hover || f.focus || f.touch || Date.now() - f.scrollAt < SCROLL_SETTLE_MS || scrolled;
  };

  // Свежий экран показывает свежий порядок; уход со списка снимает заморозку.
  useEffect(() => {
    applyPending();
    return () => { listFrozen.value = false; };
  }, []);

  const applyWithFlip = (): void => {
    const rows = scroller.current?.querySelectorAll<HTMLElement>('[data-row-id]') ?? [];
    const before = new Map<string, number>();
    rows.forEach((row) => before.set(row.dataset.rowId ?? '', row.getBoundingClientRect().top));
    flipFrom.current = before;
    applyPending();
  };

  // Спокойный момент: 1,5 с без условий заморозки, список наверху, вкладка видна (7.1 п.4).
  const pendingKey = pending.value.join(',');
  useEffect(() => {
    if (!pendingKey || listFrozen.value) return undefined;
    const timer = setTimeout(() => {
      recompute();
      if (!listFrozen.peek() && document.visibilityState === 'visible') applyWithFlip();
    }, CALM_MS);
    return () => clearTimeout(timer);
  }, [pendingKey, listFrozen.value]);

  // FLIP: строки переезжают 200 мс только через transform; при «меньше движения» — подсветка.
  useLayoutEffect(() => {
    const before = flipFrom.current;
    if (!before) return;
    flipFrom.current = null;
    const rows = scroller.current?.querySelectorAll<HTMLElement>('[data-row-id]') ?? [];
    rows.forEach((row) => {
      const id = row.dataset.rowId ?? '';
      const top = row.getBoundingClientRect().top;
      const was = before.get(id);
      if (reducedMotion.value) {
        if (was === undefined || Math.abs(was - top) > 1) {
          row.dataset.flash = 'true';
          setTimeout(() => { delete row.dataset.flash; }, 1000);
        }
        return;
      }
      if (was === undefined) {
        row.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
          { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
      } else if (Math.abs(was - top) > 1) {
        row.animate([{ transform: `translateY(${was - top}px)` }, { transform: 'none' }],
          { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    });
  }, [shown.value]);

  const changeView = (next: View): void => {
    setView(next);
    try { localStorage.setItem('next.chatsView', next); } catch { /* без хранилища тоже работает */ }
  };

  const drafts = composerText.value;
  const sections = VIEW_SECTIONS[view].map((section) => {
    const items = shown.value
      .filter((entry) => entry.section === section)
      .map((entry) => byId.value.get(entry.id))
      .filter((chat): chat is Chat => chat !== undefined && matches(chat, query.trim(), drafts[chat.id] ?? ''));
    return { section, items };
  });
  const visible = sections.flatMap((group) => (collapsed[group.section] ?? (group.section === 'client' && group.items.length > 5) ? [] : group.items));
  const focusId = active && visible.some((chat) => chat.id === active) ? active
    : openId && visible.some((chat) => chat.id === openId) ? openId : visible[0]?.id ?? null;

  const onRowKey = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const rows = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-row-id]') ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? rows[0] : event.key === 'End' ? rows[rows.length - 1]
      : rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      setActive(next.dataset.rowId ?? null);
      next.focus();
    }
  };

  const count = pending.value.length;
  const nothing = visible.length === 0 && sections.every((group) => group.items.length === 0);

  return (
    <div class={s.list}>
      <StatusLine />
      <header class={s.listHead}>
        <h1 class={s.title}>{t('chats.title')}</h1>
        <label class={s.search}>
          <Icon name="search" size={18} />
          <input
            id="chat-search"
            type="search"
            placeholder={t('chats.search')}
            aria-label={t('chats.search')}
            value={query}
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
            onKeyDown={(event) => { if (event.key === 'Escape') setQuery(''); }}
          />
        </label>
        <Tabs<View>
          label={t('chats.views')}
          stretch
          value={view}
          onChange={changeView}
          items={[
            { value: 'waiting', label: t('chats.view.waiting'), count: waitingYou.value.length },
            { value: 'open', label: t('chats.view.open') },
            { value: 'done', label: t('chats.view.done') },
          ]}
        />
      </header>
      <div
        class={s.scroller}
        ref={scroller}
        onMouseEnter={() => { freeze.current.hover = true; recompute(); }}
        onMouseLeave={() => { freeze.current.hover = false; recompute(); }}
        onFocusIn={() => { freeze.current.focus = true; recompute(); }}
        onFocusOut={(event) => {
          if (!scroller.current?.contains(event.relatedTarget as Node | null)) { freeze.current.focus = false; recompute(); }
        }}
        onTouchStart={() => { freeze.current.touch = true; recompute(); }}
        onTouchEnd={() => {
          freeze.current.touch = false;
          freeze.current.scrollAt = Date.now();
          recompute();
          setTimeout(recompute, SCROLL_SETTLE_MS + 50);
        }}
        onScroll={() => {
          freeze.current.scrollAt = Date.now();
          recompute();
          setTimeout(recompute, SCROLL_SETTLE_MS + 50);
        }}
      >
        {nothing && (
          <div class={s.empty}>
            {query ? (
              <>
                <p>{t('chats.nothingFound', { q: query })}</p>
                <button type="button" class={s.emptyAction} onClick={() => setQuery('')}>{t('chats.clear')}</button>
              </>
            ) : view === 'waiting' ? (
              <>
                <p>{t('chats.nobodyWaits', { n: aiLeads.value.length, dialogs: tn('plural.dialogs', aiLeads.value.length) })}</p>
                <button type="button" class={s.emptyAction} onClick={() => changeView('open')}>{t('chats.view.open')}</button>
              </>
            ) : <p>{t('chats.noneDone')}</p>}
          </div>
        )}
        {sections.map(({ section, items }) => {
          if (items.length === 0) return null;
          const isCollapsed = collapsed[section] ?? (section === 'client' && items.length > 5);
          const headId = `sec-${section}`;
          return (
            <section key={section} class={s.section} aria-labelledby={headId}>
              <h2 class={s.sectionHead} id={headId}>
                <button
                  type="button"
                  class={s.sectionToggle}
                  aria-expanded={!isCollapsed}
                  aria-label={`${sectionLabel(section)} · ${items.length}. ${isCollapsed ? t('chats.expand') : t('chats.collapse')}`}
                  onClick={() => setCollapsed({ ...collapsed, [section]: !isCollapsed })}
                >
                  <span>{sectionLabel(section)}</span>
                  <span class={`${s.sectionCount} num`} data-tone={section === 'mine' ? 'attention' : undefined}>{items.length}</span>
                  <Icon name="down" size={16} class={isCollapsed ? s.chevronClosed : s.chevron} />
                </button>
              </h2>
              {section === 'mine' && !isCollapsed && <p class={s.sectionHint}>{t('chats.mineHint')}</p>}
              {!isCollapsed && (
                <div class={s.rows}>
                  {items.map((chat) => (
                    <ChatRow
                      key={chat.id}
                      chat={chat}
                      current={chat.id === openId}
                      tabIndex={chat.id === focusId ? 0 : -1}
                      onOpen={() => { setActive(chat.id); navigate({ name: 'chats', id: chat.id }); }}
                      onKeyDown={onRowKey}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {count > 0 && (
        <button
          type="button"
          class={s.pill}
          data-tone={pendingUrgent.value ? 'attention' : undefined}
          title={t('chats.updatesLabel')}
          onClick={() => {
            applyWithFlip();
            scroller.current?.scrollTo({ top: 0, behavior: reducedMotion.value ? 'auto' : 'smooth' });
          }}
        >
          <Icon name={pendingUrgent.value ? 'urgent' : 'arrowDown'} size={16} />
          <span class="num">{t('chats.updates', { n: count, updates: tn('plural.updates', count) })}</span>
        </button>
      )}
    </div>
  );
}
