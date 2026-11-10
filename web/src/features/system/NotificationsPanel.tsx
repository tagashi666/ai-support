import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { tr } from '@/i18n/sections/system';
import { showToast } from '@/lib/actions/toasts';
import { levelHint, levelLabel, NOTIFY_LEVELS } from '@/lib/system/model';
import { changeLevel, loadNotifications, notifications, rights, sendTestAlert } from '@/lib/system/store';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import s from './system.module.css';

/** «Уведомления» (6.9): что присылать в Telegram и проверка отправки. */
export function NotificationsPanel(): JSX.Element {
  useEffect(() => { void loadNotifications(); }, []);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const info = notifications.value;
  const r = rights.value;
  if (info === undefined) return <div class={s.panel} aria-busy="true"><div class={s.skeleton} aria-hidden="true" /></div>;
  if (info === null) {
    return (
      <div class={s.panel}>
        <p class={s.error} role="alert">{tr('system.notify.loadFailed')}</p>
        <div class={s.actions}><Button variant="secondary" onClick={() => void loadNotifications()}>{tr('system.retry')}</Button></div>
      </div>
    );
  }
  const test = async (): Promise<void> => {
    setTesting(true);
    const res = await sendTestAlert();
    setTesting(false);
    const text = res.ok ? tr('system.notify.testOk') : tr('system.notify.testFailed', { reason: res.reason });
    setResult({ ok: res.ok, text });
    if (!res.ok) showToast({ text, kind: 'error', ttl: null });
  };
  return (
    <div class={s.panel}>
      {!info.configured && (
        <div class={s.result} data-tone="warn" role="status">
          <p class={s.subhead}>{tr('system.notify.unsetTitle')}</p>
          <p>{tr('system.notify.unsetText')}</p>
        </div>
      )}
      {info.lastError && <p class={s.error} role="alert">{tr('system.notify.lastError', { reason: info.lastError })}</p>}
      <Card label={tr('system.notify.what')}>
        <fieldset class={s.levels}>
          <legend class={s.cardHead}>{tr('system.notify.what')}</legend>
          {NOTIFY_LEVELS.map((level) => (
            <label key={level} class={s.levelOpt} data-checked={info.level === level}>
              <input type="radio" name="notify-level" checked={info.level === level} disabled={!r.level}
                onChange={() => void changeLevel(level, levelLabel)} />
              <span class={s.levelName}>{levelLabel(level)}</span>
              <span class={s.muted}>{levelHint(level)}</span>
            </label>
          ))}
        </fieldset>
        {!r.level && <p class={s.hint}>{tr('system.notify.levelLocked')}</p>}
      </Card>
      <Card label={tr('system.notify.test')}>
        <h2 class={s.cardHead}>{tr('system.notify.testTitle')}</h2>
        <p class={s.muted}>{tr('system.notify.testText')}</p>
        <div class={s.actions}>
          {r.alerts && <Button variant="secondary" disabled={testing || !info.configured} onClick={() => void test()}>{tr('system.notify.test')}</Button>}
        </div>
        {result && <p class={result.ok ? s.muted : s.error} role="status">{result.text}</p>}
      </Card>
    </div>
  );
}
