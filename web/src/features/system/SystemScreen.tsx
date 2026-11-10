import type { JSX } from 'preact';
import { tr } from '@/i18n/sections/system';
import { bootstrap } from '@/lib/live/store';
import { navigate } from '@/lib/router';
import { rights } from '@/lib/system/store';
import { Tabs } from '@/ui/Tabs';
import { HealthPanel } from './HealthPanel';
import { NotificationsPanel } from './NotificationsPanel';
import { PanelPanel } from './PanelPanel';
import { ServersPanel } from './ServersPanel';
import { UpdatePanel } from './UpdatePanel';
import s from './system.module.css';

type Tab = 'health' | 'servers' | 'update' | 'notifications' | 'panel';
const SUB: Record<Tab, string | undefined> = { health: undefined, servers: 'servers', update: 'update', notifications: 'notifications', panel: 'panel' };

/** Вкладки по правам (6.9, состояния): без settings:update нет «Обновления», серверы — при чтении настроек и включённом опросе. */
function tabsFor(): Tab[] {
  const r = rights.value;
  if (!r.diagnostics) return [];
  const tabs: Tab[] = ['health'];
  if (r.servers) tabs.push('servers');
  if (r.update) tabs.push('update');
  if (r.read) tabs.push('notifications', 'panel');
  return tabs;
}

function labelOf(tab: Tab): string {
  return tab === 'health' ? tr('system.tab.health') : tab === 'servers' ? tr('system.tab.servers')
    : tab === 'update' ? tr('system.tab.update') : tab === 'panel' ? tr('system.tab.panel') : tr('system.tab.notifications');
}

/** «Система» (6.9): Здоровье · Серверы · Обновление · Уведомления · Панель (этап 8). */
export function SystemScreen({ sub }: { sub?: string; item?: string }): JSX.Element {
  const ready = bootstrap.value !== null;
  const tabs = tabsFor();
  const asked = (Object.keys(SUB) as Tab[]).find((tab) => SUB[tab] === sub) ?? 'health';
  const tab: Tab | undefined = tabs.includes(asked) ? asked : tabs[0];
  return (
    <div class={s.screen}>
      <div class={s.inner}>
        <h1 class={s.title}>{tr('system.title')}</h1>
        {!ready ? <div class={s.skeleton} key="skeleton" aria-hidden="true" /> : tabs.length === 0 ? <p class={s.muted}>{tr('system.noAccess')}</p> : (
          <>
            <div class={s.tabsScroll}>
              <Tabs<Tab> label={tr('system.title')} value={tab ?? 'health'}
                onChange={(next) => navigate({ name: 'section', key: 'system', ...(SUB[next] ? { sub: SUB[next] } : {}) }, true)}
                items={tabs.map((value) => ({ value, label: labelOf(value) }))} />
            </div>
            {tab === 'health' && <HealthPanel />}
            {tab === 'servers' && <ServersPanel />}
            {tab === 'update' && <UpdatePanel />}
            {tab === 'notifications' && <NotificationsPanel />}
            {tab === 'panel' && <PanelPanel />}
          </>
        )}
      </div>
    </div>
  );
}
