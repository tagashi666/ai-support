import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';
import s from './ui.module.css';

export interface TabItem<V extends string> {
  value: V;
  label: string;
  count?: number;
}

interface TabsProps<V extends string> {
  items: readonly TabItem<V>[];
  value: V;
  onChange: (value: V) => void;
  label: string;
  stretch?: boolean;
}

/** Вкладки: tablist / tab со стрелками и одной остановкой Tab (8.7). */
export function Tabs<V extends string>({ items, value, onChange, label, stretch }: TabsProps<V>): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = items.findIndex((item) => item.value === value);
    const next = items[(index + (event.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
    if (!next) return;
    onChange(next.value);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus());
  };
  return (
    <div class={s.tabs} data-stretch={stretch ? 'true' : undefined} role="tablist" aria-label={label} ref={ref} onKeyDown={onKeyDown}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          class={s.tab}
          aria-selected={item.value === value}
          tabIndex={item.value === value ? 0 : -1}
          onClick={() => onChange(item.value)}
        >
          {item.label}
          {item.count !== undefined && item.count > 0 && <span class={`${s.tabCount} num`}>{item.count}</span>}
        </button>
      ))}
    </div>
  );
}
