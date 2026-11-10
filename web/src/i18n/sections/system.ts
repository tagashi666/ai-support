/** Словарь раздела (этап 6). Ключи — 'system.*'. Проверки — i18n/ru.test.ts. */
import { makeDict } from '../make';

export const dict = {
  'system.title': 'Система',
} as const;

export const { t: tr, tn: trn } = makeDict(dict);
