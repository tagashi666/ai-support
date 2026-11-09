/**
 * Хранилище прототипа на сигналах. В рабочей панели сюда придут кадры
 * сервера (этап 2); сейчас источник — модуль demo. Компоненты читают только
 * сигналы, порядок списка задают чистые функции из order.ts.
 */
import { computed, signal } from '@preact/signals';
import { seedChats } from '@/demo/seed';
import { isUrgent } from '@/lib/labels';
import { route } from '@/lib/router';
import type { Chat, Who } from '@/lib/types';
import { applyServer, pendingChanges, serverOrder, type Placed } from './order';

export const now = signal(Date.now());
setInterval(() => { now.value = Date.now(); }, 15_000);

export const chats = signal<Chat[]>(seedChats(now.peek()));
export const byId = computed(() => new Map(chats.value.map((chat) => [chat.id, chat])));

/** Открытый диалог — из адреса. */
export const openId = computed(() => (route.value.name === 'chats' ? route.value.id : null));
export const openChat = computed(() => (openId.value ? byId.value.get(openId.value) ?? null : null));

/** Порядок «сервера»: секция, ярус, ключ, id. */
export const ordered = computed<Placed[]>(() =>
  serverOrder(chats.value).map((chat) => ({ id: chat.id, section: chat.section })));

/** Что сейчас показано в списке. Меняется только в спокойный момент или своими действиями. */
export const shown = signal<Placed[]>(ordered.peek());
/** Список под курсором, пальцем или фокусом — строки стоят. */
export const listFrozen = signal(false);

export const target = computed(() => applyServer(shown.value, ordered.value, openId.value));
export const pending = computed(() => pendingChanges(shown.value, target.value));
export const pendingUrgent = computed(() => pending.value.some((id) => {
  const chat = byId.value.get(id);
  return chat !== undefined && chat.section === 'mine' && isUrgent(chat.reason);
}));

export function applyPending(): void {
  shown.value = target.value;
}

/** «Ждут вас» = секция mine (7.1 п.9). Это бейдж «Диалогов» и число на «Сегодня». */
export const waitingYou = computed(() => chats.value.filter((chat) => chat.section === 'mine'));
export const aiLeads = computed(() => chats.value.filter((chat) => chat.section === 'ai'));

/** Пауза помощника везде (до времени). */
export const pausedUntil = signal<number | null>(null);

/** Текст в поле ответа по диалогам (черновик на устройстве). */
export const composerText = signal<Record<string, string>>({});
export const composerMode = signal<Record<string, 'reply' | 'note'>>({});

export function textOf(id: string): string {
  return composerText.value[id] ?? '';
}

export function setText(id: string, text: string): void {
  composerText.value = { ...composerText.value, [id]: text };
}

/** Режим с учётом паузы везде: пауза перекрывает «отвечает» и «подсказывает». */
export function effectiveWho(chat: Chat, paused: number | null): Who {
  if (paused !== null && (chat.who.kind === 'aiAuto' || chat.who.kind === 'aiSuggest')) {
    return { kind: 'paused', until: paused };
  }
  return chat.who;
}

export function windowClosed(chat: Chat, at: number): boolean {
  return chat.windowEndsAt !== undefined && chat.windowEndsAt <= at;
}

export function updateChat(id: string, change: (chat: Chat) => Chat): void {
  chats.value = chats.value.map((chat) => (chat.id === id ? change(chat) : chat));
}

export function upsertChat(next: Chat): void {
  chats.value = chats.value.some((chat) => chat.id === next.id)
    ? chats.value.map((chat) => (chat.id === next.id ? next : chat))
    : [...chats.value, next];
}

/** Объявление для экранного диктора (polite): «Новое сообщение от …». */
export const announcement = signal('');

/** Тема: Авто / Светлая / Тёмная (вопрос 14.1а). Хранится на устройстве. */
export type Theme = 'auto' | 'light' | 'dark';
const readTheme = (): Theme => {
  try {
    const value = localStorage.getItem('next.theme');
    return value === 'light' || value === 'dark' ? value : 'auto';
  } catch {
    return 'auto';
  }
};
export const theme = signal<Theme>(readTheme());
export function setTheme(value: Theme): void {
  theme.value = value;
  try { localStorage.setItem('next.theme', value); } catch { /* панель работает и без хранилища */ }
  applyTheme();
}
export function applyTheme(): void {
  const root = document.documentElement;
  if (theme.value === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme.value);
}

/** Панель «Клиент» закреплена колонкой (≥1440). */
export const clientPinned = signal<boolean | null>(null);
