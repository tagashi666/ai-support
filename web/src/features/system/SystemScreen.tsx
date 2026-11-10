import type { JSX } from 'preact';
import { tr } from '@/i18n/sections/system';

/** Раздел «Система» (этап 6) — отдельный ленивый чанк. */
export function SystemScreen({ sub, item }: { sub?: string; item?: string }): JSX.Element {
  void sub; void item;
  return <h1>{tr('system.title')}</h1>;
}
