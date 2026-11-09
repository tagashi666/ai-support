import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useRef } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { Button } from './Button';
import s from './ui.module.css';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  side?: 'center' | 'right';
  children: ComponentChildren;
}

/**
 * Лист на нативном <dialog>: ловушка фокуса и возврат фокуса даёт браузер,
 * Esc закрывает только верхний слой (6.0). На телефоне — нижний лист.
 */
export function Sheet({ open, onClose, title, side = 'center', children }: SheetProps): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      class={s.sheet}
      data-side={side}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => { if (event.target === ref.current) onClose(); }}
    >
      {open && (
        <>
          <div class={s.sheetHead}>
            <h2 class={s.sheetTitle} id={titleId}>{title}</h2>
            <Button variant="quiet" size="sm" icon="close" label={t('sheet.close')} onClick={onClose} />
          </div>
          <div class={s.sheetBody}>{children}</div>
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
