/** Ширина экрана как сигнал: раскладки 6.0 переключаются без перезагрузки. */
import { signal } from '@preact/signals';

function watch(query: string) {
  // Без окна (тесты логики в node) — «не совпадает».
  if (typeof matchMedia !== 'function') return signal(false);
  const list = matchMedia(query);
  const value = signal(list.matches);
  list.addEventListener('change', () => { value.value = list.matches; });
  return value;
}

/** ≥1024: рейка слева и колонки. */
export const isDesktop = watch('(min-width: 1024px)');
/** ≥768: список и диалог рядом. */
export const isSplit = watch('(min-width: 768px)');
/** ≥1440: панель «Клиент» может стоять колонкой. */
export const isWide = watch('(min-width: 1440px)');
/** ≥1800: широкая лента, «Клиент» закреплён по умолчанию. */
export const isHuge = watch('(min-width: 1800px)');
export const reducedMotion = watch('(prefers-reduced-motion: reduce)');

/**
 * Экранная клавиатура (6.0): высота уходит в --kb-inset, поле ответа и тосты
 * поднимаются вместе с ней. CSSOM, а не атрибут style — CSP это не ограничивает.
 */
export function watchKeyboard(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const update = (): void => {
    const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    document.documentElement.style.setProperty('--kb-inset', `${Math.round(inset)}px`);
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  update();
}
