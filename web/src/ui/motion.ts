/**
 * Движение для JS (audit/ui-polish/motion.md). Числа — те же, что токены
 * --dur-* / --ease-* в tokens.css (сверяет motion.test.ts). CSS-анимации
 * берут токены напрямую; здесь — то, что двигается из кода: выход по таймеру,
 * FLIP соседей, свайп.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { reducedMotion } from '@/lib/media';

export const DUR = { press: 80, fast: 140, move: 200, sheet: 240, exit: 120 } as const;
export const EASE = {
  out: 'cubic-bezier(.2, .8, .2, 1)',
  exit: 'cubic-bezier(.4, 0, 1, 1)',
  move: 'cubic-bezier(.3, 0, .2, 1)',
} as const;

/** Длительность с учётом «уменьшить движение»: перемещение и нажатие — 0, смена прозрачности — 120 мс. */
export function dur(kind: keyof typeof DUR): number {
  if (!reducedMotion.peek()) return DUR[kind];
  return kind === 'move' || kind === 'press' ? 0 : 120;
}

/**
 * Присутствие с выходом: после open=false элемент ещё `ms` отрисован с closing=true —
 * CSS играет выход по data-state="closing", потом снимаем. Повторное открытие во
 * время выхода возвращает элемент сразу, без мигания.
 */
export function usePresence(open: boolean, ms: number = dur('exit')): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return undefined; }
    const timer = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(timer);
  }, [open, ms]);
  return { mounted: open || mounted, closing: !open && mounted };
}

/**
 * Список с выходом: ушедший элемент ещё `ms` остаётся на прежнем месте с leaving=true
 * (data-state="closing" в разметке), потом снимается. Вернувшийся — сразу обычный.
 */
export function useExitList<T>(items: readonly T[], key: (item: T) => string | number, ms: number = dur('exit')): { item: T; leaving: boolean }[] {
  const [, rerender] = useState(0);
  const gone = useRef(new Map<string | number, { item: T; index: number }>());
  const prev = useRef(items);
  const keys = new Set(items.map(key));
  if (prev.current !== items) {
    prev.current.forEach((item, index) => {
      const k = key(item);
      if (keys.has(k) || gone.current.has(k)) return;
      gone.current.set(k, { item, index });
      setTimeout(() => { if (gone.current.delete(k)) rerender((n) => n + 1); }, ms);
    });
    prev.current = items;
  }
  for (const k of keys) gone.current.delete(k);
  const out = items.map((item) => ({ item, leaving: false }));
  for (const { item, index } of gone.current.values()) out.splice(Math.min(index, out.length), 0, { item, leaving: true });
  return out;
}

/** FLIP, шаг 1: положения детей до перемены. */
export function measure(parent: Element | null): Map<Element, number> {
  const out = new Map<Element, number>();
  if (parent) for (const el of parent.children) out.set(el, el.getBoundingClientRect().top);
  return out;
}

/** FLIP, шаг 2: после перемены сдвинуть детей из старого положения в новое (только transform). */
export function flip(parent: Element | null, before: Map<Element, number>, ms: number = dur('move')): void {
  if (!parent || !ms) return;
  for (const el of parent.children) {
    const top = before.get(el);
    if (top === undefined) continue;
    const dy = top - el.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: ms, easing: EASE.move });
  }
}

/** Прокрутка из кода: плавно, если человек не просил уменьшить движение (M-6). */
export const smooth = (): ScrollBehavior => (reducedMotion.peek() ? 'auto' : 'smooth');

/**
 * Скользящий индикатор (R2 C): `ind` стоит под выбранным пунктом `host`
 * (selector — [aria-selected="true"] или [aria-checked="true"] и т. п.). При смене
 * выбора — FLIP: ширина и место ставятся сразу, движение играет transform
 * (translate + scaleX от старой ширины к новой), без анимации layout-свойств.
 * Первое положение и изменения размеров (ResizeObserver) — без анимации.
 */
export function useSlide(host: { current: HTMLElement | null }, ind: { current: HTMLElement | null }, selector: string, key: unknown): void {
  const last = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const place = (animate: boolean): void => {
    const box = host.current;
    const el = ind.current;
    const target = box?.querySelector<HTMLElement>(selector);
    if (!box || !el) return;
    if (!target) { el.dataset.ready = 'false'; last.current = null; return; }
    const next = { x: target.offsetLeft, y: target.offsetTop, w: target.offsetWidth, h: target.offsetHeight };
    const prev = last.current;
    last.current = next;
    el.style.width = `${next.w}px`;
    el.style.height = `${next.h}px`;
    el.style.transform = `translate(${next.x}px, ${next.y}px)`;
    el.dataset.ready = 'true';
    const ms = dur('move');
    if (!animate || !prev || !ms || (prev.x === next.x && prev.y === next.y && prev.w === next.w) || !el.animate) return;
    el.animate([
      { transform: `translate(${prev.x}px, ${prev.y}px) scale(${prev.w / next.w}, ${prev.h / next.h})` },
      { transform: `translate(${next.x}px, ${next.y}px)` },
    ], { duration: ms, easing: EASE.move });
  };
  // Контейнер может появиться позже (условная отрисовка) — следим за ним на каждой отрисовке.
  const seen = useRef<HTMLElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    const box = host.current;
    if (box === seen.current) return;
    observer.current?.disconnect();
    seen.current = box;
    last.current = null;
    if (box && typeof ResizeObserver !== 'undefined') {
      observer.current = new ResizeObserver(() => place(false));
      observer.current.observe(box);
      for (const child of box.children) observer.current.observe(child);
    }
    place(false);
  });
  useLayoutEffect(() => { place(true); }, [key]);
  useEffect(() => () => observer.current?.disconnect(), []);
}

