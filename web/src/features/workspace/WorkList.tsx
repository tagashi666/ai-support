import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { InboxItem, InboxResponse } from '@shared/api-types';
import type { Section } from '@shared/attention';
import { ConnectionLine } from '@/features/live/ConnectionLine';
import { t, tn } from '@/i18n/ru';
import { listTime } from '@/lib/format/format';
import { useFrozenList } from '@/lib/hooks/useFrozenList';
import { sectionLabel } from '@/lib/labels';
import { getJson, readToken } from '@/lib/live/api';
import { isUrgentCode, liveChannel, liveName, livePreview, liveReasonView } from '@/lib/live/labels';
import { bootstrap, liveCounts, liveItems, loadError, loading, startLive } from '@/lib/live/store';
import { isSplit, reducedMotion } from '@/lib/media';
import { navigate } from '@/lib/router';
import { applyServer, pendingChanges, removeShown, type Placed } from '@/lib/store/order';
import { now } from '@/lib/store/state';
import { drafts, hide, markRead, permissions, resolve, setImportant } from '@/lib/workspace/actions';
import { filterItems, filterSize, readFilter, saveFilter, type ListFilter } from '@/lib/workspace/filter';
import { patched, patches } from '@/lib/workspace/local';
import { viewLabel } from '@/lib/workspace/labels';
import { availability } from '@/lib/workspace/registry';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Row } from '@/ui/Row';
import { Option, Sheet, sheetStyles } from '@/ui/Sheet';
import { Tabs } from '@/ui/Tabs';
import s from '@/features/chats/chats.module.css';
import { FilterSheet } from './FilterSheet';
import w from './workspace.module.css';

type View = 'waiting' | 'open' | 'done';
const VIEW_SECTIONS: Record<View, readonly Section[]> = {
  waiting: ['mine'],
  open: ['mine', 'colleagues', 'ai', 'client'],
  done: ['done'],
};
const SERVER_VIEW: Record<View, string> = { waiting: 'waiting', open: 'open', done: 'resolved' };
const VIEW_KEY = 'next.chatsView';
const SEARCH_MS = 250;

const readView = (): View => {
  try {
    const value = localStorage.getItem(VIEW_KEY);
    return value === 'waiting' || value === 'done' ? value : 'open';
  } catch { return 'open'; }
};

/** Строка с меню «⋯»: на компьютере видно при наведении и фокусе, на телефоне — всегда (цель 44 px). */
function WorkRow({ item, current, tabIndex, onKeyDown, onMenu }: {
  item: InboxItem; current: boolean; tabIndex: number; onKeyDown: (event: KeyboardEvent) => void; onMenu: () => void;
}): JSX.Element {
  const at = now.value;
  const reason = liveReasonView(item, at);
  const own = drafts.get(item.id);
  const preview = own.text.trim() && own.mode === 'reply' ? { who: t('preview.draft'), text: own.text } : livePreview(item);
  const name = liveName(item);
  return (
    <div class={w.rowWrap} data-row-id={String(item.id)}>
      <Row
        id={String(item.id)}
        wrapped
        avatar={<Avatar name={name} channel={liveChannel(item)} />}
        title={name}
        time={listTime(item.activity_at, at)}
        who={preview.who}
        preview={preview.text}
        reason={reason.text}
        tone={reason.tone}
        unread={item.unread > 0}
        current={current}
        tabIndex={tabIndex}
        onOpen={() => { markRead(item.id); navigate({ name: 'chats', id: String(item.id) }); }}
        onKeyDown={onKeyDown}
      />
      <button type="button" class={w.rowMenu} aria-label={t('list.rowMenu', { name })} aria-haspopup="dialog" tabIndex={tabIndex} onClick={onMenu}>
        <Icon name="more" size={20} />
      </button>
    </div>
  );
}

/** Внешняя заявка: «Решено» из списка закрывает её, не открыв диалог, — ярус 2 (7.6). */
const isTicket = (item: InboxItem): boolean => item.channel === 'bedolaga' || item.channel === 'minishop';

