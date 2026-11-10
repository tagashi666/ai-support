import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { InboxItem, InboxResponse } from '@shared/api-types';
import type { Section } from '@shared/attention';
import { ConnectionLine } from '@/features/live/ConnectionLine';
import { t, tn } from '@/i18n/ru';
import { listTime } from '@/lib/format/format';
import { useFrozenList } from '@/lib/hooks/useFrozenList';
import { useRowWindow } from '@/lib/hooks/useRowWindow';
import { sectionLabel } from '@/lib/labels';
import { getJson, readToken } from '@/lib/live/api';
import { isUrgentCode, liveChannel, liveName, livePreview, liveReasonView } from '@/lib/live/labels';
import { bootstrap, liveCounts, liveItems, loadError, loading, startLive } from '@/lib/live/store';
import { isSplit, reducedMotion } from '@/lib/media';
import { listOrder, paletteOpen, selectTick } from '@/lib/palette/run';
import { navigate } from '@/lib/router';
import { applyServer, pendingChanges, removeShown, type Placed } from '@/lib/store/order';
import { now } from '@/lib/store/state';
import { bulk, drafts, hide, markRead, permissions, resolve, setImportant, type BulkAction } from '@/lib/workspace/actions';
import { gestures } from '@/lib/device';
import { lockOf, offsetOf, PANEL_PX, settle, type SwipeLock } from '@/lib/hooks/swipe';
import { filterItems, filterSize, readFilter, saveFilter, type ListFilter } from '@/lib/workspace/filter';
import { colleaguesIn, presence } from '@/lib/workspace/collab';
import { TUTORIAL_ID, tutorialListed } from '@/lib/onboarding';
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
import { DUR, EASE, dur } from '@/ui/motion';

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

interface RowActions {
  onMenu: () => void;
  /** Режим выбора: null — выключен. */
  selected: boolean | null;
  onSelect: () => void;
  onLongPress: () => void;
  /** Свайп влево открыт у этой строки. */
  swiped: boolean;
  onSwipe: (open: boolean) => void;
  swipeEnabled: boolean;
  onResolve: () => void;
  onImportant: (() => void) | null;
  onHide: (() => void) | null;
}

const LONG_PRESS_MS = 500;

/**
 * Строка с меню «⋯»: на компьютере видно при наведении и фокусе, на телефоне —
 * всегда (цель 44 px). На телефоне свайп влево открывает «Решено · Важно ·
 * Убрать · ⋯» (7.5), долгое нажатие — режим выбора. У каждого жеста есть кнопка.
 */
