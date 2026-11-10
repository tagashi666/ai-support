import type { JSX } from 'preact';
import { tr } from '@/i18n/sections/team';

/** Раздел «Команда» (этап 6) — отдельный ленивый чанк. */
export function TeamScreen({ sub, item }: { sub?: string; item?: string }): JSX.Element {
  void sub; void item;
  return <h1>{tr('team.title')}</h1>;
}
