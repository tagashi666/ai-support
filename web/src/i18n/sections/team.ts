/** Словарь раздела (этап 6). Ключи — 'team.*'. Проверки — i18n/ru.test.ts. */
import { makeDict } from '../make';

export const dict = {
  'team.title': 'Команда',
} as const;

export const { t: tr, tn: trn } = makeDict(dict);
