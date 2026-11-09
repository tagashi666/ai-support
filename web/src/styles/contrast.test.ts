/**
 * Контраст токенов (8.1, 8.7) в обеих темах. Хранятся пары «токен — поверхность»
 * и порог: текст 4,5; крупный текст, значки и границы 3. Новое сочетание — сюда.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1]!, m[2]!]));
}

const light = block(':root {');
const dark = { ...light, ...block(':root[data-theme="dark"]') };
const WHITE = '#FFFFFF';

const lum = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

/** [цвет, фон, порог] — имена токенов или '#FFFFFF'. */
const PAIRS: readonly [string, string, number][] = [
  ['text', 'bg', 4.5], ['text', 'surface', 4.5], ['text', 'surface-sunken', 4.5], ['text', 'selected', 4.5],
  ['text', 'bubble-in', 4.5], ['text', 'bubble-colleague', 4.5],
  ['text-2', 'bg', 4.5], ['text-2', 'surface', 4.5], ['text-2', 'surface-sunken', 4.5],
  ['text-3', 'bg', 4.5], ['text-3', 'surface', 4.5], ['text-3', 'surface-sunken', 4.5], ['text-3', 'selected', 4.5],
  ['text-3', 'bubble-in', 4.5], ['text-3', 'surface-hover', 4.5],
  ['on-accent', 'accent', 4.5], ['accent-text', 'surface', 4.5], ['accent-text', 'bg', 4.5], ['accent-text', 'accent-soft', 4.5],
  ['ai-text', 'ai-bg', 4.5], ['ai-ink', 'ai-bg', 4.5], ['ai-ink', 'surface', 4.5],
  ['note-text', 'note-bg', 4.5],
  ['attention', 'attention-bg', 4.5], ['attention', 'surface', 4.5], ['attention', 'bg', 4.5],
  ['ok', 'surface', 3], ['danger', 'surface', 4.5], ['on-danger', 'danger-btn', 4.5],
  ['control-border', 'surface', 3], ['control-border', 'bg', 3], ['focus', 'bg', 3], ['focus', 'surface', 3],
  ['avatar-ink', 'avatar-1', 4.5], ['avatar-ink', 'avatar-2', 4.5], ['avatar-ink', 'avatar-3', 4.5],
  ['avatar-ink', 'avatar-4', 4.5], ['avatar-ink', 'avatar-5', 4.5], ['avatar-ink', 'avatar-6', 4.5],
  ['bg', 'text', 4.5],
];

describe.each([['светлая', light], ['тёмная', dark]] as const)('контраст: %s тема', (_name, theme) => {
  const color = (token: string): string => (token.startsWith('#') ? token : theme[token] ?? WHITE);
  it.each(PAIRS)('%s на %s ≥ %s', (fg, bg, min) => {
    expect(theme[fg] ?? fg, `нет токена ${fg}`).toBeTruthy();
    expect(ratio(color(fg), color(bg))).toBeGreaterThanOrEqual(min);
  });
});
