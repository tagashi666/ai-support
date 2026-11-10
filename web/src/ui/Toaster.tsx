import { render, type JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { dismissToast, toasts, type Toast } from '@/lib/actions/toasts';
import { Button } from './Button';
import { addFloating } from './layer';
import { flip, measure, useExitList } from './motion';
import s from './ui.module.css';

/**
 * Тост. Наведение или фокус ставят паузу — и отсчёту, и действию за ним
 * (toast.hold → deferred.pause, M-2): «Отменить» не может «протухнуть», пока на него смотрят.
 */
/*
 * Где мышь была, когда тост появился: тост, выросший под неподвижным курсором, паузу не
 * ставит, а настоящее движение — ставит. movementX в WebKit у синтетических событий бывает
 * нулевым, поэтому сравниваем и координаты (R2 D: одинаково во всех движках).
 */
const pointer = { x: Number.NaN, y: Number.NaN };
if (typeof window !== 'undefined') {
  window.addEventListener('pointermove', (event) => { pointer.x = event.clientX; pointer.y = event.clientY; }, { capture: true, passive: true });
}

function ToastItem({ toast, leaving }: { toast: Toast; leaving: boolean }): JSX.Element {
  const born = useRef({ x: pointer.x, y: pointer.y });
  // Остаток — без перерисовки: показывает его полоса, голой цифры нет (R-38).
  const left = useRef(toast.ttl ?? 0);
  const [held, setHeld] = useState(false);
  const heldRef = useRef(false);
  const hold = (value: boolean): void => {
    if (heldRef.current === value) return;
    heldRef.current = value;
    setHeld(value);
    toast.hold?.(value);
  };
  useEffect(() => {
    if (toast.ttl === null) return undefined;
    const timer = setInterval(() => {
      if (heldRef.current) return;
      left.current -= 250;
      if (left.current <= 0) dismissToast(toast.id);
    }, 250);
    return () => clearInterval(timer);
  }, [toast.id, toast.ttl]);
  // Тост ушёл, пока на нём курсор (вытеснен четвёртым) — снять паузу с действия.
  useEffect(() => () => { if (heldRef.current) toast.hold?.(false); }, []);
  useEffect(() => { if (leaving) hold(false); }, [leaving]);
  const timed = toast.ttl !== null && toast.action;
  return (
    <div
      class={s.toast}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      data-state={leaving ? 'closing' : undefined}
      data-held={held ? 'true' : undefined}
      style={timed ? { '--ttl': `${toast.ttl}ms` } : undefined}
      // Пауза — от настоящего движения курсора: тост, всплывший под неподвижным курсором
      // (браузер шлёт «пустой» mousemove после перестройки), окно отмены не держит.
      onPointerMove={(event) => {
        if (event.pointerType !== 'mouse') return;
        if (event.movementX || event.movementY || event.clientX !== born.current.x || event.clientY !== born.current.y) hold(true);
      }}
      onPointerLeave={() => hold(false)}
      onFocusIn={() => hold(true)}
      onFocusOut={() => hold(false)}
    >
      <span class={s.toastText}>{toast.text}</span>
      {toast.action && (
        <button type="button" class={s.toastAction} onClick={toast.action.run}>
          {toast.action.label}
        </button>
      )}
      <Button variant="quiet" size="sm" icon="close" label={t('toast.close')} class={s.toastClose} onClick={() => dismissToast(toast.id)} />
      {timed && <span class={s.toastBar} aria-hidden="true" />}
    </div>
  );
}

function Stack({ host }: { host: HTMLElement }): JSX.Element {
  const list = useExitList(toasts.value, (toast) => toast.id);
  const before = useRef(new Map<Element, number>());
  // Соседи съезжают на место ушедшего плавно (M-11).
  useLayoutEffect(() => { flip(host, before.current); before.current = measure(host); });
  return <>{list.map(({ item, leaving }) => <ToastItem key={item.id} toast={item} leaving={leaving} />)}</>;
}

/**
 * Стопка тостов в своём корне: узел живёт в верхнем слое и переезжает в верхний
 * открытый лист (ui/layer.ts, W-1), поэтому его DOM не принадлежит дереву App.
 */
export function Toaster(): null {
  useEffect(() => {
    const host = document.createElement('section');
    host.className = s.toasts ?? '';
    host.setAttribute('aria-label', t('toast.region'));
    const drop = addFloating(host);
    render(<Stack host={host} />, host);
    return () => { render(null, host); drop(); };
  }, []);
  return null;
}
