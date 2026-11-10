/** Словарь раздела (этап 6). Ключи — 'connections.*'. Проверки — i18n/ru.test.ts. */
import { makeDict } from '../make';

export const dict = {
  'connections.title': 'Подключения',
} as const;

export const { t: tr, tn: trn } = makeDict(dict);
