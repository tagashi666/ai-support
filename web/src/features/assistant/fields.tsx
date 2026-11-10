import type { JSX } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import type { AssistantSettings } from '@/lib/assistant/model';
import { can, offline } from '@/lib/assistant/store';
import { setDraft, valueOf } from '@/lib/assistant/draft';
import { Icon } from '@/ui/Icon';
import a from './assistant.module.css';

type NumKey = 'humanHoldMinutes' | 'maxAgeMinutes' | 'autoPerHour' | 'handoffRepeatMinutes' | 'minConfidence';
type TextKey = 'brand' | 'replyStyle' | 'handoffMessage' | 'model' | 'fallbackModel';

/** Нет права на ключ — поле видно с замком и словами «Меняет администратор» (6.7, правило 4). */
export const locked = (key: keyof AssistantSettings): boolean => !can(`setting:${key}`) || offline.value;

export function Lock({ field }: { field: keyof AssistantSettings }): JSX.Element | null {
  if (!locked(field)) return null;
  return <span class={a.lock}><Icon name="lock" size={14} />{offline.value ? t('assistant.offline') : t('assistant.locked')}</span>;
}

/**
 * Число с проверкой у самого поля (6.7, правило 3): неверное значение
 * в правку не попадает, причина — под полем, прежнее значение остаётся.
 * scale — показ в других единицах (часы для maxAgeMinutes).
 */
export function NumberField({ field, label, hint, min, max, step = 1, unit, scale = 1 }: {
  field: NumKey; label: string; hint?: string; min: number; max: number; step?: number; unit?: string; scale?: number;
}): JSX.Element {
  const id = useId();
  const stored = valueOf(field);
  const show = (value: number): string => String(Math.round((value / scale) * 100) / 100);
  const shown = stored === undefined ? '' : show(Number(stored));
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  // Значение, которое поставил сам ввод: его эффект не возвращает в поле, иначе
  // запоздалый эффект перетирает следующую нажатую клавишу.
  const pushed = useRef<string | null>(null);
  useEffect(() => {
    if (pushed.current === shown) return;
    pushed.current = null;
    setText(shown);
    setError(null);
  }, [shown]);
  const onInput = (value: string): void => {
    setText(value);
    const parsed = Number(value.replace(',', '.'));
    if (value.trim() === '' || !Number.isFinite(parsed) || parsed < min || parsed > max) {
      setError(t('assistant.range', { min, max }));
      return;
    }
    setError(null);
    const next = Math.round(parsed * scale * 100) / 100;
    pushed.current = show(next);
    setDraft(field, next);
  };
  return (
    <div class={a.numRow}>
      <label class={a.numLabel} for={id}>{label}{hint && <span class={a.hint}>{hint}</span>}</label>
      <span class={a.numInput}>
        <input id={id} class={a.input} type="number" inputMode="decimal" min={min} max={max} step={step} value={text}
          disabled={locked(field)} aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${id}-err` : undefined}
          onInput={(event) => onInput((event.target as HTMLInputElement).value)} />
        <span class={a.unit} aria-hidden={unit ? undefined : 'true'}>{unit}</span>
      </span>
      <Lock field={field} />
      {error && <span class={a.error} id={`${id}-err`} role="alert">{error}</span>}
    </div>
  );
}

export function TextField({ field, label, hint, multiline = false, min = 0, max }: {
  field: TextKey; label: string; hint?: string; multiline?: boolean; min?: number; max: number;
}): JSX.Element {
  const id = useId();
  const value = String(valueOf(field) ?? '');
  const [error, setError] = useState<string | null>(null);
  const onInput = (next: string): void => {
    const length = next.trim().length;
    if (length < min || length > max) setError(t('assistant.length', { min, max }));
    else setError(null);
    setDraft(field, next);
  };
  const props = {
    id, class: multiline ? a.textarea : a.input, value, disabled: locked(field), maxLength: max,
    'aria-invalid': error ? 'true' as const : undefined, 'aria-describedby': error ? `${id}-err` : undefined,
  };
  return (
    <div class={a.field}>
      <label class={a.label} for={id}>{label}</label>
      {hint && <span class={a.hint}>{hint}</span>}
      {multiline
        ? <textarea {...props} rows={4} onInput={(event) => onInput((event.target as HTMLTextAreaElement).value)} />
        : <input {...props} type="text" onInput={(event) => onInput((event.target as HTMLInputElement).value)} />}
      <Lock field={field} />
      {error && <span class={a.error} id={`${id}-err`} role="alert">{error}</span>}
    </div>
  );
}

export function Switch({ label, hint, checked, disabled, onChange }: {
  label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <label class={a.toggle}>
      <span class={a.toggleText}>{label}{hint && <span class={a.hint}>{hint}</span>}</span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled}
        onChange={(event) => onChange((event.target as HTMLInputElement).checked)} />
    </label>
  );
}
