import type { ComponentChildren, JSX } from 'preact';
import { tr } from '@/i18n/sections/team';
import { Button } from '@/ui/Button';
import type { LoadState } from '@/lib/team/store';
import k from './team.module.css';

/** Скелет при загрузке; ошибка блока — с причиной и «Повторить» (не роняет страницу). */
export function BlockState({ state, error, onRetry, children }: {
  state: LoadState; error: string; onRetry: () => void; children: ComponentChildren;
}): JSX.Element {
  if (state === 'idle' || state === 'loading') return <div class={k.skeleton} key="skeleton" aria-hidden="true" />;
  if (state === 'error') {
    return (
      <div class={k.block} role="alert">
        <span class={k.error}>{tr('team.loadFail', { reason: error })}</span>
        <Button variant="secondary" size="sm" onClick={onRetry}>{tr('team.retry')}</Button>
      </div>
    );
  }
  return <>{children}</>;
}
