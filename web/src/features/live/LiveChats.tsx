import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { InboxItem } from '@shared/api-types';
import type { Section } from '@shared/attention';
import { t, tn } from '@/i18n/ru';
import { listTime } from '@/lib/format/format';
import { sectionLabel } from '@/lib/labels';
import { isUrgentCode, liveChannel, liveName, livePreview, liveReasonView } from '@/lib/live/labels';
import { liveCounts, liveItems, loadError, loading, startLive } from '@/lib/live/store';
import { reducedMotion } from '@/lib/media';
import { now } from '@/lib/store/state';
import { applyServer, pendingChanges, type Placed } from '@/lib/store/order';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Row } from '@/ui/Row';
import { Tabs } from '@/ui/Tabs';
import s from '@/features/chats/chats.module.css';
import { ConnectionLine } from './ConnectionLine';
import { LiveSummary } from './LiveSummary';
import l from './live.module.css';

type View = 'waiting' | 'open' | 'done';
const VIEW_SECTIONS: Record<View, readonly Section[]> = {
  waiting: ['mine'],
  open: ['mine', 'colleagues', 'ai', 'client'],
  done: ['done'],
};
const CALM_MS = 1500;
const SCROLL_SETTLE_MS = 1000;

/** Диалог открывается в классике (этап 2: новая панель — только список). */
export const classicHref = (id: number): string => `/#c${id}`;

function LiveRow({ item, tabIndex, onKeyDown }: { item: InboxItem; tabIndex: number; onKeyDown: (event: KeyboardEvent) => void }): JSX.Element {
  const at = now.value;
  const reason = liveReasonView(item, at);
  const preview = livePreview(item);
  const name = liveName(item);
  return (
    <Row
      id={String(item.id)}
      avatar={<Avatar name={name} channel={liveChannel(item)} />}
      title={name}
      time={listTime(item.activity_at, at)}
      who={preview.who}
      preview={preview.text}
      reason={reason.text}
      tone={reason.tone}
      unread={item.unread > 0}
      tabIndex={tabIndex}
      onOpen={() => { location.assign(classicHref(item.id)); }}
      onKeyDown={onKeyDown}
    />
  );
}

/**
 * Живой список «Диалоги» только для чтения (этап 2). Порядок и секции — с
 * сервера; список стоит, пока курсор, палец или фокус на нём, а изменения
 * копятся в пилюле (7.1 правила 2–4). Строка открывает диалог в классике.
 */
