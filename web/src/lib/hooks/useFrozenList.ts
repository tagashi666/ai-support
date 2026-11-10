/**
 * Заморозка списка (план, 7.1 правила 2–4) — один хук для прототипа и
 * живого списка. Порядок и состав видимой части не меняются, пока курсор над
 * списком, фокус внутри, идёт касание или прокрутка (и ещё 1 с после неё),
 * открыто меню строки или список прокручен вниз больше чем на 8 px.
 * Накопленное применяется само через 1,5 с спокойствия при видимой вкладке;
 * строки переезжают 200 мс (FLIP, только transform), при «меньше движения» —
 * подсветка на 1 с.
 */
import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { reducedMotion } from '@/lib/media';
import { DUR, EASE } from '@/ui/motion';

export const CALM_MS = 1500;
export const SCROLL_SETTLE_MS = 1000;
export const SCROLLED_PX = 8;

export interface FreezeFlags { hover: boolean; focus: boolean; touch: boolean; hold: boolean; scrollAt: number; scrollTop: number }

/** Чистое правило заморозки — тест в useFrozenList.test.ts. */
export function isFrozen(flags: FreezeFlags, now: number): boolean {
  return flags.hover || flags.focus || flags.touch || flags.hold
    || now - flags.scrollAt < SCROLL_SETTLE_MS || flags.scrollTop > SCROLLED_PX;
}

interface Options {
  /** Ключ накопленных изменений: пустой — применять нечего. */
  pendingKey: string;
  /** Применить накопленное (серверный порядок) к показу. */
  apply: () => void;
  /** Зависимость, после смены которой играет FLIP (показанный порядок). */
  shown: unknown;
  /** Сообщить наружу (прототип держит заморозку в общем сигнале). */
  onFrozen?: (frozen: boolean) => void;
}

export interface FrozenList {
  scroller: RefObject<HTMLDivElement>;
  frozen: boolean;
  /** Обработчики для прокручиваемого контейнера строк. */
  handlers: {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onFocusIn: () => void;
    onFocusOut: (event: FocusEvent) => void;
    onTouchStart: () => void;
    onTouchEnd: () => void;
    onScroll: () => void;
  };
  /** Применить сейчас с переездом строк (пилюля, свои действия); change — своя перемена вместо накопленного. */
  applyNow: (change?: () => void) => void;
  /** Открыто меню строки или режим выбора — держать заморозку. */
  hold: (value: boolean) => void;
  /** ↑ ↓ Home End по строкам: только фокус, «прочитано» не уходит. */
  onRowKey: (event: KeyboardEvent) => string | null;
}

export function useFrozenList({ pendingKey, apply, shown, onFrozen }: Options): FrozenList {
  const scroller = useRef<HTMLDivElement>(null);
  const flags = useRef<FreezeFlags>({ hover: false, focus: false, touch: false, hold: false, scrollAt: 0, scrollTop: 0 });
  const flipFrom = useRef<Map<string, number> | null>(null);
  const [frozen, setFrozen] = useState(false);

  const recompute = (): void => {
    flags.current.scrollTop = scroller.current?.scrollTop ?? 0;
    const value = isFrozen(flags.current, Date.now());
    setFrozen(value);
    onFrozen?.(value);
  };
  const settleLater = (): void => { setTimeout(recompute, SCROLL_SETTLE_MS + 50); };

  const applyNow = (change: () => void = apply): void => {
    const before = new Map<string, number>();
    scroller.current?.querySelectorAll<HTMLElement>('[data-row-id]').forEach((row) => {
      before.set(row.dataset.rowId ?? '', row.getBoundingClientRect().top);
    });
    // Замер не затирает ещё не сыгранный (две перемены в одном кадре — переезд от первого положения).
    flipFrom.current = flipFrom.current ? new Map([...before, ...flipFrom.current]) : before;
    change();
  };

  useEffect(() => () => onFrozen?.(false), []);

  useEffect(() => {
    if (!pendingKey || frozen) return undefined;
    const timer = setTimeout(() => {
      recompute();
      if (!isFrozen(flags.current, Date.now()) && document.visibilityState === 'visible') applyNow();
    }, CALM_MS);
    return () => clearTimeout(timer);
  }, [pendingKey, frozen]);

  useLayoutEffect(() => {
    const before = flipFrom.current;
    if (!before) return;
    flipFrom.current = null;
    scroller.current?.querySelectorAll<HTMLElement>('[data-row-id]').forEach((row) => {
      const was = before.get(row.dataset.rowId ?? '');
      const top = row.getBoundingClientRect().top;
      if (reducedMotion.value) {
        if (was === undefined || Math.abs(was - top) > 1) {
          row.dataset.flash = 'true';
          setTimeout(() => { delete row.dataset.flash; }, 1000);
        }
        return;
      }
      if (was === undefined) row.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: DUR.fast, easing: EASE.out });
      else if (Math.abs(was - top) > 1) row.animate([{ transform: `translateY(${was - top}px)` }, { transform: 'none' }], { duration: DUR.move, easing: EASE.move });
    });
  }, [shown]);

  const onRowKey = (event: KeyboardEvent): string | null => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return null;
    event.preventDefault();
    const rows = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-row-id]') ?? [])];
    const index = rows.findIndex((row) => row === document.activeElement || row.contains(document.activeElement));
    const next = event.key === 'Home' ? rows[0] : event.key === 'End' ? rows[rows.length - 1]
      : rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return null;
    (next.matches('button, a') ? next : next.querySelector<HTMLElement>('button, a'))?.focus();
    return next.dataset.rowId ?? null;
  };

  return {
    scroller,
    frozen,
    applyNow,
    onRowKey,
    hold: (value) => { flags.current.hold = value; recompute(); },
    handlers: {
      onMouseEnter: () => { flags.current.hover = true; recompute(); },
      onMouseLeave: () => { flags.current.hover = false; recompute(); },
      onFocusIn: () => { flags.current.focus = true; recompute(); },
      onFocusOut: (event) => {
        if (!scroller.current?.contains(event.relatedTarget as Node | null)) { flags.current.focus = false; recompute(); }
      },
      onTouchStart: () => { flags.current.touch = true; recompute(); },
      onTouchEnd: () => { flags.current.touch = false; flags.current.scrollAt = Date.now(); recompute(); settleLater(); },
      onScroll: () => { flags.current.scrollAt = Date.now(); recompute(); settleLater(); },
    },
  };
}
