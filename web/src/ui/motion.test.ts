/** Числа движения в JS совпадают с токенами tokens.css (M-13). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DUR, EASE } from './motion';

const css = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
const token = (name: string): string | undefined => new RegExp(`--${name}:\\s*([^;]+);`).exec(root)?.[1]?.trim();

describe('движение: JS = токены', () => {
  it.each(Object.entries(DUR))('--dur-%s = %s мс', (name, ms) => {
    expect(token(`dur-${name}`)).toBe(`${ms}ms`);
  });
  it.each(Object.entries(EASE))('--ease-%s', (name, curve) => {
    expect(token(`ease-${name}`)?.replace(/\s/g, '')).toBe(curve.replace(/\s/g, ''));
  });
});
