import { CHANNELS } from '../channels.js';

// Типы и константы хранилища. Импортировать снаружи — из core/store.js.

/** next_attempt_at вложения, которое больше не повторяется автоматически. */
export const ATTACHMENT_GAVE_UP = 8_640_000_000_000_000;
/** После стольких неудачных попыток панель показывает ошибку, а не скелетон. */
export const ATTACHMENT_SHOW_FAILED_AFTER = 5;

export interface StoredAttachment {
  id: number; local_path: string | null; media_type: string | null; file_ref: string;
  original_name: string | null; mime_type: string | null; bytes: number | null; next_attempt_at: number;
  attempts: number; last_error: string | null;
}

export type Channel = 'tg_dm' | 'tg_bot' | 'bedolaga' | 'minishop';
export type Direction = 'in' | 'out' | 'note';
export type Author = 'client' | 'agent' | 'ai' | 'system';
export type SuggestionStatus = 'pending' | 'sent' | 'edited' | 'rejected' | 'superseded';

export interface Conversation {
  id: number;
  channel: Channel;
  external_id: string;
  remote_external_id: string | null;
  source_id: string | null;
  avatar_source_id: string | null;
  tg_user_id: number | null;
  business_connection_id: string | null;
  username: string | null;
  display_name: string | null;
  subject: string | null;
  status: string;
  priority: string;
  assignee: string | null;
  ai_mode: string;
  escalated: number;
  suspicious: number;
  sub_link: string | null;
  first_inbound_at: number | null;
  last_inbound_at: number | null;
  last_message_at: number | null;
  first_response_at: number | null;
  resolved_at: number | null;
  /** Последнее закрытие; не обнуляется новым входящим (миграция 024). */
  last_resolved_at?: number | null;
  last_ai_at: number | null;
  handoff_at: number | null;
  handoff_notified_at: number | null;
  avatar_file_id: string | null;
  operator_active_at: number | null;
  assigned_operator_id: number | null;
  claimed_at: number | null;
  customer_profile_id: number | null;
  unread: number;
  hidden_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SourceAccount {
  id: string;
  kind: 'telegram_bot' | 'telegram_business' | 'bedolaga' | 'minishop' | 'remnawave';
  name: string;
  enabled: number;
  metadata: string | null;
  updated_at: number;
}

export interface InboxFolder {
  id: number;
  name: string;
  color: string | null;
  position: number;
  source_ids: string[];
}

/**
 * Клиентские тексты и название конкретного сервиса. Профиль привязан к
 * источнику, а не к транспорту диалога: Telegram-чат может быть связан с
 * одной из нескольких панелей Remnawave и получить именно её бренд.
 */
export interface ServiceProfile {
  sourceId: string;
  serviceName: string;
  greetingMessage: string;
  handoffMessage: string;
}

/** Вложение в том виде, в каком его показывает панель. */
export interface Attachment {
  id: number;
  media_type: string | null;
  width: number | null;
  height: number | null;
  original_name: string | null;
  mime_type: string | null;
  bytes: number | null;
}

export interface Message {
  id: number;
  conversation_id: number;
  direction: Direction;
  author: Author;
  text: string | null;
  media_type: string | null;
  media_file_id: string | null;
  external_msg_id: string | null;
  sender_tg_user_id: number | null;
  suggestion_id: number | null;
  reply_to_external_id: string | null;
  reply_excerpt: string | null;
  created_at: number;
  is_backfill: number;
}

export interface Suggestion {
  id: number;
  conversation_id: number;
  message_id: number | null;
  text: string;
  confidence: number | null;
  needs_human: number;
  reason: string | null;
  model: string | null;
  sources: string | null;
  status: SuggestionStatus;
  decided_at: number | null;
  created_at: number;
  /** Чем закончилась предложка: итоговый текст оператора (миграция 022). */
  final_text?: string | null;
  /** Сообщение, которым ушёл итоговый ответ человека. */
  answer_message_id?: number | null;
  /** Подсказка оператору от модели, клиенту не уходит (миграция 023). */
  operator_note?: string | null;
}

export interface Template {
  id: number;
  shortcut: string;
  title: string;
  body: string;
  uses: number;
  created_at: number;
}

export interface KbHit {
  id: number;
  source: string;
  title: string;
  body: string;
  score: number;
}

export interface InboundMessage {
  channel: Channel;
  externalId: string;
  sourceId?: string;
  sourceName?: string;
  sourceKind?: SourceAccount['kind'];
  avatarSourceId?: string;
  tgUserId?: number;
  /** Реальный автор Telegram update; нужен для точной атрибуции направления. */
  senderTgUserId?: number;
  businessConnectionId?: string;
  username?: string;
  displayName?: string;
  avatarFileId?: string;
  subject?: string;
  text?: string;
  mediaType?: string;
  mediaFileId?: string;
  externalMsgId?: string;
  /** Размеры картинки: панель резервирует под неё место заранее. */
  mediaWidth?: number;
  mediaHeight?: number;
  /** На какое сообщение это ответ — идентификатор в исходной системе. */
  replyToExternalId?: string;
  /** Текст цитируемого сообщения: показываем его, даже если оригинал не у нас. */
  replyExcerpt?: string;
  sentAt: number;
  /** Догрузка истории: слушатели (AI, SLA) такие сообщения игнорируют. */
  backfill?: boolean;
}

/**
 * Telegram разрешает боту писать в личный чат только если оттуда было
 * входящее за последние 24 часа. Для канала бедолаги ограничения нет.
 */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WindowState {
  applies: boolean;
  open: boolean;
  msLeft: number;
}

export function replyWindow(conv: Conversation, now = Date.now()): WindowState {
  if (!CHANNELS[conv.channel].replyWindow) return { applies: false, open: true, msLeft: Infinity };
  if (!conv.last_inbound_at) return { applies: true, open: false, msLeft: 0 };
  const msLeft = conv.last_inbound_at + REPLY_WINDOW_MS - now;
  return { applies: true, open: msLeft > 0, msLeft: Math.max(0, msLeft) };
}

export type StoreEvents = {
  message: [{ conversation: Conversation; message: Message; backfill: boolean }];
  message_updated: [{ conversation: Conversation; message: Message }];
  attachment_retry: [{ id: number }];
  message_deleted: [{ conversation: Conversation; message: Message }];
  conversation_deleted: [Conversation];
  suggestion: [{ conversation: Conversation; suggestion: Suggestion }];
  conversation: [Conversation];
};
