/**
 * Действия над диалогом (реестр 7.4 в малом виде) с ярусами отмены (7.6):
 * обратимое — сразу и тост «Отменить» на 6 с; отправка черновика — окно 5 с
 * (вопрос 14.2а: свой текст уходит сразу); необратимое — через лист.
 *
 * В прототипе «сервер» — локальное состояние: запросов нет.
 */
import { batch } from '@preact/signals';
import { ME } from '@/demo/seed';
import { t } from '@/i18n/ru';
import { removeShown, restoreShown } from '@/lib/store/order';
import {
  byId, chats, composerMode, now, pausedUntil, setText, shown, updateChat,
} from '@/lib/store/state';
import type { Chat, FeedItem, Message } from '@/lib/types';
import { showToast, undoToast } from './toasts';

export const SEND_UNDO_MS = 5000;

let seq = 1000;
const id = (prefix: string): string => `${prefix}${(seq += 1)}`;
const at = (): number => Date.now();
const eventItem = (text: string): FeedItem => ({ type: 'event', id: id('e'), text, at: at() });
const undoLabel = (): string => t('toast.undo');

/** Снимок для отмены: диалог и его место в списке. */
function snapshot(chatId: string): () => void {
  const before = byId.value.get(chatId);
  const list = shown.value;
  return () => batch(() => {
    if (before) updateChat(chatId, () => before);
    shown.value = list;
  });
}

export function markRead(chatId: string): void {
  const chat = byId.value.get(chatId);
  if (chat?.unread) updateChat(chatId, (c) => ({ ...c, unread: false }));
}

/** «Решено»: строка уходит сразу (своё действие), «Отменить» возвращает её на то же место. */
export function resolve(chatId: string): void {
  const chat = byId.value.get(chatId);
  if (!chat || chat.section === 'done') return;
  const undo = snapshot(chatId);
  batch(() => {
    updateChat(chatId, (c) => ({
      ...c, section: 'done', reason: { kind: 'resolved', at: at() }, who: { kind: 'resolved' }, draft: undefined,
      feed: [...c.feed, eventItem(t('event.resolved'))],
    }));
    const { list, index, entry } = removeShown(shown.value, chatId);
    if (entry) shown.value = restoreShown(list, { ...entry, section: 'done' }, index);
  });
  undoToast(t('toast.resolved', { name: chat.name }), undo, undoLabel());
}

export function reopen(chatId: string): void {
  const chat = byId.value.get(chatId);
  if (!chat) return;
  const undo = snapshot(chatId);
  updateChat(chatId, (c) => ({
    ...c, section: 'mine', reason: { kind: 'waiting' }, who: { kind: 'aiSuggest' }, waitingSince: at(),
    feed: [...c.feed, eventItem(t('event.reopened'))],
  }));
  undoToast(t('toast.reopened', { name: chat.name }), undo, undoLabel());
}

/** «Взять себе» останавливает помощника — применяется мгновенно, с «Отменить». */
export function take(chatId: string): void {
  const undo = snapshot(chatId);
  updateChat(chatId, (c) => ({ ...c, who: { kind: 'youLead' }, feed: [...c.feed, eventItem(t('event.youTook'))] }));
  undoToast(t('toast.took'), undo, undoLabel());
}

export function giveBack(chatId: string): void {
  const undo = snapshot(chatId);
  updateChat(chatId, (c) => ({ ...c, who: { kind: 'aiSuggest' }, feed: [...c.feed, eventItem(t('event.backToAi'))] }));
  undoToast(t('toast.gaveBack'), undo, undoLabel());
}

export function intercept(chatId: string, colleague: string): void {
  updateChat(chatId, (c) => ({
    ...c, who: { kind: 'youLead' }, section: 'mine', reason: { kind: 'waiting' },
    feed: [...c.feed, eventItem(t('event.intercepted', { name: colleague }))],
  }));
}

export type HereMode = 'aiAuto' | 'aiSuggest' | 'aiWatch' | 'aiOffHere';
export function setModeHere(chatId: string, mode: HereMode): void {
  const undo = snapshot(chatId);
  updateChat(chatId, (c) => ({ ...c, who: { kind: mode } }));
  const label = t(mode === 'aiAuto' ? 'who.aiAuto' : mode === 'aiSuggest' ? 'who.aiSuggest'
    : mode === 'aiWatch' ? 'who.aiWatch' : 'who.aiOffHere');
  undoToast(t('who.modeChanged', { mode: label.toLocaleLowerCase('ru') }), undo, undoLabel());
}

export function pause(): void {
  const until = at() + 60 * 60_000;
  pausedUntil.value = until;
  undoToast(t('toast.paused', { time: new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(until) }),
    () => { pausedUntil.value = null; }, undoLabel());
}

export function resume(): void {
  const before = pausedUntil.value;
  pausedUntil.value = null;
  undoToast(t('toast.resumed'), () => { pausedUntil.value = before; }, undoLabel());
}

/** После ответа человека: диалог ждёт клиента, вы ведёте. Открытая строка не уезжает (7.1 п.6). */
function afterReply(c: Chat, message: Message): Chat {
  return {
    ...c,
    feed: [...c.feed, message],
    who: { kind: 'youLead' },
    section: 'client',
    reason: { kind: 'waitingClient' },
    waitingSince: message.at,
    lastAt: message.at,
    draft: undefined,
  };
}

