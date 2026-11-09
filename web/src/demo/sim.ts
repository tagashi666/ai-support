/**
 * Имитация «сервера» для прототипа: входящие сообщения, ответы помощника,
 * смена состояний. Только синтетика, без сети.
 */
import { batch } from '@preact/signals';
import { t } from '@/i18n/ru';
import { showToast } from '@/lib/actions/toasts';
import { navigate } from '@/lib/router';
import {
  announcement, byId, chats, composerText, now, openId, ordered, pausedUntil, shown, updateChat, upsertChat,
} from '@/lib/store/state';
import type { AssistantDraft, Chat, Message } from '@/lib/types';
import { COLLEAGUE, FOLLOW_UPS, NEW_CLIENTS, newClientInfo, seedChats } from './seed';

const MIN = 60_000;
let step = 0;
let newIndex = 0;
let seq = 5000;
const nid = (prefix: string): string => `${prefix}${(seq += 1)}`;

const clientMessage = (text: string): Message => ({ type: 'message', id: nid('m'), author: 'client', text, at: Date.now() });

function announce(name: string): void {
  announcement.value = '';
  queueMicrotask(() => { announcement.value = t('feed.newMessage', { name }); });
}

/** Новый клиент просит человека: срочно — пилюля янтарная, приходит тост. */
function newClient(): void {
  const pick = NEW_CLIENTS[newIndex % NEW_CLIENTS.length];
  newIndex += 1;
  if (!pick) return;
  const at = Date.now();
  const chat: Chat = {
    id: nid('c'), name: pick.name, channel: 'telegram', section: 'mine',
    reason: { kind: 'handedOver', topic: pick.topic }, who: { kind: 'handed', topic: pick.topic },
    waitingSince: at, lastAt: at, unread: true, windowEndsAt: at + 24 * 60 * MIN,
    feed: [
      { type: 'message', id: nid('m'), author: 'client', text: pick.text, at },
      { type: 'event', id: nid('e'), text: t('event.handed', { topic: pick.topic }), at },
    ],
    client: newClientInfo(at),
  };
  upsertChat(chat);
  showToast({
    text: t('toast.waitsYou', { name: pick.name }),
    action: { label: t('toast.open'), run: () => navigate({ name: 'chats', id: chat.id }) },
  });
}

/** Клиент в «Помощник ведёт» пишет снова; через 2 с помощник отвечает. Строка поднимается в своей секции. */
function aiFollowUp(): void {
  const candidate = chats.value.find((chat) => chat.section === 'ai' && chat.id !== openId.value);
  if (!candidate) { newClient(); return; }
  const message = clientMessage('А на роутер дома тоже можно поставить?');
  updateChat(candidate.id, (c) => ({
    ...c, feed: [...c.feed, message], lastAt: message.at, unread: true, reason: { kind: 'aiReplying' },
  }));
  setTimeout(() => {
    const reply: Message = {
      type: 'message', id: nid('m'), author: 'assistant', at: Date.now(),
      text: 'Да, можно. Подойдёт роутер с поддержкой своих прошивок — инструкцию пришлю, если подскажете модель.',
    };
    updateChat(candidate.id, (c) => ({ ...c, feed: [...c.feed, reply], lastAt: reply.at, reason: { kind: 'aiReplied', at: reply.at } }));
  }, 2000);
}

/** Клиент из «Ждём клиента» отвечает: диалог переходит в «Ждут вас», помощник готовит черновик. */
function clientReturns(): void {
  const candidate = chats.value.find((chat) => chat.section === 'client' && chat.id !== openId.value
    && (chat.windowEndsAt === undefined || chat.windowEndsAt > Date.now()));
  if (!candidate) { newClient(); return; }
  const message = clientMessage('Не заработало, всё так же. Что ещё можно сделать?');
  updateChat(candidate.id, (c) => ({
    ...c, feed: [...c.feed, message], lastAt: message.at, unread: true, waitingSince: message.at,
    section: 'mine', reason: { kind: 'waiting' },
  }));
  setTimeout(() => {
    const draft: AssistantDraft = {
      text: 'Давайте попробуем по-другому: в приложении откройте «Настройки» → «Сбросить профиль», затем снова добавьте его по ссылке из личного кабинета.',
      level: 'sure',
      sources: ['Профиль пропал после обновления'],
    };
    updateChat(candidate.id, (c) => ({ ...c, draft, reason: { kind: 'draftReady' } }));
  }, 2500);
}

