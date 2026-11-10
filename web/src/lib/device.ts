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
export type Density = 'comfortable' | 'compact';
export type StartScreen = 'today' | 'chats';

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
/** Плотность (6.12): компактно — меньше строки и кнопки, для мыши. */
export const density = signal<Density>(pick(read('next.density'), ['comfortable', 'compact'] as const, 'comfortable'));
/** С чего начинать; null — по ширине экрана (14.3а: телефон — «Сегодня», компьютер — «Диалоги»). */
const savedStart = pick<StartScreen | 'auto'>(read('next.start'), ['today', 'chats', 'auto'] as const, 'auto');
export const startScreen = signal<StartScreen | null>(savedStart === 'auto' ? null : savedStart);
/** Enter отправляет ответ (Shift+Enter — новая строка); выключено — отправка ⌘/Ctrl+Enter. */
export const enterSends = signal(read('next.enterSends') === 'on');
/** Звук, когда прибавилось «Ждут вас», — выключен по умолчанию. */
export const waitSound = signal(read('next.waitSound') === 'on');
/** Уведомления браузера (7.7), пока вкладка открыта: по умолчанию выключены, включаются с разрешения браузера. */
export const browserNotify = signal(read('next.notify') === 'on');

export function setTextSize(value: TextSize): void { textSize.value = value; write('next.textSize', String(value)); }
export function setUndo(seconds: UndoSeconds, scope: UndoScope = undoScope.peek()): void {
  undoSeconds.value = seconds; undoScope.value = scope;
  write('next.undoSeconds', String(seconds)); write('next.undoScope', scope);
}
export function setNavKeys(on: boolean): void { navKeys.value = on; write('next.navKeys', on ? 'on' : 'off'); }
export function setLetterKeys(on: boolean): void { letterKeys.value = on; write('next.letterKeys', on ? 'on' : 'off'); }
export function setGestures(on: boolean): void { gestures.value = on; write('next.gestures', on ? 'on' : 'off'); }
export function setDensity(value: Density): void { density.value = value; write('next.density', value); }
export function setStartScreen(value: StartScreen | null): void { startScreen.value = value; write('next.start', value ?? 'auto'); }
export function setEnterSends(on: boolean): void { enterSends.value = on; write('next.enterSends', on ? 'on' : 'off'); }
export function setWaitSound(on: boolean): void { waitSound.value = on; write('next.waitSound', on ? 'on' : 'off'); }
export function setBrowserNotify(on: boolean): void { browserNotify.value = on; write('next.notify', on ? 'on' : 'off'); }

/** Отправить ли по этой клавише: ⌘/Ctrl+Enter — всегда; просто Enter — если включено «Enter отправляет». */
export function isSendKey(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'isComposing'>, enter = enterSends.peek()): boolean {
  if (event.key !== 'Enter' || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey) return true;
  return enter && !event.shiftKey && !event.altKey;
}

/** Короткий сигнал «ждут вас» без файлов: Web Audio, две ноты. */
export function playWaitSound(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + i * 0.15 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.15 + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.15);
      osc.stop(ctx.currentTime + i * 0.15 + 0.15);
    });
    window.setTimeout(() => { void ctx.close(); }, 600);
  } catch { /* браузер не дал звук — молча */ }
}

/** Окно отмены для черновика помощника и для своего текста, мс. */
export const draftUndoMs = (): number => undoSeconds.peek() * 1000;
export const ownUndoMs = (): number => (undoScope.peek() === 'all' ? undoSeconds.peek() * 1000 : 0);

export function applyTextSize(): void {
  if (typeof document === 'undefined') return;
  effect(() => {
    document.documentElement.style.fontSize = textSize.value === 100 ? '' : `${textSize.value}%`;
  });
  effect(() => {
    if (density.value === 'compact') document.documentElement.dataset.density = 'compact';
    else delete document.documentElement.dataset.density;
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
