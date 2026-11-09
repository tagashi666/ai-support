/**
 * Жесты строки списка (7.5): свайп влево открывает кнопки «Решено · Важно ·
 * Убрать · ⋯» и сам ничего не делает; свайп вправо — ничего (в Safari отсюда
 * начинается системное «Назад»). Жест, начатый ближе 24 px от левого края,
 * панель отдаёт системе. Чистые правила — тест swipe.test.ts.
 */
export const EDGE_PX = 24;
/** Ширина панели кнопок; открыта, если оттянули больше половины. */
export const PANEL_PX = 216;
export const OPEN_AT = PANEL_PX / 2;
/** Сдвиг, после которого понятно направление жеста. */
export const LOCK_PX = 10;

export type SwipeLock = 'none' | 'horizontal' | 'vertical' | 'system';

/** Чей это жест: системы (от края), прокрутки (вертикальный) или наш (горизонтальный). */
export function lockOf(startX: number, dx: number, dy: number): SwipeLock {
  if (startX < EDGE_PX) return 'system';
  if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return 'none';
  return Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
}

/** Сдвиг строки во время жеста: только влево, не дальше панели; вправо — с упором (без действия). */
export function offsetOf(dx: number, open: boolean): number {
  const base = open ? -PANEL_PX : 0;
  const next = base + dx;
  if (next > 0) return Math.min(12, next / 4);
  return Math.max(-PANEL_PX - 24, next);
}

/** Чем закончится жест: панель открыта или закрыта. Вправо никогда ничего не делает. */
export function settle(dx: number, open: boolean): boolean {
  const offset = (open ? -PANEL_PX : 0) + dx;
  return offset < -OPEN_AT;
}