/** Сообщение в открытом диалоге: появляется в ленте, строка не уезжает. */
function inOpenChat(): boolean {
  const chat = openId.value ? byId.value.get(openId.value) : undefined;
  if (!chat || chat.section === 'done' || chat.who.kind === 'colleague') return false;
  const text = FOLLOW_UPS[step % FOLLOW_UPS.length] ?? FOLLOW_UPS[0] ?? '';
  const message = clientMessage(text);
  updateChat(chat.id, (c) => ({
    ...c, feed: [...c.feed, message], lastAt: message.at, waitingSince: c.section === 'mine' ? c.waitingSince : message.at,
    section: c.section === 'client' ? 'mine' : c.section,
    reason: c.section === 'client' ? { kind: 'waiting' } : c.reason,
    windowEndsAt: c.windowEndsAt !== undefined ? message.at + 24 * 60 * MIN : undefined,
  }));
  announce(chat.name);
  return true;
}

/** Кнопка «демо: новое сообщение»: по кругу разные события. */
export function demoIncoming(): void {
  step += 1;
  const kind = step % 4;
  if (kind === 0 && inOpenChat()) return;
  if (kind === 1) newClient();
  else if (kind === 2) aiFollowUp();
  else clientReturns();
}

export type DemoState = 'handed' | 'aiAuto' | 'youLead' | 'colleague' | 'window';

/** Смена состояния открытого диалога — чтобы посмотреть все варианты чипа и поля ответа. */
export function demoSetState(state: DemoState): void {
  const chatId = openId.value;
  if (!chatId) return;
  const at = Date.now();
  updateChat(chatId, (c) => {
    const reopened = c.section === 'done' ? { section: 'mine' as const, reason: { kind: 'waiting' as const }, waitingSince: at } : {};
    const windowOpen = { windowEndsAt: c.windowEndsAt !== undefined && c.windowEndsAt <= at ? at + 20 * 60 * MIN : c.windowEndsAt ?? at + 20 * 60 * MIN };
    switch (state) {
      case 'handed': return { ...c, ...reopened, ...windowOpen, who: { kind: 'handed', topic: 'просит человека' } };
      case 'aiAuto': return { ...c, ...reopened, ...windowOpen, who: { kind: 'aiAuto' } };
      case 'youLead': return { ...c, ...reopened, ...windowOpen, who: { kind: 'youLead' } };
      case 'colleague': return { ...c, ...reopened, ...windowOpen, who: { kind: 'colleague', name: COLLEAGUE.name, until: at + 14 * MIN } };
      case 'window': return { ...c, ...reopened, windowEndsAt: at - 2 * 60 * MIN, who: { kind: 'aiSuggest' }, lastAt: Math.min(c.lastAt, at - 26 * 60 * MIN) };
    }
  });
}

export function demoSetDraft(level: AssistantDraft['level']): void {
  const chatId = openId.value;
  if (!chatId) return;
  const texts: Record<AssistantDraft['level'], AssistantDraft> = {
    sure: {
      text: 'Здравствуйте! Ссылку на подписку отправили в этот чат — откройте её на телефоне, приложение добавит профиль само.',
      level: 'sure', sources: ['Как добавить подписку', 'данные подписки'],
    },
    check: {
      text: 'Здравствуйте! Удалите профиль в приложении и добавьте его заново по ссылке из личного кабинета.',
      level: 'check', reason: 'про эту ошибку статьи нет', sources: ['Подключение на iOS'],
    },
    unsure: {
      text: 'Возможно, дело в настройках роутера. Попробуйте подключиться через мобильную сеть.',
      level: 'unsure', reason: 'вопрос не похож ни на одну статью', sources: [],
    },
  };
  updateChat(chatId, (c) => ({ ...c, draft: texts[level] }));
}

export function demoReset(): void {
  batch(() => {
    const fresh = seedChats(Date.now());
    chats.value = fresh;
    shown.value = ordered.value;
    pausedUntil.value = null;
    composerText.value = {};
    now.value = Date.now();
  });
  navigate({ name: 'home' }, true);
}
