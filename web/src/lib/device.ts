/**
 * «Это устройство» (6.12): настройки браузера, а не системы. Хранятся в
 * localStorage; тема — под ключом `theme`, общим с классикой (значения
 * system/light/dark), чтобы выбор операторов переехал. Без хранилища панель
 * работает с умолчаниями.
 */
import { effect, signal } from '@preact/signals';

const read = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string): void => { try { localStorage.setItem(key, value); } catch { /* до перезагрузки */ } };

export type TextSize = 100 | 112 | 125;
export type UndoSeconds = 0 | 5 | 10;
export type UndoScope = 'drafts' | 'all';

const pick = <T extends string | number>(raw: string | null, allowed: readonly T[], fallback: T): T => {
  const found = allowed.find((value) => String(value) === raw);
  return found ?? fallback;
};

/** Размер текста: корневой размер шрифта — все токены в rem растут вместе. */
export const textSize = signal<TextSize>(pick(read('next.textSize'), [100, 112, 125] as const, 100));
/** Окно отмены отправки (6.3.5, вопрос 14.2): по умолчанию 5 с только для черновиков помощника. */
export const undoSeconds = signal<UndoSeconds>(pick(read('next.undoSeconds'), [0, 5, 10] as const, 5));
export const undoScope = signal<UndoScope>(pick(read('next.undoScope'), ['drafts', 'all'] as const, 'drafts'));
/** Переходы ↓↑, Enter, /, ?, G … — включены. */
export const navKeys = signal(read('next.navKeys') !== 'off');
/** Действия одной буквой (E, N, R, T, I, X) — выключены по умолчанию (7.3, вопрос 14.7, WCAG 2.1.4). */
export const letterKeys = signal(read('next.letterKeys') === 'on');
/** Жесты в списке (7.5) — включены. */
export const gestures = signal(read('next.gestures') !== 'off');

export function setTextSize(value: TextSize): void { textSize.value = value; write('next.textSize', String(value)); }
export function setUndo(seconds: UndoSeconds, scope: UndoScope = undoScope.peek()): void {
  undoSeconds.value = seconds; undoScope.value = scope;
  write('next.undoSeconds', String(seconds)); write('next.undoScope', scope);
}
export function setNavKeys(on: boolean): void { navKeys.value = on; write('next.navKeys', on ? 'on' : 'off'); }
export function setLetterKeys(on: boolean): void { letterKeys.value = on; write('next.letterKeys', on ? 'on' : 'off'); }
export function setGestures(on: boolean): void { gestures.value = on; write('next.gestures', on ? 'on' : 'off'); }

/** Окно отмены для черновика помощника и для своего текста, мс. */
export const draftUndoMs = (): number => undoSeconds.peek() * 1000;
export const ownUndoMs = (): number => (undoScope.peek() === 'all' ? undoSeconds.peek() * 1000 : 0);

export function applyTextSize(): void {
  if (typeof document === 'undefined') return;
  effect(() => {
    document.documentElement.style.fontSize = textSize.value === 100 ? '' : `${textSize.value}%`;
  });
}

/** Тема в классике: system | light | dark. */
export type Theme = 'auto' | 'light' | 'dark';
export function readSharedTheme(): Theme {
  const shared = read('theme');
  if (shared === 'light' || shared === 'dark') return shared;
  if (shared === 'system') return 'auto';
  // Выбор, сделанный в прототипе до общего ключа.
  const old = read('next.theme');
  return old === 'light' || old === 'dark' ? old : 'auto';
}
export function writeSharedTheme(value: Theme): void { write('theme', value === 'auto' ? 'system' : value); }
