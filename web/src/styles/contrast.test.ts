/**
 * Контраст токенов (8.1, 8.7) в обеих темах. Хранятся пары «токен — поверхность»
 * и порог: текст 4,5; крупный текст, значки и границы 3. Новое сочетание — сюда.
 * Прозрачность учитывается (P-3): «токен@0.8» — цвет с непрозрачностью 0,8 поверх
 * фона (opacity, color-mix … transparent); rgba-токены смешиваются так же.
 * «Различимость» — соседние ступени (текст, слои, голоса) не сливаются.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

type Rgb = [number, number, number];
function parse(value: string): { rgb: Rgb; a: number } | null {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (hex) {
    const n = (i: number): number => Number.parseInt(hex[1]!.slice(i, i + 2), 16);
    return { rgb: [n(0), n(2), n(4)], a: hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1 };
  }
  const rgba = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/.exec(value);
  if (rgba) return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], a: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  return null;
}

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)]
    .filter((m) => parse(m[2]!.trim()))
    .map((m) => [m[1]!, m[2]!.trim()]));
}

const light = block(':root {');
const dark = { ...light, ...block(':root[data-theme="dark"]') };

const over = (fg: Rgb, a: number, bg: Rgb): Rgb => [0, 1, 2].map((i) => fg[i]! * a + bg[i]! * (1 - a)) as Rgb;
const lum = ([r, g, b]: Rgb): number => {
  const [x, y, z] = [r, g, b].map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * x! + 0.7152 * y! + 0.0722 * z!;
};
const ratio = (a: Rgb, b: Rgb): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

/** [цвет[@непрозрачность], фон, порог] — имена токенов или '#RRGGBB'. */
const PAIRS: readonly [string, string, number][] = [
  ['text', 'bg', 4.5], ['text', 'surface', 4.5], ['text', 'surface-sunken', 4.5], ['text', 'selected', 4.5],
  ['text', 'bubble-in', 4.5], ['text', 'bubble-colleague', 4.5], ['text', 'surface-raised', 4.5], ['text', 'surface-hover', 4.5],
  ['text-2', 'bg', 4.5], ['text-2', 'surface', 4.5], ['text-2', 'surface-sunken', 4.5], ['text-2', 'surface-hover', 4.5],
  ['text-2', 'surface-raised', 4.5],
  ['text-3', 'bg', 4.5], ['text-3', 'surface', 4.5], ['text-3', 'surface-sunken', 4.5], ['text-3', 'selected', 4.5],
  ['text-3', 'bubble-in', 4.5], ['text-3', 'surface-hover', 4.5], ['text-3', 'surface-raised', 4.5],
  ['on-accent', 'accent', 4.5], ['accent-text', 'surface', 4.5], ['accent-text', 'bg', 4.5], ['accent-text', 'accent-soft', 4.5],
  ['accent-text', 'surface-raised', 4.5],
  ['ai-text', 'ai-bg', 4.5], ['ai-ink', 'ai-bg', 4.5], ['ai-ink', 'surface', 4.5],
  ['note-text', 'note-bg', 4.5],
  ['attention', 'attention-bg', 4.5], ['attention', 'surface', 4.5], ['attention', 'bg', 4.5],
  ['warn', 'warn-bg', 4.5], ['warn', 'surface', 4.5], ['text', 'warn-bg', 4.5],
  ['ok', 'surface', 3], ['ok', 'ok-bg', 4.5], ['text', 'ok-bg', 4.5],
  ['danger', 'surface', 4.5], ['danger', 'danger-bg', 4.5], ['text', 'danger-bg', 4.5], ['on-danger', 'danger-btn', 4.5],
  ['toast-text', 'toast-bg', 4.5],
  ['control-border', 'surface', 3], ['control-border', 'bg', 3], ['focus', 'bg', 3], ['focus', 'surface', 3],
  ['avatar-ink', 'avatar-1', 4.5], ['avatar-ink', 'avatar-2', 4.5], ['avatar-ink', 'avatar-3', 4.5],
  ['avatar-ink', 'avatar-4', 4.5], ['avatar-ink', 'avatar-5', 4.5], ['avatar-ink', 'avatar-6', 4.5],
  ['bg', 'text', 4.5],
  // С прозрачностью: где в стилях текст или значок полупрозрачны.
  ['toast-text@0.8', 'toast-bg', 4.5], // отсчёт в тосте
  ['ai-text@0.86', 'ai-bg', 4.5], // «Почему так?» в черновике
  ['note-text@0.75', 'note-bg', 4.5], // подсказка в поле заметки
  ['text-3@0.7', 'surface', 3], // «⋯» сообщения на телефоне
];

/** Различимость соседних ступеней: [a, b, минимум]. */
const DISTINCT: readonly [string, string, number][] = [
  ['text', 'text-2', 1.3], ['text-2', 'text-3', 1.3], // P-1
  ['surface', 'surface-sunken', 1.08], ['surface', 'surface-hover', 1.08], // P-2
  ['bubble-colleague', 'ai-bg', 1.1], // P-18
];

describe.each([['светлая', light], ['тёмная', dark]] as const)('контраст: %s тема', (_name, theme) => {
  const solid = (token: string): Rgb => {
    const value = token.startsWith('#') ? token : theme[token];
    expect(value, `нет токена ${token}`).toBeTruthy();
    const color = parse(value!)!;
    expect(color.a, `${token} прозрачный — нужен фон`).toBe(1);
    return color.rgb;
  };
  const ink = (spec: string, bg: Rgb): Rgb => {
    const [token, alpha] = spec.split('@');
    const color = parse(token!.startsWith('#') ? token! : theme[token!] ?? '');
    expect(color, `нет токена ${token}`).toBeTruthy();
    return over(color!.rgb, color!.a * (alpha ? Number(alpha) : 1), bg);
  };
  it.each(PAIRS)('%s на %s ≥ %s', (fg, bg, min) => {
    const back = solid(bg);
    expect(ratio(ink(fg, back), back)).toBeGreaterThanOrEqual(min);
  });
  it.each(DISTINCT)('%s и %s различимы (≥ %s)', (a, b, min) => {
    expect(ratio(solid(a), solid(b))).toBeGreaterThanOrEqual(min);
  });
});
