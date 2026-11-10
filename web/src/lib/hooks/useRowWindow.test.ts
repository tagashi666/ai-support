/** Окно отрисовки (6.2): видимые ±2 экрана, границы кратны 20 строкам. */
import { describe, expect, it } from 'vitest';
import { WINDOW_CHUNK, windowRange } from './useRowWindow';

describe('окно отрисовки', () => {
  it('в начале списка — от нуля до трёх экранов вниз', () => {
    const [from, to] = windowRange(500, 100, 0, 800, 78);
    expect(from).toBe(0);
    expect(to * 78).toBeGreaterThanOrEqual(3 * 800 - 100);
    expect(to % WINDOW_CHUNK).toBe(0);
  });
  it('в середине — два экрана над видимым и два под ним', () => {
    const [from, to] = windowRange(500, 0, 78 * 250, 780, 78);
    expect(from).toBeLessThanOrEqual(250 - 20);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThanOrEqual(250 + 30);
    expect(to).toBeLessThanOrEqual(500);
  });
  it('мелкая прокрутка не сдвигает границы', () => {
    expect(windowRange(500, 0, 78 * 245, 780, 78)).toEqual(windowRange(500, 0, 78 * 245 + 30, 780, 78));
  });
  it('группа далеко за окном — пусто', () => {
    const [from, to] = windowRange(50, 100_000, 0, 800, 78);
    expect(to - from).toBe(0);
  });
  it('конец не дальше числа строк', () => {
    expect(windowRange(130, 0, 78 * 129, 800, 78)[1]).toBe(130);
  });
});
