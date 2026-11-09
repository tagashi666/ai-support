/**
 * Форма ответов и кадров новой панели (план редизайна, раздел 10, правило 4).
 * Их используют и сервер, и web/: правило проекта «сверяй с формой ответа API»
 * проверяется компилятором и контрактной проверкой в scripts/inboxtest.ts.
 *
 * Явная проекция (правило 5): sub_link, tg_user_id, business_connection_id и
 * прочие служебные поля диалога в список и в кадры новой панели не попадают.
 */
import type { AiMode, AttentionAi, AttentionState, Reason, Section } from './attention.js';

/** Код ошибки в едином формате; поле `error` с текстом остаётся для классики. */
export type ErrorCode =
  | 'window_closed'
  | 'locked_by_other'
  | 'no_sender'
  | 'permission'
  | 'rate_limited'
  | 'upstream'
  | 'not_found'
  | 'bad_request'
  | 'unauthorized';

export interface ApiError {
  error: string;
  code?: ErrorCode;
}

export type LastAuthor = 'client' | 'operator' | 'assistant' | 'system';

export interface InboxLast {
  author: LastAuthor;
  /** text, если вложения нет; иначе тип вложения (photo, voice, video, document, sticker…). */
  kind: string;
  /** Не длиннее 140 символов. */
  text: string;
  at: number;
}

/** Строка списка без полей, зависящих от получателя. Её хранит и сравнивает AttentionWatcher. */
export interface InboxProjection {
  id: number;
  state: AttentionState;
  tier: 0 | 1;
  reason: Reason;
  waiting_since: number | null;
  sla: { due_at: number; overdue: boolean } | null;
  last: InboxLast | null;
  unread: number;
  /** Живое закрепление (claimed_at + 15 мин). id — ключ оператора, как me.id в bootstrap. */
  owner: { id: string; name: string; until: number } | null;
  /** Ответственный: остаётся после конца закрепления («Вёл: Мария»). */
  assignee: { id: string; name: string } | null;
  ai: AttentionAi;
  window: { open: boolean; closes_at: number } | null;
  flags: { important: boolean; not_found: boolean; handoff: boolean };
  priority: string;
  status: string;
  source: { id: string; kind: string; name: string } | null;
  folder_ids: number[];
  customer: { name: string | null; username: string | null; avatar_version: string | null };
  /** Последняя активность (для времени в строке). */
  activity_at: number;
  /** Версия для слияния (7.1 правило 7): запись старше известной отбрасывается. */
  updated_at: number;
}

/** Строка списка для конкретного получателя. */
export interface InboxItem extends InboxProjection {
  section: Section;
  /** «секция|ярус|ключ|id», сравнивается как текст (src/shared/conversation-order.ts). */
  rank: string;
}

export interface SectionCounts {
  mine: number;
  colleagues: number;
  ai: number;
  client: number;
}

export interface InboxCounts {
  /** «Ждут человека»: все needs_human (mine + colleagues), одинаково для всех; = totals.waiting. */
  waiting: number;
  /** Все не решённые. */
  open: number;
  /** Размеры секций для того, кто запрашивает. sections.mine — «Ждут вас». */
  sections: SectionCounts;
  /** «Ждут вас» по папкам. */
  byFolder: Record<string, number>;
}

export type InboxView = 'waiting' | 'open' | 'resolved';

export interface InboxResponse {
  items: InboxItem[];
  /** Курсор следующей страницы — ранг последней строки; null — дальше пусто. */
  next: string | null;
  counts: InboxCounts;
  seq: number;
  epoch: string;
}

export interface BootstrapResponse {
  me: { id: string; name: string; role: string; permissions: string[] };
  version: string;
  capabilities: {
    nodes: boolean;
    update: boolean;
    bedolaga: boolean;
    minishop: boolean;
    remnawave: boolean;
    aiKeys: boolean;
    /** Готовые функции новой панели. */
    inbox: boolean;
    events: boolean;
    typingWithoutClaim: boolean;
  };
  assistant: { mode: AiMode; minConfidence: number; keys: boolean };
  channels: Record<string, boolean>;
  sources: Array<{ id: string; kind: string; name: string; enabled: boolean }>;
  folders: Array<{ id: number; name: string; color: string | null; position: number; source_ids: string[] }>;
  /** ideas — идеи статей на проверке (null без права knowledge:review); problems — появится с разделом «Система». */
  counts: { mine: number; waiting: number; ideas: number | null; problems: number | null };
  /** Есть новая версия; только при праве settings:update, иначе null. */
  update: { available: boolean; latest: string | null } | null;
  live: { seq: number; epoch: string };
}

/** Кадр WebSocket новой панели (сокет с ?v=2). seq растёт на 1, без пропусков. */
export type LiveFrame =
  /** counts — счётчики получателя на момент отправки (в кадрах сокета; в догоне — общие в ответе). */
  | { type: 'inbox_item'; seq: number; epoch: string; item: InboxItem; counts?: InboxCounts }
  | { type: 'inbox_remove'; seq: number; epoch: string; id: number; counts?: InboxCounts }
  | { type: 'settings'; seq: number; epoch: string; aiMode: AiMode; minConfidence: number }
  /** Кадр, который этому получателю не положен по правам: держит seq без пропуска. */
  | { type: 'noop'; seq: number; epoch: string };

/** Служебные кадры: seq не увеличивают, но несут текущий — по ним виден пропуск. */
export type ControlFrame =
  | { type: 'hello'; seq: number; epoch: string }
  | { type: 'tick'; at: number; seq: number; epoch: string };

export type EventsResponse =
  | { reset?: false; epoch: string; seq: number; events: LiveFrame[]; counts: InboxCounts }
  | { reset: true; epoch: string; seq: number };
