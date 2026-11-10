import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';
import { ME } from '@/demo/seed';
import { t, type Key } from '@/i18n/ru';
import { paletteOpen } from '@/lib/palette/run';
import { href, navigate, type Route, type SectionKey } from '@/lib/router';
import { bootstrap, liveMine, mode, signOut } from '@/lib/live/store';
import { pausedUntil, setTheme, theme, waitingYou, type Theme } from '@/lib/store/state';
import { modLabel } from '@/lib/keys';
import { Avatar } from '@/ui/Avatar';
import { Icon, type IconName } from '@/ui/Icon';
import { meRole } from '@/lib/workspace/labels';
import { systemDot } from '@/lib/system/problems';
import s from './shell.module.css';

type Target = 'today' | 'chats' | 'more' | SectionKey;

interface Item {
  target: Target;
  label: Key;
  icon: IconName;
}

const DAILY: readonly Item[] = [
  { target: 'today', label: 'nav.today', icon: 'today' },
  { target: 'chats', label: 'nav.chats', icon: 'chats' },
  { target: 'knowledge', label: 'nav.knowledge', icon: 'knowledge' },
  { target: 'assistant', label: 'nav.assistant', icon: 'assistant' },
];
const RARE: readonly Item[] = [
  { target: 'reports', label: 'nav.reports', icon: 'reports' },
  { target: 'connections', label: 'nav.connections', icon: 'connections' },
  { target: 'team', label: 'nav.team', icon: 'team' },
  { target: 'system', label: 'nav.system', icon: 'system' },
];

const routeOf = (target: Target): Route =>
  target === 'today' ? { name: 'today' }
    : target === 'chats' ? { name: 'chats', id: null }
      : target === 'more' ? { name: 'more' }
        : { name: 'section', key: target };

const isCurrent = (target: Target, current: Route): boolean =>
  (target === 'today' && current.name === 'today')
  || (target === 'chats' && current.name === 'chats')
  || (target === 'more' && current.name === 'more')
  || (current.name === 'section' && current.key === target);

/** Кто вошёл: ключ root — «Владелец», а не «Администратор»; роль совпадает с именем — не повторять. */
export function account(): { name: string; role: string | null } {
  const me = mode.value === 'live' ? bootstrap.value?.me : undefined;
  if (!me) return { name: ME.name, role: null };
  const role = meRole(me);
  return { name: me.name, role: role === me.name ? null : role };
}

/** Ссылка-раздел: настоящая ссылка (открыть в новой вкладке можно), переход — без перезагрузки. */
function NavLink({ item, current, class: cls, iconSize }: { item: Item; current: Route; class?: string; iconSize: number }): JSX.Element {
  const route = routeOf(item.target);
  const live = mode.value === 'live';
  // Бейдж «Диалогов» — всегда «Ждут вас» (7.1 п.9): в живом режиме — число сервера.
  const waiting = live ? liveMine.value : waitingYou.value.length;
  const ideas = live ? bootstrap.value?.counts.ideas ?? 0 : 7;
  const paused = !live && pausedUntil.value !== null;
  // «Система»: красная точка — неполадка, янтарная — есть что проверить, синяя — новая версия (5.1).
  const dot = live && item.target === 'system' ? systemDot.value : null;
  const count = item.target === 'chats' ? waiting : item.target === 'knowledge' ? ideas : 0;
  return (
    <a
      class={cls}
      href={href(route)}
      title={t(item.label)}
      aria-current={isCurrent(item.target, current) ? 'page' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(route);
      }}
    >
      <Icon name={item.icon} size={iconSize} />
      <span class={s.navLabel}>{t(item.label)}</span>
      {count > 0 && <span class={s.badge} data-tone={item.target === 'chats' ? 'attention' : 'quiet'}>{count}</span>}
      {(paused || dot) && <span class={s.dot} data-tone={dot ?? undefined} />}
      {dot && <span class="visually-hidden">{t(dot === 'update' ? 'nav.systemUpdate' : dot === 'error' ? 'nav.systemError' : 'nav.systemWarn')}</span>}
    </a>
  );
}

const THEMES: readonly { value: Theme; label: Key }[] = [
  { value: 'auto', label: 'device.themeAuto' },
  { value: 'light', label: 'device.themeLight' },
  { value: 'dark', label: 'device.themeDark' },
];

/**
 * Аккаунт внизу навигации: аватар, имя, роль (только в широкой панели).
 * Меню — popover верхнего слоя: тема, «Это устройство», классическая панель, выход.
 */
