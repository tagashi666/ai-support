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
  /** Канал диалога словами панели (у бота и Business источник по умолчанию общий, по нему канал не понять). */
  channel: 'telegram' | 'business' | 'bedolaga' | 'minishop';
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
  /** pause — пауза помощника везде (10.4 п.1), null — паузы нет. */
  assistant: { mode: AiMode; minConfidence: number; keys: boolean; pause?: AssistantPauseView | null };
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
  /**
   * Смена режима или паузы помощника (10.4 п.7). keys — какие настройки менялись,
   * actor — кто (имя для строки «Мария изменила режим…»), pause — пауза после смены.
   */
  | { type: 'settings'; seq: number; epoch: string; aiMode: AiMode; minConfidence: number;
      keys?: string[]; actor?: { id: string; name: string } | null; pause?: AssistantPauseView | null }
  /** Кадр, который этому получателю не положен по правам: держит seq без пропуска. */
  | { type: 'noop'; seq: number; epoch: string };

/** Служебные кадры: seq не увеличивают, но несут текущий — по ним виден пропуск. */
export type ControlFrame =
  | { type: 'hello'; seq: number; epoch: string }
  | { type: 'tick'; at: number; seq: number; epoch: string };

export type EventsResponse =
  | { reset?: false; epoch: string; seq: number; events: LiveFrame[]; counts: InboxCounts }
  | { reset: true; epoch: string; seq: number };

// --- Диалог в новой панели (этап 3а) --------------------------------------

/** Голос в ленте (6.3.2): клиент, человек из команды, помощник, автосообщение, заметка. */
export type ThreadVoice = 'client' | 'operator' | 'assistant' | 'auto' | 'note';

/** Вложение: состояние вместо пути и file_id источника. */
export interface ThreadAttachment {
  id: number;
  /** photo, voice, video, document, sticker, tgs_sticker, animation… */
  kind: string;
  width: number | null;
  height: number | null;
  name: string | null;
  mime: string | null;
  bytes: number | null;
  /** ready — файл есть; pending — скачивается (сервер ответит 202); failed — скачать не удалось (424). */
  state: 'ready' | 'pending' | 'failed';
}

/**
 * Сообщение ленты — явная проекция строки message (правило 5): без
 * sender_tg_user_id, media_file_id и прочих служебных полей.
 */
export interface ThreadMessage {
  id: number;
  voice: ThreadVoice;
  text: string | null;
  at: number;
  /** text или тип вложения. */
  kind: string;
  /** Кто из команды отправил (10.3 п.3); null — неизвестно (старые ответы) или не человек. */
  author: { id: string; name: string } | null;
  /** Цитата: отрывок сообщения, на которое отвечали. */
  quote: string | null;
  /**
   * Внешний id входящего сообщения Telegram — только он нужен, чтобы
   * ответить цитатой (`replyTo` в POST /reply). null — цитировать нельзя.
   */
  quote_id: string | null;
  /** Ответ ушёл из черновика помощника (для «Почему так?» — GET /api/suggestions/:id). */
  suggestion_id: number | null;
  attachments: ThreadAttachment[];
}

/** Черновик помощника для панели (6.3.4): уровень уверенности считает сервер тем же правилом, что и список. */
export interface ThreadSuggestion {
  id: number;
  text: string;
  /** Оценка 0..1 — только для «Для специалистов». */
  confidence: number | null;
  level: 'sure' | 'check' | 'unsure';
  needs_human: boolean;
  reason: string | null;
  /** «Заметка помощника для вас» (бывшее «Оператору»). */
  operator_note: string | null;
  sources: string[];
  model: string | null;
  status: string;
  created_at: number;
  /** Сообщение клиента, на которое написан черновик. */
  message_id: number | null;
}

/** Событие, которого клиент не видел: строка по центру ленты (6.3.2). */
export interface ThreadEvent {
  id: string;
  at: number;
  kind: 'handoff' | 'took' | 'returned' | 'resolved' | 'reopened' | 'pending' | 'important' | 'unimportant' | 'hidden' | 'unhidden' | 'mode' | 'claimed';
  /** Кто сделал; null — помощник или система. */
  actor: { id: string; name: string } | null;
  /** Для mode — новый режим диалога (inherit | off | shadow | suggest | auto). */
  mode?: string;
}

export interface ThreadPresence { id: string; name: string; state: 'viewing' | 'typing'; at: number }

