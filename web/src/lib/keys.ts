/**
 * Клавиши (7.3): привязка по физической клавише (event.code), поэтому всё
 * работает и в русской раскладке (J — это «О»); подписи латиницей. ⌘ на
 * macOS, Ctrl на остальных. Одиночные клавиши — только когда фокус не в поле
 * ввода и нет открытого листа.
 */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** ⌘ на macOS, Ctrl на остальных. */
export const modLabel = (): string => (isMac ? '⌘' : 'Ctrl+');

export const isMod = (event: KeyboardEvent): boolean => (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

/** Фокус в поле ввода: одиночные клавиши не перехватываем. */
export function inField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
}

/** Открыт лист или палитра — верхний слой сам решает, что делать с клавишами. */
export function layerOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('dialog[open]') !== null;
}

/** Без модификаторов (Shift допустим, если просили). */
export const plain = (event: KeyboardEvent, shift = false): boolean =>
  !event.metaKey && !event.ctrlKey && !event.altKey && event.shiftKey === shift;

/** Подпись клавиши по коду: KeyE → E, BracketLeft → [. */
export function codeLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const named: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Slash: '/', Enter: '↵', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓' };
  return named[code] ?? code;
}
