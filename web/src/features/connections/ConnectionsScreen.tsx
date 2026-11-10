import type { JSX } from 'preact';
import { tr } from '@/i18n/sections/connections';
import { bootstrap } from '@/lib/live/store';
import { rights } from '@/lib/connections/store';
import { navigate } from '@/lib/router';
import { Tabs } from '@/ui/Tabs';
import { ChannelsPanel } from './ChannelsPanel';
import { FoldersPanel } from './FoldersPanel';
import c from './connections.module.css';

type Tab = 'channels' | 'folders';

/**
 * «Подключения» (6.11): Каналы и источники · Папки. Без settings:read раздела нет,
 * без settings:sources нет «Папок» и «Подключить».
 */
export function ConnectionsScreen({ sub, item }: { sub?: string; item?: string }): JSX.Element {
  void item;
  const ready = bootstrap.value !== null;
  const r = rights.value;
  const tabs: Tab[] = r.read ? (r.sources ? ['channels', 'folders'] : ['channels']) : [];
  const asked: Tab = sub === 'folders' ? 'folders' : 'channels';
  const tab: Tab | undefined = tabs.includes(asked) ? asked : tabs[0];
  return (
    <div class={c.screen}>
      <div class={c.inner}>
        <h1 class={c.title}>{tr('connections.title')}</h1>
        {!ready ? <div class={c.skeleton} key="skeleton" aria-hidden="true" /> : !tab ? <p class={c.muted}>{tr('connections.noAccess')}</p> : (
          <>
            {tabs.length > 1 && (
              <div class={c.tabsScroll}>
                <Tabs<Tab> label={tr('connections.title')} value={tab}
                  onChange={(next) => navigate({ name: 'section', key: 'connections', ...(next === 'folders' ? { sub: 'folders' } : {}) }, true)}
                  items={tabs.map((value) => ({ value, label: tr(value === 'channels' ? 'connections.tab.channels' : 'connections.tab.folders') }))} />
              </div>
            )}
            {tab === 'channels' && <ChannelsPanel />}
            {tab === 'folders' && <FoldersPanel />}
          </>
        )}
      </div>
    </div>
  );
}
