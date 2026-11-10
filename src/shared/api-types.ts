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
  /** L-1: клиент написал после того, что видел оператор, — «Решено»/«Убрать» не применены (409). */
  | 'client_wrote'
  | 'locked_by_other'
  | 'no_sender'
  | 'permission'
  | 'rate_limited'
  | 'upstream'
  | 'not_found'
  | 'bad_request'
  | 'unauthorized'
  /** Статью изменили, пока вы правили (10.5 п.5). */
  | 'version_conflict'
  /** Идею уже разобрал другой человек (10.5 п.6). */
  | 'already_decided'
  /** Нет прав на запись в папку знаний (6.6, состояния): текст для человека — в панели. */
  | 'write_denied';

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
  /** ideas — идеи статей на проверке (null без права knowledge:review); problems — неполадки (null без diagnostics:read). */
  counts: { mine: number; waiting: number; ideas: number | null; problems: number | null };
  /** Неполадки для «Нужно внимание» и точки у «Системы» (этап 6); null без права diagnostics:read. */
  problems?: SystemProblem[] | null;
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
  /** Раздел изменился (L-4): панель перечитывает его своим GET, если раздел открыт. Без данных. */
  | { type: 'invalidate'; seq: number; epoch: string; scope: InvalidateScope }
  /** Неполадки изменились (L-3) — только с diagnostics:read, как GET /api/system/problems. */
  | { type: 'problems'; seq: number; epoch: string; problems: SystemProblem[]; at: number }
  /** Кадр, который этому получателю не положен по правам: держит seq без пропуска. */
  | { type: 'noop'; seq: number; epoch: string };

/** Разделы, о смене которых сервер шлёт кадр invalidate. */
export type InvalidateScope = 'kb' | 'templates' | 'ideas' | 'team' | 'roles' | 'nodes' | 'connections';

/** Служебные кадры: seq не увеличивают, но несут текущий — по ним виден пропуск. */
export type ControlFrame =
  | { type: 'hello'; seq: number; epoch: string }
  | { type: 'tick'; at: number; seq: number; epoch: string }
  /** Права, роль или имя получателя изменились (L-5): панель перечитывает bootstrap. Только этому сокету. */
  | { type: 'me' };

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
export interface ThreadIntent { action: 'resolve' | 'hide'; by: { id: string; name: string } }

export type ThreadFrame =
  | { type: 'thread'; kind: 'message' | 'message_updated'; conversation_id: number; message: ThreadMessage }
  | { type: 'thread'; kind: 'message_deleted'; conversation_id: number; message_id: number }
  | { type: 'thread'; kind: 'suggestion'; conversation_id: number; suggestion: ThreadSuggestion | null }
  /** Диалог убран из списка или удалён (10.3 п.7). */
  | { type: 'thread'; kind: 'deleted'; conversation_id: number }
  /** Кто смотрит и печатает (10.6 п.6): весь список присутствия диалога, всем с conversation:read. */
  | { type: 'thread'; kind: 'presence'; conversation_id: number; presence: ThreadPresence[] }
  /** Ваш черновик изменился на другом устройстве (10.6 п.5): только сокетам того же человека. */
  | { type: 'thread'; kind: 'draft'; conversation_id: number; draft: ServerDraft | null }
  /** «Иван просит передать диалог» (10.6 п.8): только сокетам того, кто ведёт. */
  /** L-2: коллега нажал «Решено»/«Убрать», запрос уйдёт после окна отмены; null — отменил или срок вышел. */
  | { type: 'thread'; kind: 'intent'; conversation_id: number; intent: ThreadIntent | null }
  | { type: 'thread'; kind: 'handover_request'; conversation_id: number; from: { id: string; name: string }; customer: string | null };

/** Черновик на сервере (7.8): на человека и диалог. device — вкладка, которая записала. */
export interface ServerDraft {
  text: string;
  mode: 'reply' | 'note';
  quote: { id: number; quote_id: string; excerpt: string } | null;
  from_suggestion: number | null;
  device: string;
  updated_at: number;
}

/** GET/PUT /api/conversations/:id/draft. */
export interface DraftResponse { draft: ServerDraft | null }

/** GET /api/presence: присутствие во всех диалогах, где кто-то есть (мини-аватары в списке). */
export interface PresenceResponse { items: Array<{ conversation_id: number; presence: ThreadPresence[] }> }

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

