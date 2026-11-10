import type { JSX } from 'preact';
import { tr } from '@/i18n/sections/team';
import { can } from '@/lib/assistant/store';
import { bootstrap } from '@/lib/live/store';
import { navigate } from '@/lib/router';
import { Tabs } from '@/ui/Tabs';
import { LogPanel } from './LogPanel';
import { PeoplePanel } from './PeoplePanel';
import { RolesPanel } from './RolesPanel';
import k from './team.module.css';

type Tab = 'people' | 'roles' | 'log';
const SUB: Record<Tab, string | undefined> = { people: undefined, roles: 'roles', log: 'log' };
const LABEL: Record<Tab, 'team.tab.people' | 'team.tab.roles' | 'team.tab.log'> = {
  people: 'team.tab.people', roles: 'team.tab.roles', log: 'team.tab.log',
};

/** Вкладки по правам (6.10): нет team:read — раздела нет; нет roles:manage — нет «Ролей»; нет audit:read — нет «Журнала». */
function tabsFor(): Tab[] {
  if (!can('team:read')) return [];
  const tabs: Tab[] = ['people'];
  if (can('roles:manage')) tabs.push('roles');
  if (can('audit:read')) tabs.push('log');
  return tabs;
}

/**
 * «Команда» (6.10): Люди · Роли · Журнал.
 * Адреса: /next/team, /next/team/roles, /next/team/log; карточка человека — /next/team/people/<id>, новый — /next/team/people/new.
 */
export function TeamScreen({ sub, item }: { sub?: string; item?: string }): JSX.Element {
  const ready = bootstrap.value !== null;
  const tabs = tabsFor();
  const asked: Tab = sub === 'roles' ? 'roles' : sub === 'log' ? 'log' : 'people';
  const tab: Tab | undefined = tabs.includes(asked) ? asked : tabs[0];
  return (
    <div class={k.screen}>
      <div class={k.inner}>
        <h1 class={k.title}>{tr('team.title')}</h1>
        {!ready ? <div class={k.skeleton} aria-hidden="true" /> : tabs.length === 0 ? <p class={k.muted}>{tr('team.noAccess')}</p> : (
          <>
            <div class={k.tabsScroll}>
              <Tabs<Tab> label={tr('team.title')} value={tab ?? 'people'}
                onChange={(next) => navigate({ name: 'section', key: 'team', ...(SUB[next] ? { sub: SUB[next] } : {}) }, true)}
                items={tabs.map((value) => ({ value, label: tr(LABEL[value]) }))} />
            </div>
            {tab === 'people' && <PeoplePanel {...(sub === 'people' && item ? { item } : {})} />}
            {tab === 'roles' && <RolesPanel />}
            {tab === 'log' && <LogPanel />}
          </>
        )}
      </div>
    </div>
  );
}