/** Шапка диалога: строка списка для того, кто смотрит, и то, чего в строке нет. */
export interface ThreadHead {
  item: InboxItem;
  /** Внешняя заявка (Bedolaga, MiniShop): «Решено · закроет заявку», без файлов. */
  ticket: { kind: 'bedolaga' | 'minishop'; number: string | null } | null;
  /** Канал принимает файлы. */
  attachments: boolean;
  /** Отправитель канала подключён. */
  sender: boolean;
  hidden: boolean;
  window: { applies: boolean; open: boolean; closes_at: number | null };
  presence: ThreadPresence[];
}

export interface ThreadResponse {
  head: ThreadHead;
  messages: ThreadMessage[];
  /** Есть сообщения раньше первого в ответе. */
  has_more: boolean;
  suggestion: ThreadSuggestion | null;
  events: ThreadEvent[];
}

/**
 * Кадр ленты для сокета новой панели. Без seq: это подсказка открытому
 * диалогу, а не изменение списка. После разрыва панель перечитывает диалог.
 */
export type ThreadFrame =
  | { type: 'thread'; kind: 'message' | 'message_updated'; conversation_id: number; message: ThreadMessage }
  | { type: 'thread'; kind: 'message_deleted'; conversation_id: number; message_id: number }
  | { type: 'thread'; kind: 'suggestion'; conversation_id: number; suggestion: ThreadSuggestion | null }
  /** Диалог убран из списка или удалён (10.3 п.7). */
  | { type: 'thread'; kind: 'deleted'; conversation_id: number };

/** Ответ отправки: client_msg_id — тот же, что в запросе; повтор отдаёт уже созданное сообщение. */
export interface ReplyResponse {
  ok: true;
  /** Отправленное сообщение в проекции ленты (поле message — сырая строка для классики). */
  thread: ThreadMessage | null;
  client_msg_id: string | null;
  repeated: boolean;
}

// --- Помощник (этап 4, 10.4) ----------------------------------------------

/** Пауза помощника везде: клиентам сам не отвечает, черновики пишет. */
export interface AssistantPauseView {
  /** Конец паузы; null — «пока не включу». */
  until: number | null;
  at: number;
  by: { id: string; name: string } | null;
}

export interface AssistantPauseResponse {
  ok: true;
  pause: AssistantPauseView | null;
}

/**
 * Что сделал помощник — строка ленты «Что делал помощник» (6.7):
 * auto — ответил сам; draft — черновик ждёт; draft_sent — ушёл без правок;
 * draft_edited — ушёл после правки; draft_rejected — отклонён; shadow —
 * записал, что ответил бы (режим «Наблюдает»); handoff — передал человеку;
 * yielded — уступил человеку, который начал отвечать; blocked — задержал
 * ответ с внутренними данными; error — не смог ответить; skipped_old —
 * пропустил старое сообщение.
 */
export type ActivityKind =
  | 'auto' | 'draft' | 'draft_sent' | 'draft_edited' | 'draft_rejected' | 'shadow'
  | 'handoff' | 'yielded' | 'blocked' | 'error' | 'skipped_old';

/** Почему помощник не ответил сам — код; слова рисует панель. */
export type ActivityReason =
  | 'pause' | 'mode' | 'sensitive' | 'low_confidence' | 'no_kb' | 'asked_human' | 'tone' | 'important'
  | 'hold' | 'waiting_human' | 'limit' | 'window' | 'clarify_again' | 'internal_data' | 'error' | 'other';

/** Причины «Это неверно» (6.1, 6.7). */
export type FeedbackReason = 'fact' | 'tone' | 'topic' | 'no_kb';

export interface ActivityItem {
  /** Уникален в ленте: `s<id>` — по черновику, `e<id>` — по событию. */
  id: string;
  at: number;
  kind: ActivityKind;
  conversation_id: number;
  name: string;
  /** Начало ответа помощника (до 200 знаков) — для auto и черновиков. */
  text: string | null;
  reason: ActivityReason | null;
  /** Причина отказа от черновика («Не подходит»), как её выбрал человек. */
  reject_reason: string | null;
  /** Сообщение помощника клиенту — на него ставится «Это неверно». */
  message_id: number | null;
  suggestion_id: number | null;
  /** На этом ответе уже стоит «Это неверно». */
  wrong: boolean;
}

export interface ActivityTotals {
  auto: number;
  drafts: number;
  draftsSent: number;
  draftsEdited: number;
  draftsRejected: number;
  handoffs: number;
}

export interface ActivityResponse {
  items: ActivityItem[];
  /** Курсор следующей страницы (`before`) — время последней строки; null — дальше пусто. */
  next: number | null;
  /** Итоги за весь период [since, сейчас), а не только по странице. */
  totals: ActivityTotals;
  since: number;
}

export interface FeedbackResponse {
  ok: true;
  message_id: number;
}