function Account({ current }: { current: Route }): JSX.Element {
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const { name, role } = account();
  const live = mode.value === 'live';
  const close = (): void => { menu.current?.hidePopover(); };
  const place = (): void => {
    const box = button.current?.getBoundingClientRect();
    const el = menu.current;
    if (!box || !el) return;
    // Над кнопкой, от левого края навигации; CSSOM, а не атрибут style — CSP не мешает.
    el.style.setProperty('left', `${Math.round(box.left)}px`);
    el.style.setProperty('bottom', `${Math.round(innerHeight - box.top + 4)}px`);
  };
  const items = (): HTMLElement[] => [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
  const onKey = (event: KeyboardEvent): void => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      list[(index + step + list.length) % list.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      (event.key === 'Home' ? list[0] : list[list.length - 1])?.focus();
    }
  };
  const go = (route: Route) => (event: MouseEvent): void => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    close();
    navigate(route);
  };
  const device: Route = { name: 'section', key: 'device' };
  return (
    <div class={s.account}>
      <button
        ref={button}
        type="button"
        class={s.accountButton}
        popovertarget="account-menu"
        aria-haspopup="menu"
        aria-label={role ? `${name}, ${role}` : name}
        title={name}
        data-current={current.name === 'section' && current.key === 'device' ? 'true' : undefined}
        onClick={place}
      >
        <Avatar name={name} size="s" />
        <span class={s.accountText}>
          <span class={s.accountName}>{name}</span>
          {role && <span class={s.accountRole}>{role}</span>}
        </span>
      </button>
      <div
        ref={menu}
        id="account-menu"
        popover="auto"
        role="menu"
        aria-label={t('nav.account')}
        class={s.menu}
        onKeyDown={onKey}
        onToggle={(event: Event) => {
          if ((event as ToggleEvent).newState === 'open') requestAnimationFrame(() => items()[0]?.focus());
          else if (menu.current?.contains(document.activeElement)) button.current?.focus();
        }}
      >
        <div class={s.menuGroup} role="group" aria-label={t('device.theme')}>
          <span class={s.menuLabel} aria-hidden="true">{t('device.theme')}</span>
          <span class={s.menuSeg}>
            {THEMES.map((item) => (
              <button key={item.value} type="button" role="menuitemradio" class={s.menuSegItem}
                aria-checked={theme.value === item.value ? 'true' : 'false'} onClick={() => setTheme(item.value)}>
                {t(item.label)}
              </button>
            ))}
          </span>
        </div>
        <div class={s.menuSep} role="separator" />
        <a role="menuitem" class={s.menuItem} href={href(device)} onClick={go(device)}>{t('nav.device')}</a>
        <a role="menuitem" class={s.menuItem} href="/?ui=classic">{t('nav.classic')}</a>
        {live && <button type="button" role="menuitem" class={s.menuItem} onClick={() => { close(); signOut(); }}>{t('live.signOut')}</button>}
      </div>
    </div>
  );
}

/**
 * Боковая навигация (R2 A1): ≥1280 — 232 px с подписями, 768–1279 — значки 64 px
 * с подсказкой, <768 — нет (нижние вкладки). Ширины переключает только CSS.
 */
export function Rail({ current }: { current: Route }): JSX.Element {
  const live = mode.value === 'live' ? bootstrap.value?.me : undefined;
  return (
    <nav class={s.rail} aria-label={t('nav.main')}>
      <ul class={s.railList}>
        <li>
          <button type="button" class={s.railItem} title={t('nav.search')} aria-keyshortcuts={live ? 'Control+K Meta+K' : undefined} onClick={() => {
            // Живой режим — палитра ⌘K (6.5); прототип — поиск в списке.
            if (live) { paletteOpen.value = true; return; }
            navigate({ name: 'chats', id: null });
            requestAnimationFrame(() => document.getElementById('chat-search')?.focus());
          }}>
            <Icon name="search" size={20} />
            <span class={s.navLabel}>{t('nav.search')}</span>
            {live && <kbd class={s.kbd} aria-hidden="true">{modLabel().replace('+', '')}K</kbd>}
          </button>
        </li>
        {DAILY.map((item) => <li key={item.target}><NavLink item={item} current={current} class={s.railItem} iconSize={20} /></li>)}
      </ul>
      <div class={s.railSep} role="presentation" />
      <ul class={s.railList}>
        {RARE.map((item) => <li key={item.target}><NavLink item={item} current={current} class={s.railItem} iconSize={20} /></li>)}
      </ul>
      <Account current={current} />
    </nav>
  );
}

const TABS: readonly Item[] = [...DAILY, { target: 'more', label: 'nav.more', icon: 'more' }];

export function TabBar({ current }: { current: Route }): JSX.Element {
  const inRare = current.name === 'section' && (RARE.some((item) => item.target === current.key) || current.key === 'device');
  return (
    <nav class={s.tabbar} aria-label={t('nav.main')}>
      {TABS.map((item) => (
        <NavLink
          key={item.target}
          item={item}
          current={inRare && item.target === 'more' ? { name: 'more' } : current}
          class={s.tab}
          iconSize={24}
        />
      ))}
    </nav>
  );
}