function WorkRow({ item, current, tabIndex, onKeyDown, actions, leaving = false, moved = false }: {
  item: InboxItem; current: boolean; tabIndex: number; onKeyDown: (event: KeyboardEvent) => void; actions: RowActions;
  /** Своё «Решено/Убрать»: строка ещё на месте и уходит (M-1). */
  leaving?: boolean;
  /** Сервер уже унёс строку в другую секцию, а список заморожен: приглушить на месте (L-12). */
  moved?: boolean;
}): JSX.Element {
  const at = now.value;
  const reason = liveReasonView(item, at);
  const own = drafts.get(item.id);
  const preview = own.text.trim() && own.mode === 'reply' ? { who: t('preview.draft'), text: own.text } : livePreview(item);
  const name = liveName(item);
  // Кто из коллег сейчас в диалоге (7.7): мини-аватар вместо точки «прочитано».
  const here = colleaguesIn(presence.value.get(item.id), bootstrap.value?.me.id ?? '', at)[0];
  const front = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number; lock: SwipeLock; dx: number; timer: ReturnType<typeof setTimeout> | null; long: boolean; v: number; at: number } | null>(null);

  const setOffset = (px: number, animate: boolean): void => {
    const el = front.current;
    if (!el) return;
    el.style.transition = animate && !reducedMotion.value ? `transform ${DUR.move}ms ${EASE.out}` : 'none';
    el.style.transform = px ? `translateX(${px}px)` : '';
  };
  useEffect(() => { setOffset(actions.swiped ? -PANEL_PX : 0, true); }, [actions.swiped]);

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    const timer = setTimeout(() => {
      if (gesture.current && gesture.current.lock === 'none') { gesture.current.long = true; actions.onLongPress(); }
    }, LONG_PRESS_MS);
    gesture.current = { x: event.clientX, y: event.clientY, lock: 'none', dx: 0, timer, long: false, v: 0, at: event.timeStamp };
  };
  const onPointerMove = (event: PointerEvent): void => {
    const g = gesture.current;
    if (!g) return;
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    if (g.lock === 'none') {
      g.lock = lockOf(g.x, dx, dy);
      if (g.lock !== 'none' && g.timer) { clearTimeout(g.timer); g.timer = null; }
    }
    if (g.lock !== 'horizontal' || !actions.swipeEnabled || actions.selected !== null) return;
    // Скорость — по последнему отрезку (px/мс), для броска (M-9).
    const dt = event.timeStamp - g.at;
    if (dt > 0) g.v = (dx - g.dx) / dt;
    g.at = event.timeStamp;
    g.dx = dx;
    setOffset(offsetOf(dx, actions.swiped), false);
  };
  const onPointerEnd = (): void => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.timer) clearTimeout(g.timer);
    if (g.lock === 'horizontal' && actions.swipeEnabled && actions.selected === null) {
      const open = settle(g.dx, actions.swiped, g.v);
      actions.onSwipe(open);
      setOffset(open ? -PANEL_PX : 0, true);
    }
  };
  const onClickCapture = (event: MouseEvent): void => {
    // После долгого нажатия или сдвига — не открывать диалог.
    if (gesture.current?.long || (actions.swiped && event.target instanceof Element && event.target.closest(`.${w.rowFront}`))) {
      event.preventDefault(); event.stopPropagation();
      if (actions.swiped) actions.onSwipe(false);
    }
  };

  const selecting = actions.selected !== null;
  return (
    <div class={w.rowWrap} data-row-id={String(item.id)} data-swiped={actions.swiped ? 'true' : 'false'} data-selecting={selecting ? 'true' : 'false'}
      data-state={leaving ? 'closing' : undefined} data-moved={moved ? 'true' : undefined} inert={leaving || undefined}>
      {actions.swipeEnabled && (
        <div class={w.swipePanel} aria-hidden={actions.swiped ? undefined : 'true'}>
          <button type="button" class={w.swipeBtn} data-tone="ok" tabIndex={actions.swiped ? 0 : -1} onClick={() => { actions.onSwipe(false); actions.onResolve(); }}>{t('thread.resolve')}</button>
          {actions.onImportant && <button type="button" class={w.swipeBtn} tabIndex={actions.swiped ? 0 : -1} onClick={() => { actions.onSwipe(false); actions.onImportant?.(); }}>{t('swipe.important')}</button>}
          {actions.onHide && <button type="button" class={w.swipeBtn} tabIndex={actions.swiped ? 0 : -1} onClick={() => { actions.onSwipe(false); actions.onHide?.(); }}>{t('swipe.hide')}</button>}
          <button type="button" class={w.swipeBtn} tabIndex={actions.swiped ? 0 : -1} aria-label={t('list.rowMenu', { name })} onClick={() => { actions.onSwipe(false); actions.onMenu(); }}>⋯</button>
        </div>
      )}
      <div ref={front} class={w.rowFront} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd} onClickCapture={onClickCapture} onContextMenu={(event) => { if (gesture.current) event.preventDefault(); }}>
        <Row
          id={String(item.id)}
          wrapped
          avatar={selecting
            ? <span class={w.check} data-checked={actions.selected ? 'true' : 'false'} aria-hidden="true">{actions.selected ? '✓' : ''}</span>
            : here ? (
              <span class={w.avatarWrap}>
                <Avatar name={name} channel={liveChannel(item)} />
                <span class={w.rowPresence} role="img" aria-label={t('presence.row', { name: here.name })}>{here.name.slice(0, 1).toLocaleUpperCase('ru')}</span>
              </span>
            ) : <Avatar name={name} channel={liveChannel(item)} />}
          title={name}
          time={listTime(item.activity_at, at)}
          who={preview.who}
          preview={preview.text}
          reason={reason.text}
          tone={reason.tone}
          unread={item.unread > 0}
          current={current}
          tabIndex={tabIndex}
          pressed={selecting ? Boolean(actions.selected) : undefined}
          onOpen={() => {
            if (selecting) { actions.onSelect(); return; }
            markRead(item.id); navigate({ name: 'chats', id: String(item.id) });
          }}
          onKeyDown={onKeyDown}
        />
        {!selecting && (
          <button type="button" class={w.rowMenu} aria-label={t('list.rowMenu', { name })} aria-haspopup="dialog" tabIndex={tabIndex} onClick={actions.onMenu}>
            <Icon name="more" size={20} />
          </button>
        )}
      </div>
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
export function WorkList({ openId, tutorialOpen = false }: { openId: number | null; tutorialOpen?: boolean }): JSX.Element {
  const [view, setView] = useState<View>(readView);
  const [collapsed, setCollapsed] = useState<Partial<Record<Section, boolean>>>({});
  const [active, setActive] = useState<string | null>(null);
  const [filter, setFilter] = useState<ListFilter>(readFilter);
  const [sheet, setSheet] = useState<'filter' | { row: number } | { confirmResolve: number } | { confirmBulk: number[] } | null>(null);
  /** Режим выбора (6.2): null — выключен. */
  const [selected, setSelected] = useState<Set<number> | null>(null);
  const [swiped, setSwiped] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ q: string; ids: number[]; items: Map<number, InboxItem> } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const map = patches.value;
  const items = useMemo(() => filterItems(liveItems.value.map((item) => patched(item, map)).filter((item): item is InboxItem => item !== null),
    filter, bootstrap.value?.me.id ?? ''), [liveItems.value, map, filter]);
  const byId = useMemo(() => new Map(items.map((item) => [String(item.id), item])), [items]);
  const kept = useRef(new Map<string, InboxItem>());
  const server = useMemo<Placed[]>(() => items.map((item) => ({ id: String(item.id), section: item.section })), [items]);
  const [shown, setShown] = useState<Placed[]>(server);
  const pinned = openId !== null ? String(openId) : null;
  const target = applyServer(shown, server, pinned);
  const pending = pendingChanges(shown, target);
  const pendingUrgent = pending.some((id) => {
    const item = byId.get(id);
    return item !== undefined && item.section === 'mine' && isUrgentCode(item.reason.code);
  });
  /**
   * Накопленное с сервера применяется в покое; строки, которые сервер убрал из
   * вида (чужое «Решено», «Убрать»), уходят той же анимацией, что и свои (M-1).
   */
  const applyServerNow = (): void => {
    // «Ушла из вида» — и снята сервером, и переехала в секцию, которой в этом виде нет («Решённые»).
    const inView = (place: Placed): boolean => VIEW_SECTIONS[view].includes(place.section);
    const next = new Set(target.filter(inView).map((place) => place.id));
    const gone = shown.filter((place) => inView(place) && !next.has(place.id) && !leaving.has(place.id) && place.id !== pinned).map((place) => place.id);
    if (gone.length && !reducedMotion.value) leave(gone);
    else setShown(target);
  };
  const list = useFrozenList({ pendingKey: pending.join(','), apply: applyServerNow, shown });

  /**
   * Своё «Решено/Убрать» (M-1): строка ещё dur('exit') на месте и уходит
   * (прозрачность и сдвиг влево), потом снимается, а соседи переезжают FLIP-ом.
   * Пока строки уходят, заплатки к показу не применяются — иначе строка исчезла бы сразу.
   */
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const leave = (ids: readonly string[]): void => {
    setLeaving((prev) => new Set([...prev, ...ids]));
    setTimeout(() => {
      list.applyNow(() => setShown((prev) => ids.reduce((acc, id) => removeShown(acc, id).list, prev)));
      setLeaving((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
    }, dur('exit'));
  };

  // Первый снимок — сразу; свои действия (заплатки) и смена фильтра — сразу (7.1 п.5).
  useEffect(() => { if (shown.length === 0 && server.length > 0) setShown(server); }, [server]);
  // Намерение коллеги (L-2) — тоже заплатка, но чужая: ждёт покоя, как кадр сервера.
  const ownKey = useMemo(() => [...map].filter(([, local]) => !local.foreign).map(([id, local]) => `${id}:${local.held ? 1 : 0}:${local.removed ? 1 : 0}:${JSON.stringify(local.patch)}`).join('|'), [map]);
  useEffect(() => { if (leaving.size === 0) list.applyNow(); }, [ownKey, filter, leaving.size === 0]);
  useEffect(() => { list.hold(sheet !== null || selected !== null || swiped !== null); }, [sheet, selected !== null, swiped]);

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
  // Строка, которую сервер (или намерение коллеги) убрал, видна до применения в покое —
  // с последними данными и пометкой «переехала» — и уходит анимацией выхода (L-2, M-1).
  for (const [id, item] of byId) kept.current.set(id, item);
  const sections = VIEW_SECTIONS[view].map((section) => ({
    section,
    rows: shown.filter((entry) => entry.section === section)
      .map((entry) => byId.get(entry.id) ?? kept.current.get(entry.id))
      .filter((item): item is InboxItem => item !== undefined),
  }));
  useEffect(() => {
    const live = new Set(shown.map((entry) => entry.id));
    for (const id of kept.current.keys()) if (!live.has(id) && !byId.has(id)) kept.current.delete(id);
  }, [shown, byId]);
  const shownIn = new Map(shown.map((entry) => [entry.id, entry.section]));
  const searchRows = found ? found.ids
    .map((id) => byId.get(String(id)) ?? patched(found.items.get(id)!, map))
    .filter((item): item is InboxItem => item !== null && item !== undefined) : null;
  const isCollapsed = (section: Section, size: number): boolean => collapsed[section] ?? (section === 'client' && size > 5);
  const visible = searchRows ?? sections.flatMap((group) => (isCollapsed(group.section, group.rows.length) ? [] : group.rows));
  // Окно отрисовки (6.2): больше 100 строк — рисуем видимые ±2 экрана.
  const groups = searchRows ? [{ key: 'found', rows: searchRows }]
    : sections.filter((group) => !isCollapsed(group.section, group.rows.length)).map((group) => ({ key: group.section as string, rows: group.rows }));
  const win = useRowWindow(list.scroller, visible.length, groups.map((group) => `${group.key}:${group.rows.length}`).join(','));
  const drawn = new Map(groups.map((group) => [group.key, win.range(group.key, group.rows.length)]));
  const isDrawn = (id: string): boolean => groups.some((group) => {
    const [from, to] = drawn.get(group.key)!;
    return group.rows.slice(from, to).some((item) => String(item.id) === id);
  });
  const wanted = active && visible.some((item) => String(item.id) === active) ? active
    : pinned && visible.some((item) => String(item.id) === pinned) ? pinned : visible[0] ? String(visible[0].id) : null;
  // Строка с фокусом за окном: одна остановка Tab всё равно есть — первая нарисованная.
  const focusId = !win.on || wanted === null || isDrawn(wanted) ? wanted
    : (groups.map((group) => group.rows[drawn.get(group.key)![0]]).find(Boolean)?.id.toString() ?? wanted);
  const focusAfter = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    const row = list.scroller.current?.querySelector<HTMLElement>(`[data-row-id="${id}"] button`);
    if (row) { focusAfter.current = null; row.focus(); }
  });
  // Порядок видимых строк — для [ и ] в открытом диалоге (7.3).
  const visibleKey = visible.map((item) => item.id).join(',');
  useEffect(() => { listOrder.value = visible.map((item) => item.id); }, [visibleKey]);
  const onRowKey = (event: KeyboardEvent): void => {
    // Home / End за окном отрисовки: прокрутить к краю и поставить фокус, когда строка появится.
    if (win.on && (event.key === 'Home' || event.key === 'End') && visible.length > 0) {
      event.preventDefault();
      const edge = String((event.key === 'Home' ? visible[0] : visible[visible.length - 1])!.id);
      const el = list.scroller.current;
      if (el) el.scrollTop = event.key === 'Home' ? 0 : el.scrollHeight;
      focusAfter.current = edge;
      setActive(edge);
      return;
    }
    const next = list.onRowKey(event);
    if (next) setActive(next);
  };
  const windowed = (key: string, rows: InboxItem[]): JSX.Element => {
    const [from, to] = drawn.get(key) ?? [0, rows.length];
    const pad = (n: number): JSX.Element | null => (n > 0 ? <div aria-hidden="true" style={{ height: `${n * win.pitch - 2}px` }} /> : null);
    return (
      <div class={s.rows} data-rows={key} data-count={String(rows.length)}>
        {pad(from)}{rows.slice(from, to).map(renderRow)}{pad(rows.length - to)}
      </div>
    );
  };

  const rowItem = sheet && typeof sheet === 'object' && 'row' in sheet ? itemFor(sheet.row) : undefined;
  function itemFor(id: number): InboxItem | undefined { return byId.get(String(id)) ?? found?.items.get(id); }
  const close = (): void => setSheet(null);
  const perms = permissions.value;
  const can = (id: Parameters<typeof availability>[0]): boolean => availability(id, perms) === 'show';

  /** Своё действие убирает строку сразу, «Отменить» вернёт её на то же место (заплатка). */
  const resolveRow = (item: InboxItem): void => {
    close();
    if (isTicket(item)) { setSheet({ confirmResolve: item.id }); return; }
    leave([String(item.id)]);
    resolve(item.id);
  };

  const nothing = (searchRows ?? sections.flatMap((group) => group.rows)).length === 0;
  const boot = bootstrap.value;
  const noChannels = Boolean(boot && !boot.sources.some((source) => source.enabled) && !Object.values(boot.channels).some(Boolean));
  const state = loading.value;
  const activeFilters = filterSize(filter);
  const confirmItem = sheet && typeof sheet === 'object' && 'confirmResolve' in sheet ? itemFor(sheet.confirmResolve) : undefined;

  const toggle = (id: number): void => {
    const next = new Set(selected ?? []);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };
  const phone = !isSplit.value;
  const renderRow = (item: InboxItem): JSX.Element => (
    <WorkRow key={item.id} item={item} current={String(item.id) === pinned} tabIndex={String(item.id) === focusId ? 0 : -1}
      leaving={leaving.has(String(item.id))} moved={!searchRows && !leaving.has(String(item.id)) && (!byId.has(String(item.id)) || (shownIn.get(String(item.id)) ?? item.section) !== item.section)}
      onKeyDown={onRowKey} actions={{
        onMenu: () => setSheet({ row: item.id }),
        selected: selected === null ? null : selected.has(item.id),
        onSelect: () => toggle(item.id),
        onLongPress: () => { setSwiped(null); setSelected(new Set([...(selected ?? []), item.id])); },
        swiped: swiped === item.id,
        onSwipe: (open) => setSwiped(open ? item.id : null),
        swipeEnabled: phone && gestures.value && can('conv.resolve') && item.state !== 'done',
        onResolve: () => resolveRow(item),
        onImportant: can('conv.important') ? () => setImportant(item.id, !item.flags.important) : null,
        onHide: can('conv.hide') ? () => { leave([String(item.id)]); hide(item.id); } : null,
      }} />
  );

  /** Пакет: внешние заявки среди выбранных — ярус 2 (7.6). */
  const chosen = [...(selected ?? [])].map((id) => itemFor(id)).filter((item): item is InboxItem => item !== undefined);
  const runBulk = (action: BulkAction, confirmed = false): void => {
    const ids = chosen.map((item) => item.id);
    if (!ids.length) return;
    if (action === 'resolve' && !confirmed && chosen.some(isTicket)) { setSheet({ confirmBulk: ids }); return; }
    if (action === 'resolve' || action === 'hide') leave(ids.map(String));
    bulk(ids, action);
    setSelected(null);
  };
  const bulkTickets = sheet && typeof sheet === 'object' && 'confirmBulk' in sheet
    ? sheet.confirmBulk.map((id) => itemFor(id)).filter((item): item is InboxItem => item !== undefined && isTicket(item)).length : 0;

  // X — выбрать строку под фокусом (одной буквой, если включено, 7.3).
  useEffect(() => {
    if (selectTick.value === 0 || !focusId) return;
    toggle(Number(focusId));
  }, [selectTick.value]);

  return (
    <div class={s.list}>
      <ConnectionLine />
      <header class={s.listHead}>
        <div class={w.titleRow}>
          <h1 class={s.title}>{t('chats.title')}</h1>
          {phone && <Button variant="quiet" size="sm" icon="search" label={t('nav.search')} aria-haspopup="dialog" onClick={() => { paletteOpen.value = true; }} />}
          {can('conv.resolve') && (
            <Button variant="quiet" size="sm" icon="check" class={w.selectBtn} aria-pressed={selected !== null} label={phone ? t('bulk.select') : undefined}
              aria-label={t('bulk.select')} title={phone ? undefined : t('bulk.select')}
              onClick={() => { setSwiped(null); setSelected(selected === null ? new Set() : null); }}>
              {phone ? undefined : <span class={w.selectText}>{t('bulk.select')}</span>}
            </Button>
          )}
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
      <div class={s.scroller} ref={list.scroller} data-scroller="chats" aria-busy={state === 'loading' ? 'true' : 'false'} {...list.handlers}>
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
            ) : view === 'done' ? <p>{t('chats.noneDone')}</p> : noChannels ? (
              <>
                <p>{t('list.noChannels')}</p>
                {perms.has('settings:sources') && <button type="button" class={s.emptyAction} onClick={() => navigate({ name: 'section', key: 'connections' })}>{t('list.connect')}</button>}
                {!tutorialListed(Date.now()) && <button type="button" class={s.emptyAction} onClick={() => navigate({ name: 'chats', id: TUTORIAL_ID })}>{t('learn.open')}</button>}
              </>
            ) : <p>{t('list.quiet')}</p>}
          </div>
        )}
        {!searchRows && view !== 'done' && tutorialListed(Date.now()) && state === 'ready' && (
          <section class={s.section} aria-labelledby="work-sec-learn">
            <h2 class={s.sectionHead} id="work-sec-learn"><span class={s.sectionToggle}>{t('learn.section')}</span></h2>
            <div class={s.rows}>
              <div class={w.rowWrap} data-tutorial="true">
                <Row id={TUTORIAL_ID} wrapped avatar={<Avatar name={t('learn.name')} channel="telegram" />} title={t('learn.name')} time=""
                  preview={t('learn.preview')} reason="" tone="quiet" current={tutorialOpen} tabIndex={-1}
                  onOpen={() => navigate({ name: 'chats', id: TUTORIAL_ID })} />
              </div>
            </div>
          </section>
        )}
        {searchRows ? (
          searchRows.length > 0 && (
            <section class={s.section} aria-label={t('list.found', { n: searchRows.length })}>
              <p class={s.sectionHint}>{t('list.found', { n: searchRows.length })}</p>
              {windowed('found', searchRows)}
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
              {!closed && windowed(section, rows)}
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

      {selected !== null && (
        <div class={w.bulkBar} role="toolbar" aria-label={t('bulk.toolbar')}>
          <span class="num" aria-live="polite">{t('bulk.count', { n: selected.size })}</span>
          <Button variant="primary" size="sm" icon="check" disabled={!selected.size} onClick={() => runBulk('resolve')}>{t('thread.resolve')}</Button>
          <Button variant="secondary" size="sm" disabled={!selected.size} onClick={() => runBulk('read')}>{t('bulk.read')}</Button>
          {can('conv.important') && <Button variant="secondary" size="sm" disabled={!selected.size} onClick={() => runBulk('important')}>{t('swipe.important')}</Button>}
          {can('conv.hide') && <Button variant="secondary" size="sm" disabled={!selected.size} onClick={() => runBulk('hide')}>{t('swipe.hide')}</Button>}
          <Button variant="quiet" size="sm" onClick={() => setSelected(null)}>{t('bulk.cancel')}</Button>
        </div>
      )}
      {swiped !== null && <button type="button" class={w.swipeScrim} aria-label={t('swipe.close')} onClick={() => setSwiped(null)} />}

      <Sheet open={sheet !== null && typeof sheet === 'object' && 'confirmBulk' in sheet} onClose={close}
        title={t('bulk.ticketsTitle', { n: bulkTickets, tickets: tn('plural.tickets', bulkTickets) })}>
        <p class={sheetStyles.text}>{t('bulk.ticketsText', { n: chosen.length })}</p>
        <div class={sheetStyles.actions}>
          <Button variant="secondary" onClick={close} autoFocus>{t('sheet.cancel')}</Button>
          <Button variant="primary" icon="check" onClick={() => { close(); runBulk('resolve', true); }}>{t('bulk.ticketsYes', { n: chosen.length })}</Button>
        </div>
      </Sheet>

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
                onSelect={() => { close(); leave([String(rowItem.id)]); hide(rowItem.id); }} />
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
            leave([String(confirmItem.id)]);
            resolve(confirmItem.id);
          }}>{t('resolveTicket.yes')}</Button>
        </div>
      </Sheet>
    </div>
  );
}
