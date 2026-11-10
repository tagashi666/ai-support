/**
 * Окно отрисовки длинного списка (план, 6.2 и 11.3): если строк больше 100,
 * рисуются только видимые ±2 экрана, остальное — пустые прокладки той же
 * высоты. Строки постоянной высоты (--row-h), поэтому хватает одного замера.
 * Границы окна округляются до 20 строк: при прокрутке список перерисовывается
 * раз в несколько экранов, а не на каждый кадр. Своя реализация без библиотеки.
 */
import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

export const WINDOW_FROM = 100;
export const WINDOW_CHUNK = 20;
/** Шаг строки до замера: --row-h 76 px + промежуток 2 px. */
export const PITCH_GUESS = 78;
const GAP = 2;

export type Range = readonly [number, number];

/** Какие строки группы рисовать: группа начинается на `start` px от верха содержимого. */
export function windowRange(count: number, start: number, scrollTop: number, viewport: number, pitch: number): Range {
  const lo = scrollTop - 2 * viewport;
  const hi = scrollTop + 3 * viewport;
  const from = Math.max(0, Math.floor(Math.floor((lo - start) / pitch) / WINDOW_CHUNK) * WINDOW_CHUNK);
  const to = Math.min(count, Math.ceil(Math.ceil((hi - start) / pitch) / WINDOW_CHUNK) * WINDOW_CHUNK);
  return to <= from ? [Math.min(from, count), Math.min(from, count)] : [from, to];
}

export interface RowWindow {
  on: boolean;
  pitch: number;
  /** Строки группы для показа; ключ — data-rows контейнера. */
  range(key: string, count: number): Range;
}

/** `total` — сколько строк было бы без окна; `layoutKey` — меняется вместе с составом групп. */
export function useRowWindow(scroller: RefObject<HTMLElement>, total: number, layoutKey: string): RowWindow {
  const on = total > WINDOW_FROM;
  const [ranges, setRanges] = useState<Record<string, Range>>({});
  const pitch = useRef(PITCH_GUESS);
  const frame = useRef(0);

  const measure = (): void => {
    frame.current = 0;
    const el = scroller.current;
    if (!el || !on) return;
    const row = el.querySelector<HTMLElement>('[data-row-id]');
    if (row && row.offsetHeight > 0) pitch.current = row.offsetHeight + GAP;
    const top = el.scrollTop;
    const base = el.getBoundingClientRect().top - top;
    const viewport = el.clientHeight || innerHeight;
    const next: Record<string, Range> = {};
    el.querySelectorAll<HTMLElement>('[data-rows]').forEach((group) => {
      next[group.dataset.rows ?? ''] = windowRange(Number(group.dataset.count ?? 0), group.getBoundingClientRect().top - base, top, viewport, pitch.current);
    });
    setRanges((current) => {
      const keys = Object.keys(next);
      const same = keys.length === Object.keys(current).length
        && keys.every((key) => current[key]?.[0] === next[key]![0] && current[key]?.[1] === next[key]![1]);
      return same ? current : next;
    });
  };

  useEffect(() => {
    const el = scroller.current;
    if (!el || !on) return undefined;
    // Не чаще раза в 16 мс: таймер, а не кадр отрисовки — тот стоит в фоновой вкладке и панели.
    const schedule = (): void => { if (!frame.current) frame.current = Number(setTimeout(measure, 16)); };
    el.addEventListener('scroll', schedule, { passive: true });
    addEventListener('resize', schedule);
    return () => {
      el.removeEventListener('scroll', schedule);
      removeEventListener('resize', schedule);
      if (frame.current) clearTimeout(frame.current);
      frame.current = 0;
    };
  }, [on]);
  // Состав групп сменился (кадры, фильтр, свернули секцию) — пересчитать после отрисовки.
  useLayoutEffect(() => { if (on) measure(); }, [on, layoutKey]);

  return {
    on,
    pitch: pitch.current,
    range: (key, count) => {
      if (!on) return [0, count];
      const known = ranges[key];
      if (!known) return [0, Math.min(count, WINDOW_CHUNK * 3)];
      return [Math.min(known[0], count), Math.min(known[1], count)];
    },
  };
}
