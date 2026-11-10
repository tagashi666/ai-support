import { describe, expect, it } from 'vitest';
import { EDGE_PX, lockOf, offsetOf, PANEL_PX, RUBBER_PX, settle } from './swipe';

describe('свайп строки (7.5)', () => {
  it('от левого края — жест системы («Назад»), панель не перехватывает', () => {
    expect(lockOf(EDGE_PX - 1, -80, 0)).toBe('system');
    expect(lockOf(EDGE_PX, -80, 0)).toBe('horizontal');
  });
  it('вертикальный жест — прокрутка, мелкий — ещё не решён', () => {
    expect(lockOf(200, 4, 30)).toBe('vertical');
    expect(lockOf(200, 3, 3)).toBe('none');
  });
  it('влево больше половины панели — открыта; вправо — никогда ничего', () => {
    expect(settle(-PANEL_PX * 0.6, false)).toBe(true);
    expect(settle(-PANEL_PX * 0.3, false)).toBe(false);
    expect(settle(400, false)).toBe(false);
    expect(settle(PANEL_PX * 0.6, true)).toBe(false);
  });
  it('сдвиг вправо — только упор, не дальше 12 px', () => {
    expect(offsetOf(300, false)).toBe(12);
    expect(offsetOf(-PANEL_PX, false)).toBe(-PANEL_PX);
  });
  it('за панелью — резина, не дальше RUBBER_PX (M-9)', () => {
    const far = offsetOf(-1000, false);
    expect(far).toBeLessThan(-PANEL_PX - RUBBER_PX * 0.9);
    expect(far).toBeGreaterThan(-PANEL_PX - RUBBER_PX);
    expect(offsetOf(-PANEL_PX - 40, false)).toBe(-PANEL_PX - 20);
  });
  it('бросок решает по скорости, а не по пути (M-9)', () => {
    expect(settle(-40, false, -0.5)).toBe(true);
    expect(settle(-PANEL_PX * 0.8, false, 0.5)).toBe(false);
    expect(settle(-40, false, -0.1)).toBe(false);
    expect(settle(300, false, -0.5)).toBe(false);
  });
});