/** Свой текст уходит сразу (14.2а). */
export function sendText(chatId: string, text: string): void {
  const body = text.trim();
  if (!body) return;
  const message: Message = { type: 'message', id: id('m'), author: 'you', text: body, at: at() };
  batch(() => {
    updateChat(chatId, (c) => afterReply(c, message));
    setText(chatId, '');
  });
}

const pendingSends = new Map<string, { chatId: string; timer: ReturnType<typeof setTimeout> }>();

function finalizeSend(messageId: string): void {
  const pendingSend = pendingSends.get(messageId);
  if (!pendingSend) return;
  clearTimeout(pendingSend.timer);
  pendingSends.delete(messageId);
  const sentAt = at();
  updateChat(pendingSend.chatId, (c) => {
    const feed = c.feed.map((item) => (item.id === messageId && item.type === 'message'
      ? { ...item, sendAt: undefined, at: sentAt } : item));
    const message = feed.find((item) => item.id === messageId) as Message | undefined;
    return message ? { ...afterReply({ ...c, feed: feed.filter((item) => item.id !== messageId) }, message) } : c;
  });
}

/** Черновик помощника: окно отмены 5 с, пузырь «отправим через 4 с · Отменить». */
export function sendDraft(chatId: string): void {
  const chat = byId.value.get(chatId);
  if (!chat?.draft || chat.draft.level === 'unsure') return;
  const draft = chat.draft;
  const message: Message = { type: 'message', id: id('m'), author: 'you', text: draft.text, at: at(), sendAt: at() + SEND_UNDO_MS };
  updateChat(chatId, (c) => ({ ...c, draft: undefined, feed: [...c.feed, message] }));
  const timer = setTimeout(() => finalizeSend(message.id), SEND_UNDO_MS);
  pendingSends.set(message.id, { chatId, timer });
}

export function sendNow(messageId: string): void {
  finalizeSend(messageId);
}

export function cancelSend(chatId: string, messageId: string): void {
  const pendingSend = pendingSends.get(messageId);
  if (pendingSend) clearTimeout(pendingSend.timer);
  pendingSends.delete(messageId);
  updateChat(chatId, (c) => {
    const message = c.feed.find((item) => item.id === messageId);
    if (!message || message.type !== 'message') return c;
    return {
      ...c,
      feed: c.feed.filter((item) => item.id !== messageId),
      draft: c.draft ?? { text: message.text, level: 'sure', sources: [] },
    };
  });
}

/** Скрыли вкладку во время отсчёта — сообщение уходит сразу: человек уже нажал «Отправить». */
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') for (const messageId of [...pendingSends.keys()]) finalizeSend(messageId);
});
addEventListener('pagehide', () => { for (const messageId of [...pendingSends.keys()]) finalizeSend(messageId); });

/** «Править» переносит черновик в поле, курсор в конец. */
export function editDraft(chatId: string): void {
  const chat = byId.value.get(chatId);
  if (!chat?.draft) return;
  const text = chat.draft.text;
  batch(() => {
    setText(chatId, text);
    composerMode.value = { ...composerMode.value, [chatId]: 'reply' };
    updateChat(chatId, (c) => ({ ...c, draft: undefined }));
  });
}

export function rejectDraft(chatId: string): void {
  const undo = snapshot(chatId);
  updateChat(chatId, (c) => ({ ...c, draft: undefined }));
  undoToast(t('draft.rejected'), undo, undoLabel());
}

export function saveNote(chatId: string, text: string): void {
  const body = text.trim();
  if (!body) return;
  batch(() => {
    updateChat(chatId, (c) => ({ ...c, feed: [...c.feed, { type: 'note', id: id('n'), authorName: ME.name, text: body, at: at() }] }));
    setText(chatId, '');
  });
  showToast({ text: t('toast.noteSaved') });
}

export function waitClient(chatId: string): void {
  const undo = snapshot(chatId);
  updateChat(chatId, (c) => ({ ...c, section: 'client', reason: { kind: 'waitingClient' }, waitingSince: c.waitingSince ?? at() }));
  undoToast(t('toast.waitClient'), undo, undoLabel());
}

export function toggleImportant(chatId: string): void {
  const chat = byId.value.get(chatId);
  if (!chat) return;
  const undo = snapshot(chatId);
  const important = !chat.important;
  updateChat(chatId, (c) => ({
    ...c, important,
    ...(important && c.section !== 'done' ? { section: 'mine' as const, reason: { kind: 'important' as const }, waitingSince: c.waitingSince ?? at() } : {}),
  }));
  undoToast(t(important ? 'toast.important' : 'toast.unimportant'), undo, undoLabel());
}

/** «Убрать из списка»: строка уходит сразу, вернётся, если клиент напишет. */
export function hide(chatId: string): void {
  const before = chats.value;
  const list = shown.value;
  batch(() => {
    chats.value = chats.value.filter((chat) => chat.id !== chatId);
    shown.value = removeShown(shown.value, chatId).list;
  });
  undoToast(t('toast.hidden'), () => batch(() => { chats.value = before; shown.value = list; }), undoLabel());
}

export function copyLink(chatId: string): void {
  void navigator.clipboard?.writeText(`${location.origin}${import.meta.env.BASE_URL}chats/${chatId}`).catch(() => undefined);
  showToast({ text: t('toast.linkCopied') });
}

export { now };
