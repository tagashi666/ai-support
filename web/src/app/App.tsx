import type { JSX } from 'preact';
import { ChatsScreen } from '@/features/chats/ChatsScreen';
import { MoreScreen, Placeholder } from '@/features/placeholder/Placeholder';
import { Today } from '@/features/today/Today';
import { isDesktop, isSplit } from '@/lib/media';
import { route, type Route } from '@/lib/router';
import { announcement } from '@/lib/store/state';
import { Toaster } from '@/ui/Toaster';
import { LiveBar } from '@/features/live/LiveBar';
import { SignIn } from '@/features/live/SignIn';
import { mode, session } from '@/lib/live/store';
import { Workspace } from '@/features/workspace/Workspace';
import { DeviceScreen } from '@/features/device/DeviceScreen';
import { AssistantScreen } from '@/features/assistant/AssistantScreen';
import { PauseStrip } from '@/features/assistant/PauseControls';
import { LiveToday } from '@/features/today/LiveToday';
import { KeysHelp } from '@/features/palette/KeysHelp';
import { Palette } from '@/features/palette/Palette';
import { DemoBar } from './DemoBar';
import { lazyScreen } from './lazy';
import { useGlobalKeys } from './useGlobalKeys';
import { Rail, TabBar } from './Nav';
import s from './shell.module.css';

// «Знания» — отдельный чанк: в начальный JS не входят (этап 5).
const KnowledgeScreen = lazyScreen(
  () => import('@/features/knowledge/KnowledgeScreen').then((module) => module.KnowledgeScreen),
  () => <div class={s.lazy} aria-busy="true" />,
);

/**
 * Стартовый экран (вопрос 14.3а): телефон — «Сегодня», компьютер — «Диалоги»
 * со сжатым «Сегодня» справа, пока диалог не выбран.
 */
function resolveHome(current: Route, desktop: boolean): Route {
  if (current.name !== 'home') return current;
  return desktop ? { name: 'chats', id: null } : { name: 'today' };
}

function sectionScreen(current: Extract<Route, { name: 'section' }>, live: boolean): JSX.Element {
  if (current.key === 'device') return <DeviceScreen />;
  if (current.key === 'assistant' && live) return <AssistantScreen sub={current.sub} />;
  if (current.key === 'knowledge' && live) return <KnowledgeScreen sub={current.sub} item={current.item} />;
  return <Placeholder section={current.key} />;
}

export function App(): JSX.Element {
  useGlobalKeys();
  const desktop = isDesktop.value;
  const live = mode.value === 'live';
  const current = resolveHome(route.value, desktop);
  // Внутри открытого диалога на телефоне нижняя панель скрыта — высота уходит ленте (5.1).
  const inThread = current.name === 'chats' && current.id !== null && !isSplit.value;
  let screen: JSX.Element;
  if (live && session.value === 'expired') {
    screen = <SignIn again />;
  } else {
    switch (current.name) {
      case 'today': screen = live ? <LiveToday /> : <Today />; break;
      case 'chats': screen = live ? <Workspace id={current.id} client={current.client === true} /> : <ChatsScreen id={current.id} />; break;
      case 'more': screen = <MoreScreen />; break;
      case 'section': screen = sectionScreen(current, live); break;
      default: screen = live ? <LiveToday /> : <Today />;
    }
  }
  return (
    <div class={s.app} data-thread={inThread ? 'true' : 'false'} data-mode={live ? 'live' : 'demo'}>
      {live ? (inThread ? <span /> : <LiveBar />) : <DemoBar />}
      <div class={s.body}>
        {desktop && <Rail current={current} />}
        <main class={s.main}>{live && !inThread && session.value !== 'expired' && <PauseStrip />}{screen}</main>
      </div>
      {!desktop && !inThread ? <TabBar current={current} /> : <span />}
      {live && session.value !== 'expired' && <><Palette /><KeysHelp /></>}
      <Toaster />
      <div class="visually-hidden" aria-live="polite" aria-atomic="true">{announcement.value}</div>
    </div>
  );
}
