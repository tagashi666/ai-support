/** Словарь (раздел 9): нет лишних ключей, нет жаргона и сырых значений, латиница — только названия. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ru, t, tn } from './ru';

/** Словари редких разделов (этап 6): те же правила, что у ru.ts. */
const sections = import.meta.glob<{ dict: Record<string, string> }>('./sections/*.ts', { eager: true });
const all: Record<string, string> = { ...ru, ...Object.assign({}, ...Object.values(sections).map((module) => module.dict)) };

const SRC = new URL('..', import.meta.url).pathname;
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const sources = walk(SRC)
  .filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith('.test.ts') && !file.endsWith('i18n/ru.ts') && !file.includes('i18n/sections/'))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

const FORBIDDEN = /client|agent|shadow|suggest|lease|p90|host-updater|предложк|тень\b|слепок|нода|инбокс/iu;
const BRANDS = ['Telegram', 'Business', 'Bedolaga', 'MiniShop', 'Remnawave'];

describe('словарь', () => {
  it('каждый ключ где-то используется', () => {
    const unused = Object.keys(all).filter((key) => !sources.includes(`'${key}'`));
    expect(unused).toEqual([]);
  });

  it('нет запрещённых слов и сырых значений перечислений', () => {
    const bad = Object.entries(all).filter(([, value]) => FORBIDDEN.test(value));
    expect(bad).toEqual([]);
  });

  it('латиница только в названиях продуктов', () => {
    const bad = Object.entries(all).filter(([, value]) => {
      let rest: string = value;
      for (const brand of BRANDS) rest = rest.replaceAll(brand, '');
      return /[A-Za-z]/.test(rest.replace(/\{\w+\}/g, ''));
    });
    expect(bad).toEqual([]);
  });

  it('обращение на «вы», без «ты»', () => {
    const bad = Object.entries(all).filter(([, value]) => /(^|[\s«])(ты|тебе|твой|твоя)([\s,.!?»]|$)/iu.test(value));
    expect(bad).toEqual([]);
  });

  it('ключи разделов не пересекаются со словарём и между собой', () => {
    const keys = Object.values(sections).flatMap((module) => Object.keys(module.dict));
    expect(keys.filter((key) => key in ru)).toEqual([]);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('подстановки и склонения', () => {
    expect(t('reason.waitsLead', { for: '2 ч', what: 'передан человеку' })).toBe('Ждёт 2 ч · передан человеку');
    expect([1, 2, 5, 11, 21, 22].map((n) => `${n} ${tn('plural.dialogs', n)}`))
      .toEqual(['1 диалог', '2 диалога', '5 диалогов', '11 диалогов', '21 диалог', '22 диалога']);
    expect(tn('plural.updates', 3)).toBe('обновления');
  });
});
