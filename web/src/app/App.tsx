import type { JSX } from 'preact';
import { ChatsScreen } from '@/features/chats/ChatsScreen';
import { MoreScreen, Placeholder } from '@/features/placeholder/Placeholder';
import { Today } from '@/features/today/Today';
import { isDesktop, isSplit } from '@/lib/media';
import { route, type Route } from '@/lib/router';
import { announcement } from '@/lib/store/state';
import { Toaster } from '@/ui/Toaster';
import { LiveBar } from '@/features/live/LiveBar';
import { LiveSummary } from '@/features/live/LiveSummary';
import { SignIn } from '@/features/live/SignIn';
import { mode, session } from '@/lib/live/store';
import { Workspace } from '@/features/workspace/Workspace';
import { DemoBar } from './DemoBar';
import { Rail, TabBar } from './Nav';
import s from './shell.module.css';

/**
 * Стартовый экран (вопрос 14.3а): телефон — «Сегодня», компьютер — «Диалоги»
 * со сводкой справа. В живом режиме «Сегодня» ещё нет — сразу список.
 */
function resolveHome(current: Route, desktop: boolean, live: boolean): Route {
  if (current.name !== 'home') return current;
  return desktop || live ? { name: 'chats', id: null } : { name: 'today' };
}

export function App(): JSX.Element {
  const desktop = isDesktop.value;
  const live = mode.value === 'live';
  const current = resolveHome(route.value, desktop, live);
  // Внутри открытого диалога на телефоне нижняя панель скрыта — высота уходит ленте (5.1).
  const inThread = current.name === 'chats' && current.id !== null && !isSplit.value;
  let screen: JSX.Element;
  if (live && session.value === 'expired') {
    screen = <SignIn again />;
  } else {
    switch (current.name) {
      case 'today': screen = live ? <LiveSummary wide /> : <Today />; break;
      case 'chats': screen = live ? <Workspace id={current.id} /> : <ChatsScreen id={current.id} />; break;
      case 'more': screen = <MoreScreen />; break;
      case 'section': screen = <Placeholder section={current.key} />; break;
      default: screen = live ? <LiveSummary wide /> : <Today />;
    }
  }
  return (
    <div class={s.app} data-thread={inThread ? 'true' : 'false'} data-mode={live ? 'live' : 'demo'}>
      {live ? (inThread ? <span /> : <LiveBar />) : <DemoBar />}
      <div class={s.body}>
        {desktop && <Rail current={current} />}
        <main class={s.main}>{screen}</main>
      </div>
      {!desktop && !inThread ? <TabBar current={current} /> : <span />}
      <Toaster />
      <div class="visually-hidden" aria-live="polite" aria-atomic="true">{announcement.value}</div>
    </div>
  );
}
