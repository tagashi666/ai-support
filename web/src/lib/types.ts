/**
 * Модель прототипа. Формы повторяют будущую проекцию списка из плана (7.1,
 * 10.2): состояние и причину считает «сервер» (здесь — модуль demo), панель
 * только показывает. Значения перечислений на экран не выводятся — подписи
 * берутся через lib/labels.ts и словарь.
 */
import type { ConfidenceLevel } from '@shared/confidence';

export type Section = 'mine' | 'colleagues' | 'ai' | 'client' | 'done';
export type Channel = 'telegram' | 'business' | 'bedolaga' | 'minishop';

export type Reason =
  | { kind: 'asksHuman' }
  | { kind: 'handedOver'; topic: string }
  | { kind: 'slaOver'; since: number }
  | { kind: 'aiSilent' }
  | { kind: 'draftUnsure' }
  | { kind: 'draftReady' }
  | { kind: 'important' }
  | { kind: 'slaSoon'; due: number }
  | { kind: 'waiting' }
  | { kind: 'aiReplying' }
  | { kind: 'aiReplied'; at: number }
  | { kind: 'colleagueLeads'; name: string }
  | { kind: 'waitingClient' }
  | { kind: 'windowClosed' }
  | { kind: 'resolved'; at: number };

/** Кто отвечает в диалоге (чип 6.3.1). «Вы пишете» выводится из поля ответа. */
export type Who =
  | { kind: 'aiAuto' }
  | { kind: 'aiSuggest' }
  | { kind: 'aiWatch' }
  | { kind: 'aiOffHere' }
  | { kind: 'paused'; until: number }
  | { kind: 'handed'; topic: string }
  | { kind: 'youLead' }
  | { kind: 'colleague'; name: string; until: number }
  | { kind: 'resolved' };

export type Author = 'client' | 'you' | 'colleague' | 'assistant' | 'auto';

export interface Message {
  type: 'message';
  id: string;
  author: Author;
  /** Имя коллеги для author = colleague. */
  authorName?: string;
  text: string;
  at: number;
  /** Отправка с окном отмены: время, когда сообщение уйдёт. */
  sendAt?: number;
  failed?: boolean;
}

export interface EventLine {
  type: 'event';
  id: string;
  /** Готовая подпись (уже из словаря). */
  text: string;
  at: number;
}

export interface Note {
  type: 'note';
  id: string;
  authorName: string;
  text: string;
  at: number;
}

export type FeedItem = Message | EventLine | Note;

export interface AssistantDraft {
  text: string;
  level: ConfidenceLevel;
  /** Почему не «Уверен» — короткая причина словами. */
  reason?: string;
  sources: string[];
}

export interface ClientInfo {
  since: number;
  subscriptionUntil: number;
  trafficUsed: number;
  trafficTotal: number;
  devicesUsed: number;
  devicesTotal: number;
  server: string;
  balance: string;
}

export interface Chat {
  id: string;
  name: string;
  handle?: string;
  channel: Channel;
  section: Section;
  reason: Reason;
  who: Who;
  /** Начало ожидания: первое сообщение клиента после последнего ответа. */
  waitingSince?: number;
  lastAt: number;
  unread: boolean;
  important?: boolean;
  /** Конец окна ответа Telegram (24 ч); нет — у канала окна нет. */
  windowEndsAt?: number;
  feed: FeedItem[];
  draft?: AssistantDraft;
  client: ClientInfo;
}
