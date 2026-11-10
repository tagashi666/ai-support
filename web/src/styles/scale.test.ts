/**
 * Шкала (audit/ui-polish/palette.md): цвета, размеры шрифта, начертания, радиусы,
 * отступы и тени — только токенами из tokens.css. Тест проходит по всем стилям
 * web/src, а не по выборке: новое значение мимо шкалы — сначала в токены.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url).pathname;
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const all = walk(root);
const styles = all.filter((file) => file.endsWith('.css') && !file.endsWith('tokens.css'));
const tokens = readFileSync(join(root, 'styles/tokens.css'), 'utf8');

/** Объявления «свойство: значение» с файлом и строкой; комментарии вырезаны. */
function declarations(file: string): { where: string; prop: string; value: string }[] {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const out: { where: string; prop: string; value: string }[] = [];
  text.split('\n').forEach((line, index) => {
    for (const m of line.matchAll(/(?:^|[{;\s])([a-z-]+)\s*:\s*([^;{}]+)/g)) {
      if (m[1]!.startsWith('-') && !m[1]!.startsWith('--')) continue;
      out.push({ where: `${relative(root, file)}:${index + 1}`, prop: m[1]!, value: m[2]!.trim() });
    }
  });
  return out;
}
const decls = styles.flatMap(declarations).filter((d) => !d.prop.startsWith('--'));
/** Части значения через пробел вне скобок: «0 calc(-1 * var(--s2))» → ['0', 'calc(…)']. */
function parts(value: string, sep = ' '): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth === 0 && (sep === ' ' ? /\s/.test(ch) : ch === sep)) { if (current.trim()) out.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
const bad = (pred: (d: { prop: string; value: string }) => boolean): string[] =>
  decls.filter(pred).map((d) => `${d.where} ${d.prop}: ${d.value}`);

/** Значение из токенов, ключевых слов и нулей; px до 2 — волосяные линии и оптические сдвиги. */
const OK_LENGTH = /^(0|1px|2px|-1px|-2px|\d+dvh|auto|inherit|none|100%|50%|var\(--[\w-]+(?:,[^)]*)?\)|calc\(.*\)|max\(.*\)|min\(.*\)|env\(.*\)|-?var\(--[\w-]+\))$/;

describe('шкала: стили только токенами', () => {
  it('цвета — только в tokens.css', () => {
    expect(bad((d) => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(d.value))).toEqual([]);
  });

  it('размер шрифта — ступень --fs-*', () => {
    expect(bad((d) => d.prop === 'font-size' && !/^(var\(--fs-[\w-]+\)|inherit)$/.test(d.value))).toEqual([]);
  });

  it('начертания — 400, 500, 600', () => {
    expect(bad((d) => d.prop === 'font-weight' && !/^(400|500|600|inherit|normal)$/.test(d.value))).toEqual([]);
  });

  it('радиусы — --r-*, круг, 0 или 2px у мелких меток', () => {
    expect(bad((d) => d.prop.startsWith('border') && d.prop.includes('radius')
      && !parts(d.value).every((part) => /^(0|2px|50%|inherit|var\(--r-[\w-]+\))$/.test(part)))).toEqual([]);
  });

  it('отступы — --s*, --pad-* или волосяные 1–2px', () => {
    const props = /^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$/;
    expect(bad((d) => props.test(d.prop) && !parts(d.value).every((part) => OK_LENGTH.test(part)))).toEqual([]);
  });

  it('тени — --shadow-*, --pop-ring или кольцо цветом токена', () => {
    const ok = (part: string): boolean => /^(none|var\(--(shadow|pop)[\w-]*\)|(inset\s+)?(-?[\d.]+(px)?\s+){2,4}var\(--[\w-]+\))$/.test(part);
    expect(bad((d) => d.prop === 'box-shadow' && !parts(d.value, ',').every(ok))).toEqual([]);
  });

  it('нет ступени --s5 и необъявленных токенов', () => {
    const declared = new Set([...[tokens, ...styles.map((f) => readFileSync(f, 'utf8'))].join('\n').matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const missing = decls.flatMap((d) => [...d.value.matchAll(/var\((--[\w-]+)(\s*,)?/g)]
      .filter((m) => !m[2] && !declared.has(m[1]!)).map((m) => `${d.where} ${m[1]}`));
    expect(missing).toEqual([]);
  });

  it('длительности и кривые — токены движения', () => {
    expect(bad((d) => /^(transition|animation)(-duration|-timing-function)?$/.test(d.prop)
      && /\b\d+m?s\b|\bease\b|ease-in|cubic-bezier/.test(d.value.replace(/var\([^)]*\)/g, ''))
      && !/infinite|flash/.test(d.value))).toEqual([]);
  });
});

describe('тёмная тема', () => {
  it('блоки data-theme="dark" и prefers-color-scheme одинаковы', () => {
    const body = (from: number): string => tokens.slice(tokens.indexOf('{', from) + 1, tokens.indexOf('}', from));
    const norm = (text: string): string => text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    const explicit = body(tokens.indexOf(':root[data-theme="dark"]'));
    const system = body(tokens.indexOf(':root:not([data-theme="light"])'));
    expect(norm(system)).toBe(norm(explicit));
  });
});
