import type { JSX } from 'preact';
import { ChatsScreen } from '@/features/chats/ChatsScreen';
import { MoreScreen, Placeholder } from '@/features/placeholder/Placeholder';
import { Today } from '@/features/today/Today';
import { isDesktop, isSplit } from '@/lib/media';
import { route, type Route } from '@/lib/router';
import { announcement } from '@/lib/store/state';
import { Toaster } from '@/ui/Toaster';
import { DemoBar } from './DemoBar';
import { Rail, TabBar } from './Nav';
import s from './shell.module.css';

/** Стартовый экран (вопрос 14.3а): телефон — «Сегодня», компьютер — «Диалоги» со сводкой справа. */
function resolveHome(current: Route, desktop: boolean): Route {
  if (current.name !== 'home') return current;
  return desktop ? { name: 'chats', id: null } : { name: 'today' };
}

export function App(): JSX.Element {
  const desktop = isDesktop.value;
  const current = resolveHome(route.value, desktop);
  // Внутри открытого диалога на телефоне нижняя панель скрыта — высота уходит ленте (5.1).
  const inThread = current.name === 'chats' && current.id !== null && !isSplit.value;
  let screen: JSX.Element;
  switch (current.name) {
    case 'today': screen = <Today />; break;
    case 'chats': screen = <ChatsScreen id={current.id} />; break;
    case 'more': screen = <MoreScreen />; break;
    case 'section': screen = <Placeholder section={current.key} />; break;
    default: screen = <Today />;
  }
  return (
    <div class={s.app} data-thread={inThread ? 'true' : 'false'}>
      <DemoBar />
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