/**
 * Рабочий список «Диалоги» (6.2, 7.1). Порядок и секции — с сервера; список
 * стоит, пока курсор, палец или фокус на нём, а изменения копятся в пилюле.
 * Свои действия (Решено, Убрать) применяются сразу. Открытый диалог не уезжает.
 */
export function WorkList({ openId }: { openId: number | null }): JSX.Element {
  const [view, setView] = useState<View>(readView);
  const [collapsed, setCollapsed] = useState<Partial<Record<Section, boolean>>>({});
  const [active, setActive] = useState<string | null>(null);
  const [filter, setFilter] = useState<ListFilter>(readFilter);
  const [sheet, setSheet] = useState<'filter' | { row: number } | { confirmResolve: number } | null>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ q: string; ids: number[]; items: Map<number, InboxItem> } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const map = patches.value;
  const items = useMemo(() => filterItems(liveItems.value.map((item) => patched(item, map)).filter((item): item is InboxItem => item !== null),
    filter, bootstrap.value?.me.id ?? ''), [liveItems.value, map, filter]);
  const byId = useMemo(() => new Map(items.map((item) => [String(item.id), item])), [items]);
  const server = useMemo<Placed[]>(() => items.map((item) => ({ id: String(item.id), section: item.section })), [items]);
  const [shown, setShown] = useState<Placed[]>(server);
  const pinned = openId !== null ? String(openId) : null;
  const target = applyServer(shown, server, pinned);
  const pending = pendingChanges(shown, target);
  const pendingUrgent = pending.some((id) => {
    const item = byId.get(id);
    return item !== undefined && item.section === 'mine' && isUrgentCode(item.reason.code);
  });
  const list = useFrozenList({ pendingKey: pending.join(','), apply: () => setShown(target), shown });

  // Первый снимок — сразу; свои действия (заплатки) и смена фильтра — сразу (7.1 п.5).
  useEffect(() => { if (shown.length === 0 && server.length > 0) setShown(server); }, [server]);
  useEffect(() => { list.applyNow(); }, [map, filter]);
  useEffect(() => { list.hold(sheet !== null); }, [sheet]);

  // Поиск на сервере в текущем виде (/api/inbox?q=); строки дальше обновляются живыми кадрами.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setFound(null); return undefined; }
    const timer = setTimeout(() => {
      void getJson<InboxResponse>(`/api/inbox?view=${SERVER_VIEW[view]}&q=${encodeURIComponent(q)}&limit=100`, readToken() ?? '')
        .then((response) => setFound({ q, ids: response.items.map((item) => item.id), items: new Map(response.items.map((item) => [item.id, item])) }))
        .catch(() => setFound({ q, ids: [], items: new Map() }));
    }, SEARCH_MS);
    return () => clearTimeout(timer);
  }, [query, view]);

  // «/» — к поиску (7.3), если фокус не в поле ввода.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (event.key !== '/' || event.metaKey || event.ctrlKey || target?.closest('input, textarea, [contenteditable="true"], dialog')) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const changeView = (next: View): void => {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* без хранилища выбор живёт до перезагрузки */ }
  };
  const changeFilter = (next: ListFilter): void => { setFilter(next); saveFilter(next); };

  const counts = liveCounts.value;
  const sections = VIEW_SECTIONS[view].map((section) => ({
    section,
    rows: shown.filter((entry) => entry.section === section)
      .map((entry) => byId.get(entry.id))
      .filter((item): item is InboxItem => item !== undefined),
  }));
  const searchRows = found ? found.ids
    .map((id) => byId.get(String(id)) ?? patched(found.items.get(id)!, map))
    .filter((item): item is InboxItem => item !== null && item !== undefined) : null;
  const isCollapsed = (section: Section, size: number): boolean => collapsed[section] ?? (section === 'client' && size > 5);
  const visible = searchRows ?? sections.flatMap((group) => (isCollapsed(group.section, group.rows.length) ? [] : group.rows));
  const focusId = active && visible.some((item) => String(item.id) === active) ? active
    : pinned && visible.some((item) => String(item.id) === pinned) ? pinned : visible[0] ? String(visible[0].id) : null;
  const onRowKey = (event: KeyboardEvent): void => { const next = list.onRowKey(event); if (next) setActive(next); };

  const rowItem = sheet && typeof sheet === 'object' && 'row' in sheet ? itemFor(sheet.row) : undefined;
  function itemFor(id: number): InboxItem | undefined { return byId.get(String(id)) ?? found?.items.get(id); }
  const close = (): void => setSheet(null);
  const perms = permissions.value;
  const can = (id: Parameters<typeof availability>[0]): boolean => availability(id, perms) === 'show';

  /** Своё действие убирает строку сразу, «Отменить» вернёт её на то же место (заплатка). */
  const resolveRow = (item: InboxItem): void => {
    close();
    if (isTicket(item)) { setSheet({ confirmResolve: item.id }); return; }
    setShown(removeShown(shown, String(item.id)).list);
    resolve(item.id);
  };

  const nothing = (searchRows ?? sections.flatMap((group) => group.rows)).length === 0;
  const state = loading.value;
  const activeFilters = filterSize(filter);
  const confirmItem = sheet && typeof sheet === 'object' && 'confirmResolve' in sheet ? itemFor(sheet.confirmResolve) : undefined;

  const renderRow = (item: InboxItem): JSX.Element => (
    <WorkRow key={item.id} item={item} current={String(item.id) === pinned} tabIndex={String(item.id) === focusId ? 0 : -1}
      onKeyDown={onRowKey} onMenu={() => setSheet({ row: item.id })} />
  );

  return (
    <div class={s.list}>
      <ConnectionLine />
      <header class={s.listHead}>
        <div class={w.titleRow}>
          <h1 class={s.title}>{t('chats.title')}</h1>
          <Button variant="quiet" size="sm" icon="filter" aria-haspopup="dialog" onClick={() => setSheet('filter')}>
            {activeFilters > 0 ? t('filter.buttonActive', { n: activeFilters }) : t('filter.button')}
          </Button>
        </div>
        <label class={s.search}>
          <Icon name="search" size={18} />
          <input
            ref={searchRef}
            id="chat-search"
            type="search"
            placeholder={t('list.searchPlaceholder')}
            aria-label={t('list.searchPlaceholder')}
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
            { value: 'waiting', label: t('chats.view.waiting'), count: counts?.sections.mine ?? 0 },
            { value: 'open', label: t('chats.view.open') },
            { value: 'done', label: t('chats.view.done') },
          ]}
        />
      </header>
      <div class={s.scroller} ref={list.scroller} aria-busy={state === 'loading' ? 'true' : 'false'} {...list.handlers}>
        {state === 'loading' && nothing && (
          <div class={w.skeletons} aria-label={t('live.loading')}>
            {Array.from({ length: 8 }, (_, index) => <div key={index} class={w.skeletonRow} />)}
          </div>
        )}
        {state === 'error' && (
          <div class={s.empty} role="alert">
            <p><b>{t('live.error')}</b> · {t('live.errorHint')}</p>
            <p class={w.code}>{t('live.code', { code: loadError.value ?? '' })}</p>
            <Button variant="secondary" size="sm" onClick={() => { void startLive(); }}>{t('live.retry')}</Button>
          </div>
        )}
        {state === 'ready' && nothing && (
          <div class={s.empty}>
            {found ? (
              <>
                <p>{t('list.nothingFound', { q: found.q, view: viewLabel(view) })}</p>
                <button type="button" class={s.emptyAction} onClick={() => setQuery('')}>{t('chats.clear')}</button>
              </>
            ) : activeFilters > 0 ? (
              <>
                <p>{t('filter.empty')}</p>
                <button type="button" class={s.emptyAction} onClick={() => changeFilter({})}>{t('filter.reset')}</button>
              </>
            ) : view === 'waiting' ? (
              <>
                <p>{t('chats.nobodyWaits', { n: counts?.sections.ai ?? 0, dialogs: tn('plural.dialogs', counts?.sections.ai ?? 0) })}</p>
                <button type="button" class={s.emptyAction} onClick={() => changeView('open')}>{t('chats.view.open')}</button>
              </>
            ) : view === 'done' ? <p>{t('chats.noneDone')}</p> : <p>{t('list.quiet')}</p>}
          </div>
        )}
        {searchRows ? (
          searchRows.length > 0 && (
            <section class={s.section} aria-label={t('list.found', { n: searchRows.length })}>
              <p class={s.sectionHint}>{t('list.found', { n: searchRows.length })}</p>
              <div class={s.rows}>{searchRows.map(renderRow)}</div>
            </section>
          )
        ) : sections.map(({ section, rows }) => {
          if (rows.length === 0) return null;
          const closed = isCollapsed(section, rows.length);
          const headId = `work-sec-${section}`;
          const total = section === 'done' || activeFilters > 0 ? rows.length : counts?.sections[section] ?? rows.length;
          return (
            <section key={section} class={s.section} aria-labelledby={headId}>
              <h2 class={s.sectionHead} id={headId}>
                <button type="button" class={s.sectionToggle} aria-expanded={!closed}
                  onClick={() => setCollapsed({ ...collapsed, [section]: !closed })}>
                  <span>{sectionLabel(section)}</span>
                  <span class={`${s.sectionCount} num`} data-tone={section === 'mine' ? 'attention' : undefined}>{total}</span>
                  <Icon name="down" size={16} class={closed ? s.chevronClosed : s.chevron} />
                </button>
              </h2>
              {section === 'mine' && !closed && <p class={s.sectionHint}>{t('chats.mineHint')}</p>}
              {!closed && <div class={s.rows}>{rows.map(renderRow)}</div>}
            </section>
          );
        })}
      </div>
      {pending.length > 0 && !searchRows && (
        <button type="button" class={s.pill} data-tone={pendingUrgent ? 'attention' : undefined} title={t('chats.updatesLabel')}
          onClick={() => { list.applyNow(); list.scroller.current?.scrollTo({ top: 0, behavior: reducedMotion.value ? 'auto' : 'smooth' }); }}>
          <Icon name={pendingUrgent ? 'urgent' : 'arrowDown'} size={16} />
          <span class="num">{t('chats.updates', { n: pending.length, updates: tn('plural.updates', pending.length) })}</span>
        </button>
      )}

      <FilterSheet open={sheet === 'filter'} onClose={close} value={filter} onChange={changeFilter} />

      <Sheet open={rowItem !== undefined} onClose={close} title={rowItem ? liveName(rowItem) : ''} side={isSplit.value ? 'right' : 'center'}>
        {rowItem && (
          <div role="menu" aria-label={t('thread.actions')}>
            <Option label={t('action.open')} onSelect={() => { close(); markRead(rowItem.id); navigate({ name: 'chats', id: String(rowItem.id) }); }} />
            {rowItem.unread > 0 && <Option label={t('action.read')} onSelect={() => { close(); markRead(rowItem.id); }} />}
            {can('conv.resolve') && rowItem.state !== 'done' && (
              <Option label={isTicket(rowItem) ? t('thread.resolveTicket') : t('thread.resolve')} onSelect={() => resolveRow(rowItem)} />
            )}
            {can('conv.important') && (
              <Option label={t(rowItem.flags.important ? 'thread.unmarkImportant' : 'thread.markImportant')}
                onSelect={() => { close(); setImportant(rowItem.id, !rowItem.flags.important); }} />
            )}
            {can('conv.hide') && (
              <Option label={t('thread.hide')} hint={t('list.hideHint')}
                onSelect={() => { close(); setShown(removeShown(shown, String(rowItem.id)).list); hide(rowItem.id); }} />
            )}
          </div>
        )}
      </Sheet>

      <Sheet open={confirmItem !== undefined} onClose={close} title={t('resolveTicket.title', { name: confirmItem ? liveName(confirmItem) : '' })}>
        <p class={sheetStyles.text}>{t('resolveTicket.text')}</p>
        <div class={sheetStyles.actions}>
          <Button variant="secondary" onClick={close} autoFocus>{t('sheet.cancel')}</Button>
          <Button variant="primary" icon="check" onClick={() => {
            if (!confirmItem) return;
            close();
            setShown(removeShown(shown, String(confirmItem.id)).list);
            resolve(confirmItem.id);
          }}>{t('resolveTicket.yes')}</Button>
        </div>
      </Sheet>
    </div>
  );
}
