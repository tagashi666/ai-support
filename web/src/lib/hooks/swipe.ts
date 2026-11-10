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

/** За панелью — резина: сдвиг растёт всё медленнее и не уходит дальше RUBBER_PX (M-9). */
export const RUBBER_PX = 40;
/** Бросок: быстрее этого (px/мс) — решает направление, а не пройденный путь. */
export const FLING = 0.3;

/** Сдвиг строки во время жеста: только влево, за панелью — резина; вправо — с упором (без действия). */
export function offsetOf(dx: number, open: boolean): number {
  const base = open ? -PANEL_PX : 0;
  const next = base + dx;
  if (next > 0) return Math.min(12, next / 4);
  if (next >= -PANEL_PX) return next;
  const over = -PANEL_PX - next;
  return -PANEL_PX - (RUBBER_PX * over) / (over + RUBBER_PX);
}

/** Чем закончится жест: панель открыта или закрыта; v — скорость в конце (px/мс). Вправо никогда ничего не открывает. */
export function settle(dx: number, open: boolean, v = 0): boolean {
  const offset = (open ? -PANEL_PX : 0) + dx;
  if (v <= -FLING && offset < 0) return true;
  if (v >= FLING) return false;
  return offset < -OPEN_AT;
}
