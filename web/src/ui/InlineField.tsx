import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import s from './inline.module.css';

interface InlineFieldProps {
  /** Видимая подпись поля (для доступности — label). */
  label: string;
  value: string;
  placeholder?: string;
  type?: 'text' | 'number';
  min?: number;
  max?: number;
  maxLength?: number;
  disabled?: boolean;
  /** Сохранение: бросает ошибку — текст показывается у поля, значение остаётся введённым. */
  onSave: (next: string) => Promise<void>;
  /** Скрыть подпись визуально (в таблице подпись — заголовок столбца). */
  hideLabel?: boolean;
}

/**
 * Мелкое поле с правкой на месте (6.9, 6.12): Enter сохраняет, Esc отменяет,
 * рядом «Сохраняется…» → «Сохранено ✓» или ошибка у поля. Общий паттерн для
 * имени сервера «для помощника», целей сроков ответа и других мелких полей.
 */
export function InlineField({ label, value, placeholder, type = 'text', min, max, maxLength, disabled, onSave, hideLabel }: InlineFieldProps): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const saved = useRef<number | undefined>(undefined);
  useEffect(() => { if (state !== 'saving') setDraft(value); }, [value]);
  useEffect(() => () => window.clearTimeout(saved.current), []);
  const id = useRef(`f${Math.random().toString(36).slice(2, 9)}`).current;

  const commit = async (): Promise<void> => {
    if (draft === value || state === 'saving') return;
    setState('saving');
    try {
      await onSave(draft);
      setState('saved');
      window.clearTimeout(saved.current);
      saved.current = window.setTimeout(() => setState('idle'), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') { event.preventDefault(); void commit(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft(value); setState('idle'); }
  };
  return (
    <div class={s.field}>
      <label for={id} class={hideLabel ? 'visually-hidden' : s.label}>{label}</label>
      <div class={s.line}>
        <input id={id} class={s.input} type={type} value={draft} placeholder={placeholder} min={min} max={max} maxLength={maxLength}
          disabled={disabled} aria-invalid={state === 'error' ? 'true' : undefined} aria-describedby={`${id}-state`}
          onInput={(event) => { setDraft((event.target as HTMLInputElement).value); if (state !== 'saving') setState('idle'); }}
          onKeyDown={onKeyDown} onBlur={() => { if (draft !== value) void commit(); }} />
        <span id={`${id}-state`} class={s.state} data-state={state} aria-live="polite">
          {state === 'saving' ? t('field.saving') : state === 'saved' ? t('field.saved')
            : state === 'error' ? t('field.failed', { reason: error }) : draft !== value ? t('field.hint', { save: 'Enter', cancel: 'Esc' }) : ''}
        </span>
      </div>
    </div>
  );
}
