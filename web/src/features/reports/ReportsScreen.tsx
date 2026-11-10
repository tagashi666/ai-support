import type { JSX } from 'preact';
import { tr } from '@/i18n/sections/reports';

/** Раздел «Отчёты» (этап 6) — отдельный ленивый чанк. */
export function ReportsScreen({ sub, item }: { sub?: string; item?: string }): JSX.Element {
  void sub; void item;
  return <h1>{tr('reports.title')}</h1>;
}
