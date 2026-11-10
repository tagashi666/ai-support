import type { ComponentType, JSX } from 'preact';
import { signal } from '@preact/signals';

/**
 * Раздел, который грузится по требованию (бюджет начального JS, 11.4): до
 * загрузки — та же заглушка, что у экранов при загрузке данных.
 */
export function lazyScreen<P extends object>(load: () => Promise<ComponentType<P>>, fallback: () => JSX.Element): (props: P) => JSX.Element {
  const loaded = signal<ComponentType<P> | null>(null);
  let started = false;
  return (props: P) => {
    if (!started) {
      started = true;
      void load().then((component) => { loaded.value = component; }).catch(() => { started = false; });
    }
    const Screen = loaded.value;
    return Screen ? <Screen {...props} /> : fallback();
  };
}
