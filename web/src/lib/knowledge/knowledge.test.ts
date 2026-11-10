/** «Знания» (6.6): разбор статьи, «было → стало», строки списка, идеи, черновик на устройстве, подсказки по кабинету. */
import { describe, expect, it } from 'vitest';
import {
  articleRows, composeDoc, diffStats, dropLocalDraft, filterArticles, ideaSourceLabel, lineDiff, nextIdeaId, normalizeDoc,
  readLocalDraft, saveLocalDraft, splitDoc, validShortcut,
} from './model';
import { checkForm, formOf, hintRows, withEdit, withHidden, withOwn, withReset, withoutOwn, type HintsState } from './hints';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); },
    clear: () => data.clear(), key: () => null, get length() { return data.size; },
  };
}

const doc = (name: string, title: string, updatedAt = 1) => ({ name, title, size: 10, updatedAt, excerpt: `${title} текст` });

describe('статья: название и текст', () => {
  it('первая строка «# …» — название, остальное — текст', () => {
    expect(splitDoc('# Подключение iOS\n\nШаг 1.\nШаг 2.\n')).toEqual({ title: 'Подключение iOS', body: 'Шаг 1.\nШаг 2.\n' });
    expect(splitDoc('Без заголовка')).toEqual({ title: '', body: 'Без заголовка' });
  });
  it('сборка и разбор — без лишних правок', () => {
    const text = '# Т\n\nТекст\n';
    expect(composeDoc(splitDoc(text))).toBe(text);
    expect(normalizeDoc('# Т\nТекст')).toBe('# Т\n\nТекст\n');
    expect(composeDoc({ title: '  Два   слова ', body: '\n\nтело' })).toBe('# Два слова\n\nтело\n');
  });
});

describe('было → стало', () => {
  it('добавленные и удалённые строки', () => {
    const ops = lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(diffStats(ops)).toEqual({ added: 2, removed: 1 });
    expect(ops.filter((op) => op.kind === 'same').map((op) => op.line)).toEqual(['a', 'c']);
  });
  it('одинаковые тексты — ноль изменений', () => {
    expect(diffStats(lineDiff('x\ny\n', 'x\ny\n'))).toEqual({ added: 0, removed: 0 });
  });
  it('новая статья — всё добавлено', () => {
    expect(diffStats(lineDiff('', '# Т\n\nстрока\n'))).toEqual({ added: 3, removed: 0 });
  });
});

describe('список статей', () => {
  const kb = [doc('ios.md', 'Подключение iOS', 5), doc('pay.md', 'Оплата', 3)];
  const drafts = [doc('ios.md', 'Подключение iPhone', 9), doc('new.md', 'Возврат платежа', 7)];
  const rows = articleRows(kb, drafts, new Set(['new.md']));
  it('опубликована / есть правки / черновик; свежие сверху', () => {
    expect(rows.map((row) => [row.name, row.state])).toEqual([['ios.md', 'edited'], ['new.md', 'draft'], ['pay.md', 'published']]);
    expect(rows[0]!.title).toBe('Подключение iPhone');
  });
  it('черновик-идея помечен', () => {
    expect(rows.find((row) => row.name === 'new.md')!.idea).toBe(true);
    expect(rows.find((row) => row.name === 'pay.md')!.idea).toBe(false);
  });
  it('фильтр и поиск (ё = е)', () => {
    expect(filterArticles(rows, 'draft', '').map((row) => row.name)).toEqual(['new.md']);
    expect(filterArticles(rows, 'all', 'ВОЗВРАТ').map((row) => row.name)).toEqual(['new.md']);
    expect(filterArticles(rows, 'edited', 'оплата')).toEqual([]);
  });
});

describe('идеи', () => {
  it('после решения — следующая, у последней — предыдущая, у единственной — ничего', () => {
    expect(nextIdeaId([1, 2, 3], 2)).toBe(3);
    expect(nextIdeaId([1, 2, 3], 3)).toBe(2);
    expect(nextIdeaId([5], 5)).toBeNull();
  });
  it('источник словами', () => {
    expect(ideaSourceLabel('auto-learn')).toBe('kb.source.learn');
    expect(ideaSourceLabel('feedback')).toBe('kb.source.feedback');
    expect(ideaSourceLabel('что-то')).toBe('kb.source.other');
  });
});

