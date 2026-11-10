import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useRef } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { Button } from './Button';
import { closeModal, openModal } from './layer';
import { usePresence } from './motion';
import s from './ui.module.css';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  side?: 'center' | 'right';
  /** wide — широкий лист (карточка Bedolaga); pane — боковая панель «Клиент». */
  size?: 'wide' | 'pane';
  children: ComponentChildren;
}

/**
 * Лист на нативном <dialog>: ловушка фокуса и возврат фокуса даёт браузер,
 * Esc закрывает только верхний слой (6.0). На телефоне — нижний лист.
 * Закрытие (кнопка, Esc, клик мимо) играет выход (M-3, M-4): содержимое и заголовок
 * держатся последними, пока идут кадры выхода, и только потом dialog.close().
 */
export function Sheet({ open, onClose, title, side = 'center', size, children }: SheetProps): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { mounted, closing } = usePresence(open);
  const live = useRef(open);
  live.current = open;
  const last = useRef({ title, children });
  if (open) last.current = { title, children };
  const close = (): void => { if (live.current) onClose(); };
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (mounted) openModal(dialog);
    else if (dialog.open) closeModal(dialog);
  }, [mounted]);
  useEffect(() => () => { if (ref.current) closeModal(ref.current); }, []);
  return (
    <dialog
      ref={ref}
      class={s.sheet}
      data-side={side}
      data-size={size}
      data-state={closing ? 'closing' : undefined}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClose={close}
      onClick={(event) => { if (event.target === ref.current) close(); }}
    >
      {mounted && (
        <>
          <div class={s.sheetHead}>
            <h2 class={s.sheetTitle} id={titleId}>{last.current.title}</h2>
            <Button variant="quiet" size="sm" icon="close" label={t('sheet.close')} onClick={close} />
          </div>
          <div class={s.sheetBody}>{last.current.children}</div>
        </>
      )}
    </dialog>
  );
}

interface OptionProps {
  checked?: boolean;
  label: string;
  hint?: string;
  onSelect: () => void;
}

/** Пункт выбора в листе (радио-группа). */
export function Option({ checked, label, hint, onSelect }: OptionProps): JSX.Element {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked ? 'true' : 'false'} class={s.option} onClick={onSelect}>
      <span class={s.optionMark} aria-hidden="true">{checked ? '✓' : ''}</span>
      <span class={s.optionText}>
        {label}
        {hint && <span class={s.optionHint}>{hint}</span>}
      </span>
    </button>
  );
}

export const sheetStyles = { text: s.sheetText, actions: s.sheetActions };
