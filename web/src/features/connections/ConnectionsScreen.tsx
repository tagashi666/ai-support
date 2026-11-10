import type { JSX } from 'preact';
import { tr } from '@/i18n/sections/connections';

/** Раздел «Подключения» (этап 6) — отдельный ленивый чанк. */
export function ConnectionsScreen({ sub, item }: { sub?: string; item?: string }): JSX.Element {
  void sub; void item;
  return <h1>{tr('connections.title')}</h1>;
}
