import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { LiveSummary } from '@/features/live/LiveSummary';
import { undoLast } from '@/lib/workspace/actions';
import s from '@/features/chats/chats.module.css';
import { WorkList } from './WorkList';
import { WorkThread } from './WorkThread';

/**
 * «Диалоги» на живых данных (6.0, 6.2, 6.3): <768 — стек экранов (список →
 * диалог, системное «Назад» по шагам), ≥768 — список и диалог рядом.
 * Панель «Клиент» — этап 3б; до него — ссылка в классику.
 */
export function Workspace({ id }: { id: string | null }): JSX.Element {
  const open = id !== null && /^\d+$/.test(id) ? Number(id) : null;

  // ⌘Z вне поля ввода — отменить последнее действие (7.3).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.code !== 'KeyZ' || !(event.metaKey || event.ctrlKey) || event.shiftKey) return;
      if ((event.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]')) return;
      if (undoLast()) event.preventDefault();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  return (
    <div class={s.screen} data-open={open !== null ? 'true' : 'false'} data-client="false">
      <section class={s.listCol}>
        <WorkList openId={open} />
      </section>
      <section class={s.threadCol}>
        {open !== null ? <WorkThread key={open} id={open} /> : <div class={s.summary}><LiveSummary /></div>}
      </section>
    </div>
  );
}