export function LiveChats(): JSX.Element {
  const [view, setView] = useState<View>('open');
  const [collapsed, setCollapsed] = useState<Partial<Record<Section, boolean>>>({});
  const [active, setActive] = useState<string | null>(null);
  const [frozen, setFrozen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const freeze = useRef({ hover: false, focus: false, touch: false, scrollAt: 0 });
  const flipFrom = useRef<Map<string, number> | null>(null);

  const items = liveItems.value;
  const byId = useMemo(() => new Map(items.map((item) => [String(item.id), item])), [items]);
  const server = useMemo<Placed[]>(() => items.map((item) => ({ id: String(item.id), section: item.section })), [items]);
  const [shown, setShown] = useState<Placed[]>(server);
  const target = applyServer(shown, server, null);
  const pending = pendingChanges(shown, target);
  const pendingUrgent = pending.some((id) => {
    const item = byId.get(id);
    return item !== undefined && item.section === 'mine' && isUrgentCode(item.reason.code);
  });

  const recompute = (): void => {
    const f = freeze.current;
    const scrolled = (scroller.current?.scrollTop ?? 0) > 8;
    setFrozen(f.hover || f.focus || f.touch || Date.now() - f.scrollAt < SCROLL_SETTLE_MS || scrolled);
  };

  const applyWithFlip = (): void => {
    const rows = scroller.current?.querySelectorAll<HTMLElement>('[data-row-id]') ?? [];
    const before = new Map<string, number>();
    rows.forEach((row) => before.set(row.dataset.rowId ?? '', row.getBoundingClientRect().top));
    flipFrom.current = before;
    setShown(target);
  };

  // Первый снимок показывается сразу: заморозка касается только обновлений.
  useEffect(() => { if (shown.length === 0 && server.length > 0) setShown(server); }, [server]);

  // Спокойный момент: 1,5 с без условий заморозки, вкладка видна (7.1 п.4).
  const pendingKey = pending.join(',');
  useEffect(() => {
    if (!pendingKey || frozen) return undefined;
    const timer = setTimeout(() => {
      if (document.visibilityState === 'visible') applyWithFlip();
    }, CALM_MS);
    return () => clearTimeout(timer);
  }, [pendingKey, frozen]);

  useLayoutEffect(() => {
    const before = flipFrom.current;
    if (!before) return;
    flipFrom.current = null;
    scroller.current?.querySelectorAll<HTMLElement>('[data-row-id]').forEach((row) => {
      const was = before.get(row.dataset.rowId ?? '');
      const top = row.getBoundingClientRect().top;
      if (reducedMotion.value) {
        if (was === undefined || Math.abs(was - top) > 1) {
          row.dataset.flash = 'true';
          setTimeout(() => { delete row.dataset.flash; }, 1000);
        }
        return;
      }
      if (was === undefined) {
        row.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
      } else if (Math.abs(was - top) > 1) {
        row.animate([{ transform: `translateY(${was - top}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    });
  }, [shown]);

  const counts = liveCounts.value;
  const sections = VIEW_SECTIONS[view].map((section) => ({
    section,
    rows: shown.filter((entry) => entry.section === section)
      .map((entry) => byId.get(entry.id))
      .filter((item): item is InboxItem => item !== undefined),
  }));
  const visible = sections.flatMap((group) => (collapsed[group.section] ? [] : group.rows));
  const focusId = active && visible.some((item) => String(item.id) === active) ? active : visible[0] ? String(visible[0].id) : null;

  const onRowKey = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const rows = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-row-id]') ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? rows[0] : event.key === 'End' ? rows[rows.length - 1]
      : rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { setActive(next.dataset.rowId ?? null); next.focus(); }
  };

  const nothing = sections.every((group) => group.rows.length === 0);
  const state = loading.value;

  return (
    <div class={s.screen} data-open="false" data-client="false">
      <section class={s.listCol}>
        <div class={s.list}>
          <ConnectionLine />
          <header class={s.listHead}>
            <h1 class={s.title}>{t('chats.title')}</h1>
            <Tabs<View>
              label={t('chats.views')}
              stretch
              value={view}
              onChange={setView}
              items={[
                { value: 'waiting', label: t('chats.view.waiting'), count: counts?.sections.mine ?? 0 },
                { value: 'open', label: t('chats.view.open') },
                { value: 'done', label: t('chats.view.done') },
              ]}
            />
          </header>
          <div
            class={s.scroller}
            ref={scroller}
            aria-busy={state === 'loading' ? 'true' : 'false'}
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
            {state === 'loading' && nothing && <p class={s.empty}>{t('live.loading')}</p>}
            {state === 'error' && (
              <div class={s.empty} role="alert">
                <p><b>{t('live.error')}</b> · {t('live.errorHint')}</p>
                <p class={l.code}>{t('live.code', { code: loadError.value ?? '' })}</p>
                <Button variant="secondary" size="sm" onClick={() => { void startLive(); }}>{t('live.retry')}</Button>
              </div>
            )}
            {state === 'ready' && nothing && (
              <div class={s.empty}>
                {view === 'waiting'
                  ? <p>{t('chats.nobodyWaits', { n: counts?.sections.ai ?? 0, dialogs: tn('plural.dialogs', counts?.sections.ai ?? 0) })}</p>
                  : view === 'done' ? <p>{t('chats.noneDone')}</p> : null}
              </div>
            )}
            {sections.map(({ section, rows }) => {
              if (rows.length === 0) return null;
              const isCollapsed = collapsed[section] ?? false;
              const headId = `live-sec-${section}`;
              const total = section === 'done' ? rows.length : counts?.sections[section] ?? rows.length;
              return (
                <section key={section} class={s.section} aria-labelledby={headId}>
                  <h2 class={s.sectionHead} id={headId}>
                    <button
                      type="button"
                      class={s.sectionToggle}
                      aria-expanded={!isCollapsed}
                      aria-label={`${sectionLabel(section)} · ${total}. ${isCollapsed ? t('chats.expand') : t('chats.collapse')}`}
                      onClick={() => setCollapsed({ ...collapsed, [section]: !isCollapsed })}
                    >
                      <span>{sectionLabel(section)}</span>
                      <span class={`${s.sectionCount} num`} data-tone={section === 'mine' ? 'attention' : undefined}>{total}</span>
                      <Icon name="down" size={16} class={isCollapsed ? s.chevronClosed : s.chevron} />
                    </button>
                  </h2>
                  {section === 'mine' && !isCollapsed && <p class={s.sectionHint}>{t('chats.mineHint')}</p>}
                  {!isCollapsed && (
                    <div class={s.rows}>
                      {rows.map((item) => (
                        <LiveRow key={item.id} item={item} tabIndex={String(item.id) === focusId ? 0 : -1} onKeyDown={onRowKey} />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
          {pending.length > 0 && (
            <button
              type="button"
              class={s.pill}
              data-tone={pendingUrgent ? 'attention' : undefined}
              title={t('chats.updatesLabel')}
              onClick={() => {
                applyWithFlip();
                scroller.current?.scrollTo({ top: 0, behavior: reducedMotion.value ? 'auto' : 'smooth' });
              }}
            >
              <Icon name={pendingUrgent ? 'urgent' : 'arrowDown'} size={16} />
              <span class="num">{t('chats.updates', { n: pending.length, updates: tn('plural.updates', pending.length) })}</span>
            </button>
          )}
        </div>
      </section>
      <section class={s.threadCol}>
        <div class={s.summary}><LiveSummary /></div>
      </section>
    </div>
  );
}
