import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { clock } from '@/lib/format/format';
import { connection, rightsChanged, startLive, syncedAt } from '@/lib/live/store';
import s from '@/features/chats/chats.module.css';

/** «Восстанавливаем связь…» показывается не сразу: короткий обрыв не мигает строкой (6.14). */
const RESTORING_DELAY_MS = 3000;

/**
 * Строка связи в три ступени (6.14): «Восстанавливаем связь…» (серая, через
 * 3 с) → «Нет связи · данные на 14:02 · Повторить» (янтарная) → «Связь есть,
 * обновляем…». В норме строки нет; место под неё зарезервировано.
 */
export function ConnectionLine(): JSX.Element {
  const state = connection.value;
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (state !== 'restoring') { setLate(false); return undefined; }
    const timer = setTimeout(() => setLate(true), RESTORING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state]);

  let text: string | null = null;
  let tone: 'quiet' | 'attention' = 'quiet';
  if (rightsChanged.value) text = t('live.rightsChanged');
  else if (state === 'restoring' && late) text = t('connection.restoring');
  else if (state === 'offline') {
    text = t('connection.offline', { time: syncedAt.value ? clock(syncedAt.value) : '—' });
    tone = 'attention';
  } else if (state === 'syncing') text = t('connection.syncing');

  return (
    <div class={s.status} role="status" data-active={tone === 'attention' && text ? 'true' : 'false'} data-connection={state}>
      {text && <span>{text}</span>}
      {state === 'offline' && (
        <button type="button" class={s.statusAction} onClick={() => { void startLive(); }}>{t('connection.retry')}</button>
      )}
    </div>
  );
}
