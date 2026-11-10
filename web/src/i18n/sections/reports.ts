/** Словарь раздела (этап 6). Ключи — 'reports.*'. Проверки — i18n/ru.test.ts. */
import { makeDict } from '../make';

export const dict = {
  'reports.title': 'Отчёты',
} as const;

export const { t: tr, tn: trn } = makeDict(dict);
