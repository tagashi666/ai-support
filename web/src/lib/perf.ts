import { Component, type ComponentType, type JSX } from 'preact';
/**
 * Счётчик отрисовок для замеров (scripts/perfbench.ts, R2 D): только в сборке с
 * VITE_PERF=1 — в обычной сборке тело пустое и вызовы вырезаются.
 */
export function countRender(name: string): void {
  if (import.meta.env.VITE_PERF !== '1') return;
  const w = window as unknown as { __renders?: Record<string, number> };
  const map = (w.__renders ??= {});
  map[name] = (map[name] ?? 0) + 1;
}

/**
 * memo для строк списков без preact/compat (R2 D): перерисовка — только когда `same`
 * говорит «изменилось», либо когда изменился прочитанный компонентом сигнал (решает
 * shouldComponentUpdate из @preact/signals на прототипе Component).
 */
export function memoize<P extends object>(render: (props: P) => JSX.Element, same: (a: P, b: P) => boolean): ComponentType<P> {
  return class Memo extends Component<P> {
    override shouldComponentUpdate(next: P, state: object): boolean {
      if (!same(this.props as P, next)) return true;
      const base = Component.prototype.shouldComponentUpdate as ((this: Component, p: object, s: object, c: unknown) => boolean) | undefined;
      return base ? base.call(this, this.props, state, undefined) : false;
    }
    override render(props: P): JSX.Element { return render(props); }
  };
}
