import { describe, expect, it } from 'vitest';
import { duration, listTime, roughDuration } from './format';

const MIN = 60_000;
const now = new Date(2026, 10, 9, 18, 30).getTime();

describe('форматирование', () => {
  it('длительности словами', () => {
    expect(duration(20_000)).toBe('меньше минуты');
    expect(duration(5 * MIN)).toBe('5 мин');
    expect(duration(120 * MIN)).toBe('2 ч');
    expect(duration(160 * MIN)).toBe('2 ч 40 мин');
    expect(duration(3 * 24 * 60 * MIN)).toBe('3 дня');
    expect(roughDuration(133 * MIN)).toBe('2 ч');
    expect(roughDuration(73 * MIN)).toBe('1 ч');
  });

  it('время в строке списка', () => {
    expect(listTime(new Date(2026, 10, 9, 16, 21).getTime(), now)).toBe('16:21');
    expect(listTime(new Date(2026, 10, 8, 23, 0).getTime(), now)).toBe('вчера');
    expect(listTime(new Date(2025, 10, 5, 12, 0).getTime(), now)).toMatch(/2025/);
  });
});