describe('черновик на устройстве', () => {
  it('сохраняется, читается и стареет за 14 дней', () => {
    const storage = memoryStorage();
    saveLocalDraft('ios.md', { title: 'Т', body: 'б', base: 'abc', at: 1000 }, storage);
    expect(readLocalDraft('ios.md', 2000, storage)?.base).toBe('abc');
    expect(readLocalDraft('ios.md', 1000 + 15 * 24 * 60 * 60_000, storage)).toBeNull();
    dropLocalDraft('ios.md', storage);
    expect(readLocalDraft('ios.md', 2000, storage)).toBeNull();
  });
  it('битая запись не роняет редактор', () => {
    const storage = memoryStorage();
    storage.setItem('next.kb.x', '{');
    expect(readLocalDraft('x', 0, storage)).toBeNull();
  });
});

describe('шаблоны', () => {
  it('короткое имя как у сервера', () => {
    expect(validShortcut('ios')).toBe(true);
    expect(validShortcut('  ')).toBe(false);
    expect(validShortcut('a'.repeat(41))).toBe(false);
    expect(validShortcut('a\u0007')).toBe(false);
  });
});

describe('подсказки по кабинету', () => {
  const screen = { id: 'menu', title: 'Главное меню', routeDescription: 'Внизу', keywords: ['меню'], instructions: ['Нажмите «Меню»'] };
  const state: HintsState = {
    enabled: true, setting: 'auto', effectiveMode: 'lite', detected: { mode: 'lite', at: 1 }, modes: ['full', 'lite'],
    shipped: { screens: [screen, { ...screen, id: 'ref', title: 'Рефералы', only: 'full' }] },
    overrides: { screens: {}, added: [] },
    resolved: { full: [screen], lite: [screen] },
  };
  it('экран «только для полного» в упрощённом не виден', () => {
    expect(hintRows(state, 'lite').map((row) => row.id)).toEqual(['menu']);
  });
  it('правка пишет только отличия; без отличий — заплатки нет', () => {
    const form = { ...formOf(screen), title: 'Меню' };
    const next = withEdit(state.overrides, 'menu', 'all', form, screen);
    expect(next.screens.menu).toEqual({ all: { title: 'Меню' } });
    expect(withEdit(state.overrides, 'menu', 'lite', formOf(screen), screen).screens.menu).toBeUndefined();
    expect(state.overrides.screens.menu).toBeUndefined();
  });
  it('скрыть, вернуть, сбросить', () => {
    const hidden = withHidden(state.overrides, 'menu', true);
    expect(hidden.screens.menu).toEqual({ hidden: true });
    expect(withHidden(hidden, 'menu', false).screens.menu).toBeUndefined();
    const edited = withEdit(hidden, 'menu', 'all', { ...formOf(screen), title: 'Меню' }, screen);
    expect(withReset(edited, 'menu').screens.menu).toEqual({ hidden: true });
  });
  it('свой экран: добавить, заменить, удалить', () => {
    const form = { ...formOf(screen), title: 'Свой' };
    const added = withOwn(state.overrides, null, form, 'lite', 36 ** 3);
    expect(added.added).toEqual([{ id: 'own-1000', title: 'Свой', routeDescription: 'Внизу', keywords: ['меню'], instructions: ['Нажмите «Меню»'], only: 'lite' }]);
    expect(withOwn(added, 'own-1000', { ...form, title: 'Свой 2' }, null).added.map((item) => item.title)).toEqual(['Свой 2']);
    expect(withoutOwn(added, 'own-1000').added).toEqual([]);
  });
  it('проверка формы', () => {
    expect(checkForm({ ...formOf(screen), routeDescription: '' })).toBe('needTitle');
    expect(checkForm({ ...formOf(screen), instructions: '' })).toBe('needSteps');
    expect(checkForm(formOf(screen))).toBeNull();
  });
});
