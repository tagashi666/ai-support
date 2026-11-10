import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';
import { useSlide } from './motion';
import s from './ui.module.css';

/**
 * Сегменты-переключатель (radiogroup на скрытых radio): выбранный подсвечивает
 * скользящий индикатор (R2 C), начертание не меняется — ширина не прыгает.
 */
export function Segmented<V extends string | number>({ label, name, value, items, onChange }: {
  label: string;
  /** Имя группы radio (по умолчанию — подпись). */
  name?: string;
  value: V;
  items: ReadonlyArray<{ value: V; label: string }>;
  onChange: (value: V) => void;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const ind = useRef<HTMLSpanElement>(null);
  useSlide(host, ind, '[data-checked="true"]', value);
  return (
    <div class={`${s.seg} ui-slide`} role="radiogroup" aria-label={label} ref={host}>
      <span class="ui-slide-ind" ref={ind} aria-hidden="true" />
      {items.map((item) => (
        <label key={String(item.value)} class={s.segItem} data-checked={item.value === value ? 'true' : 'false'}>
          <input type="radio" name={name ?? label} checked={item.value === value} onChange={() => onChange(item.value)} />
          <span>{item.label}</span>
        </label>
      ))}
    </div>
  );
}