/** GET /api/assistant/settings — ключи помощника из runtime, без сетевых вызовов. */
export interface AssistantSettingsResponse {
  runtime: {
    aiMode: AiMode; minConfidence: number; requireKb: boolean; humanHoldMinutes: number; maxAgeMinutes: number;
    autoPerHour: number; handoffRepeatMinutes: number; autoLearn: boolean; brand: string; replyStyle: string;
    handoffMessage: string; model: string; fallbackModel: string;
    customerLinks: Array<{ key: string; title: string; url: string; when: string }>;
  };
  ai: { keys: number };
  kb: number;
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
  /**
   * Идея статьи из «как правильно» (этап 5): id кандидата обучения или null,
   * если правильного ответа не прислали или черновик не записался.
   */
  idea_id?: number | null;
}

// --- Знания (этап 5, 10.5) ------------------------------------------------

export type KbArea = 'kb' | 'draft';

export interface KbDoc {
  name: string;
  title: string;
  size: number;
  updatedAt: number;
  excerpt: string;
}

export interface KbListResponse {
  kb: KbDoc[];
  /** Пусто без права knowledge:review. */
  drafts: KbDoc[];
  interfaceScreens: unknown[];
}

export interface KbDocResponse {
  name: string;
  text: string;
  /** Хэш текста: передаётся обратно как expectedVersion. */
  version: string;
  changed_at: number;
}

/** Ответ сохранения, создания и публикации: прежний текст — для «Отменить» (10.5 п.3). */
export interface KbWriteResponse {
  ok: true;
  name: string;
  version: string;
  /** Текст до записи в той же области (для публикации — опубликованный); null — файла не было. */
  previous: string | null;
  /** Публикация: идеи, которые она закрыла (10.5 п.2). */
  closed_ideas?: number[];
}

export interface KbConflict {
  error: string;
  code: 'version_conflict';
  /** Текст и версия на сервере сейчас; text null — файл удалили. */
  text: string | null;
  version: string | null;
  changed_at: number | null;
  /** Имя из журнала действий, если запись не старше файла больше чем на 2 с. */
  changed_by: string | null;
}

export type IdeaSource = 'auto-learn' | 'archive' | 'panel' | 'telegram-export' | 'feedback';
export type IdeaRejectReason = 'wrong' | 'duplicate' | 'too_specific' | 'not_needed';

export interface IdeaRow {
  id: number;
  title: string;
  file_name: string;
  source: string;
  confidence: number | null;
  status: 'pending' | 'approved' | 'rejected';
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

export interface IdeasResponse {
  candidates: IdeaRow[];
}

export interface IdeaDecided {
  error: string;
  code: 'already_decided';
  decision: 'approved' | 'rejected';
  /** Имя того, кто решил; null — не нашли. */
  decided_by: string | null;
}

/**
 * Неполадка системы (этап 6, 6.1 и 6.9). Считается сервером по локальному
 * состоянию, без сетевых вызовов: снимок серверов, журнал обновлений, задачи.
 * error — что-то не работает; warn — стоит проверить.
 */
export type SystemProblemCode = 'nodes_offline' | 'nodes_error' | 'update_failed' | 'job_failed';
export interface SystemProblem {
  code: SystemProblemCode;
  severity: 'error' | 'warn';
  /** Сколько затронуто (серверов, задач). */
  count: number;
  /** Первый затронутый: имя сервера, версия, вид задачи. */
  subject: string | null;
  at: number | null;
}
export interface ProblemsResponse { problems: SystemProblem[]; checkedAt: number }

/** GET /api/team/names (10.6 п.4): имена команды для всех с conversation:read. */
export interface TeamNamesResponse { people: Array<{ id: string; name: string; role: string; online: boolean }> }

/** GET /api/connections (6.11): каналы и источники без сетевых вызовов и без секретов. */
export interface ConnectionsResponse {
  sources: Array<{ id: string; kind: string; name: string; enabled: boolean }>;
  serviceProfiles: Record<string, { sourceId: string; serviceName: string; greetingMessage: string; handoffMessage: string }>;
  businessConnections: Array<{ id: string; name: string | null; username: string | null; enabled: boolean }>;
  remnawave: Array<{ id: string; name: string; readOnly: boolean }>;
  bedolaga: { enabled: boolean; lastPoll: string | null };
  minishop: { enabled: boolean; lastPoll: string | null };
  sourceManagement: { queued: boolean; progress: Record<string, unknown> | null };
}
