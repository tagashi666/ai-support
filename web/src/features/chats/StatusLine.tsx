import type { JSX } from 'preact';
import { t } from '@/i18n/ru';
import { resume } from '@/lib/actions/chat';
import { clock } from '@/lib/format/format';
import { pausedUntil } from '@/lib/store/state';
import s from './chats.module.css';

/**
 * Строка состояния (5.1): место зарезервировано заранее, поэтому её
 * появление ничего не сдвигает. В норме пустая.
 */
export function StatusLine(): JSX.Element {
  const paused = pausedUntil.value;
  return (
    <div class={s.status} role="status" data-active={paused !== null ? 'true' : 'false'}>
      {paused !== null && (
        <>
          <span>{t('status.paused', { time: clock(paused) })}</span>
          <button type="button" class={s.statusAction} onClick={resume}>{t('status.resume')}</button>
        </>
      )}
    </div>
  );
}
