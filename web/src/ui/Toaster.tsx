import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { dismissToast, toasts, type Toast } from '@/lib/actions/toasts';
import { Button } from './Button';
import s from './ui.module.css';

function ToastItem({ toast }: { toast: Toast }): JSX.Element {
  const [left, setLeft] = useState(toast.ttl ?? 0);
  const held = useRef(false);
  useEffect(() => {
    if (toast.ttl === null) return undefined;
    const timer = setInterval(() => {
      if (held.current) return;
      setLeft((value) => {
        const next = value - 250;
        if (next <= 0) dismissToast(toast.id);
        return next;
      });
    }, 250);
    return () => clearInterval(timer);
  }, [toast.id, toast.ttl]);
  const hold = (value: boolean) => () => { held.current = value; };
  return (
    <div
      class={s.toast}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={hold(true)}
      onMouseLeave={hold(false)}
      onFocusIn={hold(true)}
      onFocusOut={hold(false)}
    >
      <span class={s.toastText}>{toast.text}</span>
      {toast.action && (
        <button type="button" class={s.toastAction} onClick={toast.action.run}>
          {toast.action.label}
        </button>
      )}
      {toast.ttl !== null && toast.action && <span class={s.toastTimer} aria-hidden="true">{Math.max(1, Math.ceil(left / 1000))}</span>}
      <Button variant="quiet" size="sm" icon="close" label={t('toast.close')} class={s.toastClose} onClick={() => dismissToast(toast.id)} />
    </div>
  );
}

export function Toaster(): JSX.Element {
  return (
    <section class={s.toasts} aria-label={t('toast.region')}>
      {toasts.value.map((toast) => <ToastItem key={toast.id} toast={toast} />)}
    </section>
  );
}
