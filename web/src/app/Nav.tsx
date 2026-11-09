import type { JSX } from 'preact';
import { ME } from '@/demo/seed';
import { t, type Key } from '@/i18n/ru';
import { href, navigate, type Route, type SectionKey } from '@/lib/router';
import { bootstrap, liveMine, mode } from '@/lib/live/store';
import { pausedUntil, waitingYou } from '@/lib/store/state';
import { Avatar } from '@/ui/Avatar';
import { Icon, type IconName } from '@/ui/Icon';
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

/** Ссылка-раздел: настоящая ссылка (открыть в новой вкладке можно), переход — без перезагрузки. */
function NavLink({ item, current, class: cls, iconSize }: { item: Item; current: Route; class?: string; iconSize: number }): JSX.Element {
  const route = routeOf(item.target);
  const live = mode.value === 'live';
  // Бейдж «Диалогов» — всегда «Ждут вас» (7.1 п.9): в живом режиме — число сервера.
  const waiting = live ? liveMine.value : waitingYou.value.length;
  const ideas = live ? bootstrap.value?.counts.ideas ?? 0 : 7;
  const paused = !live && pausedUntil.value !== null;
  return (
    <a
      class={cls}
      href={href(route)}
      aria-current={isCurrent(item.target, current) ? 'page' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(route);
      }}
    >
      <span class={s.railIcon}>
        <Icon name={item.icon} size={iconSize} />
        {item.target === 'chats' && waiting > 0 && <span class={s.badge}>{waiting}</span>}
        {item.target === 'knowledge' && ideas > 0 && <span class={s.badge} data-tone="quiet">{ideas}</span>}
        {item.target === 'assistant' && paused && <span class={s.dot} />}
      </span>
      <span>{t(item.label)}</span>
    </a>
  );
}

export function Rail({ current }: { current: Route }): JSX.Element {
  return (
    <nav class={s.rail} aria-label={t('nav.main')}>
      <ul class={s.railList}>
        <li>
          <button type="button" class={s.railItem} onClick={() => {
            navigate({ name: 'chats', id: null });
            requestAnimationFrame(() => document.getElementById('chat-search')?.focus());
          }}>
            <span class={s.railIcon}><Icon name="search" size={22} /></span>
            <span>{t('nav.search')}</span>
          </button>
        </li>
      </ul>
      <div class={s.railSep} />
      <ul class={s.railList}>
        {DAILY.map((item) => <li key={item.target}><NavLink item={item} current={current} class={s.railItem} iconSize={22} /></li>)}
      </ul>
      <div class={s.railSep} />
      <ul class={s.railList}>
        {RARE.map((item) => <li key={item.target}><NavLink item={item} current={current} class={`${s.railItem} ${s.railRare}`} iconSize={20} /></li>)}
      </ul>
      <div class={s.railFoot}>
        <Avatar name={ME.name} size="s" />
        <span class={s.railName}>{ME.name}</span>
        <span class={s.railRole}>{t('nav.role.owner')}</span>
      </div>
    </nav>
  );
}

const TABS: readonly Item[] = [...DAILY, { target: 'more', label: 'nav.more', icon: 'more' }];

export function TabBar({ current }: { current: Route }): JSX.Element {
  const inRare = current.name === 'section' && RARE.some((item) => item.target === current.key);
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
