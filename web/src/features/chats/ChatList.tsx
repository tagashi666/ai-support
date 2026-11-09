import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t, tn } from '@/i18n/ru';
import { sectionLabel } from '@/lib/labels';
import { useFrozenList } from '@/lib/hooks/useFrozenList';
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
  // Свежий экран показывает свежий порядок.
  useEffect(() => { applyPending(); }, []);
  const list = useFrozenList({
    pendingKey: pending.value.join(','),
    apply: applyPending,
    shown: shown.value,
    onFrozen: (value) => { listFrozen.value = value; },
  });
  const { scroller } = list;

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
    const next = list.onRowKey(event);
    if (next) setActive(next);
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
        {...list.handlers}
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
            list.applyNow();
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
