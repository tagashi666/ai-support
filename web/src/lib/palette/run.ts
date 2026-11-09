/**
 * Выполнение команд палитры и клавиш (7.3, 7.4): одно место, поэтому кнопка,
 * команда палитры и клавиша делают одно и то же и проверяют одно право.
 */
import { signal } from '@preact/signals';
import { navigate, route } from '@/lib/router';
import { setTheme } from '@/lib/store/state';
import { drafts, draftTick, giveBack, hide, itemOf, meKey, permissions, resolve, setImportant, take } from '@/lib/workspace/actions';
import { availability } from '@/lib/workspace/registry';
import { CLASSIC_VIEW, COMMANDS, type CommandDef } from './commands';
export { LETTERS } from './commands';

export const paletteOpen = signal(false);
export const keysHelpOpen = signal(false);
/** Порядок строк, которые сейчас видны в списке, — для [ и ]. */
export const listOrder = signal<number[]>([]);
/** Лист «Внешняя заявка: закрыть?» для «Решено» не из шапки (7.6) — открывает список. */
export const askResolveTicket = signal<number | null>(null);

export function openThreadId(): number | null {
  const current = route.peek();
  return current.name === 'chats' && current.id && /^\d+$/.test(current.id) ? Number(current.id) : null;
}

/** Доступно ли действие тому, кто смотрит: без права команда не показывается. */
export function commandAllowed(def: CommandDef, inThread: boolean): boolean {
  if (def.inThread && !inThread) return false;
  if (!def.action) return true;
  return availability(def.action, permissions.peek()) === 'show';
}

/** Соседний диалог текущего вида: [ — предыдущий, ] — следующий. */
export function step(direction: -1 | 1): boolean {
  const order = listOrder.peek();
  const current = openThreadId();
  if (!order.length) return false;
  const index = current === null ? -1 : order.indexOf(current);
  const next = index === -1 ? order[direction === 1 ? 0 : order.length - 1] : order[index + direction];
  if (next === undefined) return false;
  navigate({ name: 'chats', id: String(next) });
  return true;
}

/** Фокус в поле ответа (R) или на вкладку «Заметка» (N). */
function focusComposer(mode: 'reply' | 'note', id: number): void {
  drafts.set(id, { mode });
  draftTick.value += 1;
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('#composer-input, footer textarea')?.focus());
}

export function runCommand(id: string): void {
  const thread = openThreadId();
  const item = thread !== null ? itemOf(thread) : undefined;
  const classic = CLASSIC_VIEW[id];
  switch (id) {
    case 'thread.resolve':
      if (thread !== null) resolve(thread);
      return;
    case 'thread.take':
      // T — взять себе или вернуть, если уже ведёте вы (7.3).
      if (thread !== null) void (item?.owner?.id === meKey.peek() ? giveBack(thread) : take(thread));
      return;
    case 'thread.giveBack': if (thread !== null) void giveBack(thread); return;
    case 'thread.note': if (thread !== null) focusComposer('note', thread); return;
    case 'thread.reply': if (thread !== null) focusComposer('reply', thread); return;
    case 'thread.client': if (thread !== null) navigate({ name: 'chats', id: String(thread), client: !(route.peek().name === 'chats' && (route.peek() as { client?: boolean }).client) }); return;
    case 'thread.important': if (thread !== null && item) setImportant(thread, !item.flags.important); return;
    case 'thread.hide': if (thread !== null) { hide(thread); navigate({ name: 'chats', id: null }); } return;
    case 'thread.prev': step(-1); return;
    case 'thread.next': step(1); return;
    case 'go.chats': navigate({ name: 'chats', id: null }); return;
    case 'go.today': navigate({ name: 'today' }); return;
    case 'go.device': navigate({ name: 'section', key: 'device' }); return;
    case 'theme.light': setTheme('light'); return;
    case 'theme.dark': setTheme('dark'); return;
    case 'theme.auto': setTheme('auto'); return;
    case 'keys': keysHelpOpen.value = true; return;
    case 'classic': location.assign(`/?ui=classic${thread !== null ? `#c${thread}` : ''}`); return;
    default:
      if (classic) location.assign(`/?ui=classic#v=${classic}`);
  }
}

export const commandById = (id: string): CommandDef | undefined => COMMANDS.find((def) => def.id === id);
