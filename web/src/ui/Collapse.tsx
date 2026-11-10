import type { ComponentChildren, JSX } from 'preact';
import { usePresence, dur } from './motion';

/**
 * Раскрывающийся блок (R2 C): сетка 0fr → 1fr (base.css .ui-collapse), без JS-измерения
 * высоты. Содержимое монтируется при открытии и снимается после закрытия (пока
 * сворачивается — inert), поэтому закрытое не стоит в дереве и не попадает в поиск.
 */
export function Collapse({ open, id, children, class: cls }: { open: boolean; id?: string; children: ComponentChildren; class?: string }): JSX.Element {
  const { mounted } = usePresence(open, dur('move'));
  return (
    <div class={cls ? `ui-collapse ${cls}` : 'ui-collapse'} data-open={open && mounted ? 'true' : 'false'} id={id} inert={!open || undefined}>
      <div>{mounted && children}</div>
    </div>
  );
}
