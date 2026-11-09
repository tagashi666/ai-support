/**
 * Палитра ⌘K (6.5): команды, переходы и настройки по названию и по старым
 * словам. Чистые функции — тест palette.test.ts сверяет команды с реестром
 * действий и клавишами (7.4: «команды палитры и подсказки клавиш совпадают
 * с реестром»).
 */
import type { Key } from '@/i18n/ru';
import type { ActionId } from '@/lib/workspace/registry';

export type Group = 'actions' | 'chats' | 'messages' | 'clients' | 'articles' | 'settings' | 'recent';

export interface CommandDef {
  id: string;
  label: Key;
  group: 'actions' | 'settings';
  /** Действие реестра — право и ярус берутся оттуда. */
  action?: ActionId;
  /** Только внутри открытого диалога (идут первыми, 6.5). */
  inThread?: boolean;
  /** Клавиша — подсказка справа (латиницей, по event.code). */
  keys?: string;
  /** Старые слова классики, по которым тоже находится (6.5). */
  words?: readonly string[];
}

/** Команды в порядке показа. Клавиши одной буквой показаны, только если включены в «Этом устройстве». */
export const COMMANDS: readonly CommandDef[] = [
  { id: 'thread.resolve', label: 'thread.resolve', group: 'actions', action: 'conv.resolve', inThread: true, keys: 'E' },
  { id: 'thread.take', label: 'who.take', group: 'actions', action: 'conv.take', inThread: true, keys: 'T' },
  { id: 'thread.giveBack', label: 'who.giveBack', group: 'actions', action: 'conv.return', inThread: true },
  { id: 'thread.note', label: 'palette.note', group: 'actions', action: 'conv.note', inThread: true, keys: 'N' },
  { id: 'thread.client', label: 'palette.client', group: 'actions', inThread: true, keys: 'I' },
  { id: 'thread.important', label: 'thread.markImportant', group: 'actions', action: 'conv.important', inThread: true },
  { id: 'thread.hide', label: 'thread.hide', group: 'actions', action: 'conv.hide', inThread: true },
  { id: 'thread.prev', label: 'palette.prev', group: 'actions', inThread: true, keys: '[' },
  { id: 'thread.next', label: 'palette.next', group: 'actions', inThread: true, keys: ']' },
  { id: 'go.chats', label: 'palette.goChats', group: 'actions', keys: 'G D', words: ['инбокс', 'входящие', 'очередь'] },
  { id: 'go.today', label: 'palette.goToday', group: 'actions', keys: 'G S', words: ['сводка'] },
  { id: 'go.knowledge', label: 'palette.goKnowledge', group: 'actions', keys: 'G K', words: ['база знаний', 'статьи'] },
  { id: 'go.assistant', label: 'palette.goAssistant', group: 'actions', keys: 'G A', words: ['ai', 'ии', 'нейросеть'] },
  { id: 'go.device', label: 'palette.goDevice', group: 'actions', words: ['тема', 'шрифт', 'оформление'] },
  { id: 'theme.light', label: 'palette.themeLight', group: 'actions', words: ['светлая', 'тема'] },
  { id: 'theme.dark', label: 'palette.themeDark', group: 'actions', words: ['тёмная', 'темная', 'ночь', 'тема'] },
  { id: 'theme.auto', label: 'palette.themeAuto', group: 'actions', words: ['системная', 'тема'] },
  { id: 'keys', label: 'palette.keys', group: 'actions', keys: '?', words: ['горячие клавиши', 'сочетания'] },
  { id: 'classic', label: 'palette.classic', group: 'actions', words: ['старая панель', 'классика'] },
  // Настройки: разделы, которых в новой панели ещё нет, открываются в классике (#v=<раздел>).
  { id: 'set.assistant', label: 'palette.setAssistant', group: 'settings', words: ['предложка', 'тень', 'режим', 'ai', 'ии', 'ai-студия', 'промпт', 'модель'] },
  { id: 'set.lab', label: 'palette.setLab', group: 'settings', words: ['ai-студия', 'студия', 'проверка'] },
  { id: 'set.knowledge', label: 'palette.setKnowledge', group: 'settings', words: ['база знаний', 'kb', 'майнинг', 'идеи'] },
  { id: 'set.sla', label: 'palette.setSla', group: 'settings', words: ['sla', 'сроки', 'контроль sla', 'очередь'] },
  { id: 'set.reports', label: 'palette.setReports', group: 'settings', words: ['аналитика', 'статистика', 'отчёты'] },
  { id: 'set.nodes', label: 'palette.setNodes', group: 'settings', words: ['нода', 'ноды', 'узлы', 'инфраструктура', 'серверы'] },
  { id: 'set.team', label: 'palette.setTeam', group: 'settings', words: ['команда', 'роли', 'операторы', 'lease', 'доступ'] },
  { id: 'set.system', label: 'palette.setSystem', group: 'settings', words: ['обновление', 'здоровье', 'диагностика', 'состояние'] },
  { id: 'set.connections', label: 'palette.setConnections', group: 'settings', words: ['подключения', 'каналы', 'bedolaga', 'remnawave', 'telegram', 'настройки'] },
];

/** Действия одной буквой (7.3, по умолчанию выключены): код клавиши → команда. */
export const LETTERS: Readonly<Record<string, string>> = {
  KeyE: 'thread.resolve', KeyN: 'thread.note', KeyR: 'thread.reply', KeyT: 'thread.take', KeyI: 'thread.client', KeyX: 'list.select',
};

/** Раздел классики для команды настроек (#v=<раздел>). */
export const CLASSIC_VIEW: Record<string, string> = {
  'set.assistant': 'settings', 'set.lab': 'lab', 'set.knowledge': 'kb', 'set.sla': 'queue', 'set.reports': 'stats',
  'set.nodes': 'nodes', 'set.team': 'team', 'set.system': 'diagnostics', 'set.connections': 'settings', 'go.knowledge': 'kb', 'go.assistant': 'settings',
};

const norm = (text: string): string => text.toLowerCase().replace(/ё/g, 'е').trim();

/** Совпадение по названию или старому слову; префикс «>» — только команды. */
export function matchCommand(def: CommandDef, label: string, query: string): boolean {
  const q = norm(query.replace(/^>/, ''));
  if (!q) return true;
  if (norm(label).includes(q)) return true;
  return (def.words ?? []).some((word) => norm(word).includes(q) || q.includes(norm(word)));
}

/** «>» в начале — режим команд: результаты поиска не нужны. */
export const commandsOnly = (query: string): boolean => query.trimStart().startsWith('>');

/** Поиск на сервере — от двух символов (как в классике). */
export const searchable = (query: string): boolean => !commandsOnly(query) && query.trim().length >= 2;

/** Недавние диалоги на устройстве (пустой запрос — «Недавнее»). */
const RECENT_KEY = 'next.recent';
export function readRecent(): number[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((id): id is number => Number.isSafeInteger(id)).slice(0, 8) : [];
  } catch { return []; }
}
export function pushRecent(id: number): void {
  const next = [id, ...readRecent().filter((value) => value !== id)].slice(0, 8);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* только до перезагрузки */ }
}
