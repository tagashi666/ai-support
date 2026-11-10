/**
 * Словари редких разделов (этап 6): «Отчёты», «Система», «Подключения»,
 * «Команда» лежат в i18n/sections/ и попадают в ленивые чанки своих разделов,
 * а не в начальный JS (бюджет 11.4). Правила те же, что у ru.ts: подстановки
 * {name}, склонения формами через «|»; ru.test.ts проверяет все словари.
 */
const pluralRules = new Intl.PluralRules('ru');

export interface Dict<D extends Record<string, string>> {
  t(key: keyof D & string, vars?: Record<string, string | number>): string;
  /** Форма слова для числа: ключ со значением «один|несколько|много». */
  tn(key: keyof D & string, n: number): string;
}

export function makeDict<D extends Record<string, string>>(dict: D): Dict<D> {
  return {
    t(key, vars) {
      const template: string = dict[key] ?? key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
    },
    tn(key, n) {
      const forms = String(dict[key]).split('|');
      const rule = pluralRules.select(n);
      const index = rule === 'one' ? 0 : rule === 'few' ? 1 : rule === 'many' ? 2 : 1;
      return forms[index] ?? forms[forms.length - 1] ?? '';
    },
  };
}
