import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { LiveClient } from '@/features/client/LiveClient';
import { LiveToday } from '@/features/today/LiveToday';
import { t } from '@/i18n/ru';
import { layerOpen } from '@/lib/keys';
import { isHuge, isSplit, isWide } from '@/lib/media';
import { navigate } from '@/lib/router';
import { clientPinned } from '@/lib/store/state';
import { itemOf, undoLast } from '@/lib/workspace/actions';
import { patches } from '@/lib/workspace/local';
import { threads } from '@/lib/workspace/thread';
import { inbox } from '@/lib/live/store';
import { Sheet } from '@/ui/Sheet';
import s from '@/features/chats/chats.module.css';
import { lazyScreen } from '@/app/lazy';
import { TUTORIAL_ID } from '@/lib/onboarding';
import { WorkList } from './WorkList';

// Учебный диалог (6.13 В) — свой чанк: живёт в браузере, сервер о нём не знает.
const TutorialThread = lazyScreen(() => import('@/features/onboarding/Tutorial').then((module) => module.TutorialThread), () => <div aria-busy="true" />);
import { WorkThread } from './WorkThread';

/**
 * «Диалоги» на живых данных (6.0, 6.2, 6.3): <768 — стек экранов (список →
 * диалог, системное «Назад» по шагам), ≥768 — список и диалог рядом.
 * «Клиент» (6.4): от 1440 px — колонка справа (от 1800 закреплена по
 * умолчанию), уже — боковой лист, на телефоне — нижний лист; адрес
 * /next/chats/<id>/client. Панель не перекрывает поле ответа на широком экране.
 */
export function Workspace({ id, client = false }: { id: string | null; client?: boolean }): JSX.Element {
  const open = id !== null && /^\d+$/.test(id) ? Number(id) : null;
  threads.value; inbox.value; patches.value;
  const item = open !== null ? itemOf(open) : undefined;
  const pinned = clientPinned.value ?? isHuge.value;
  const column = open !== null && item !== undefined && isWide.value && (client || pinned);
  const sheet = open !== null && item !== undefined && client && !isWide.value;
  const closeClient = (): void => {
    if (isWide.value && !client) clientPinned.value = false;
    if (client) navigate({ name: 'chats', id: String(open) }, true);
    else clientPinned.value = false;
  };

  // ⌘Z вне поля ввода — отменить последнее действие (7.3).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.code !== 'KeyZ' || !(event.metaKey || event.ctrlKey) || event.shiftKey) return;
      if ((event.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]')) return;
      if (event.defaultPrevented || layerOpen()) return;
      if (undoLast()) event.preventDefault();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  return (
    <div class={s.screen} data-open={open !== null || id === TUTORIAL_ID ? 'true' : 'false'} data-client={column ? 'true' : 'false'}>
      <section class={s.listCol}>
        <WorkList openId={open} tutorialOpen={id === TUTORIAL_ID} />
      </section>
      <section class={s.threadCol}>
        {open !== null ? <WorkThread key={open} id={open} />
          : id === TUTORIAL_ID ? <TutorialThread />
          : <div class={s.summary}><LiveToday compact /></div>}
      </section>
      {column && item && open !== null && (
        <aside class={s.clientCol} aria-label={t('client.title')}>
          <LiveClient key={open} id={open} item={item} onClose={closeClient} />
        </aside>
      )}
      {open !== null && item && (
        <Sheet open={sheet} onClose={closeClient} title={t('client.title')} side={isSplit.value ? 'right' : 'center'} size="pane">
          {sheet && <LiveClient key={open} id={open} item={item} onClose={closeClient} inSheet />}
        </Sheet>
      )}
    </div>
  );
}
