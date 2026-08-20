import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';

export type Channel = 'tg_dm' | 'bedolaga';
export type Direction = 'in' | 'out' | 'note';
export type Author = 'client' | 'agent' | 'ai' | 'system';
export type SuggestionStatus = 'pending' | 'sent' | 'edited' | 'rejected' | 'superseded';

export interface Conversation {
  id: number;
  channel: Channel;
  external_id: string;
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
  last_ai_at: number | null;
  handoff_at: number | null;
  handoff_notified_at: number | null;
  unread: number;
  created_at: number;
  updated_at: number;
}

/** Вложение в том виде, в каком его показывает панель. */
export interface Attachment {
  id: number;
  media_type: string | null;
  width: number | null;
  height: number | null;
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
  suggestion_id: number | null;
  reply_to_external_id: string | null;
  reply_excerpt: string | null;
  created_at: number;
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
  tgUserId?: number;
  businessConnectionId?: string;
  username?: string;
  displayName?: string;
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
  if (conv.channel !== 'tg_dm') return { applies: false, open: true, msLeft: Infinity };
  if (!conv.last_inbound_at) return { applies: true, open: false, msLeft: 0 };
  const msLeft = conv.last_inbound_at + REPLY_WINDOW_MS - now;
  return { applies: true, open: msLeft > 0, msLeft: Math.max(0, msLeft) };
}

export type StoreEvents = {
  message: [{ conversation: Conversation; message: Message; backfill: boolean }];
  suggestion: [{ conversation: Conversation; suggestion: Suggestion }];
  conversation: [Conversation];
};

export class Store extends EventEmitter<StoreEvents> {
  constructor(readonly db: Database.Database) {
    super();
  }

  // --- диалоги ---------------------------------------------------------

  getConversation(id: number): Conversation | undefined {
    return this.db.prepare('SELECT * FROM conversation WHERE id = ?').get(id) as Conversation | undefined;
  }

  findConversation(channel: Channel, externalId: string): Conversation | undefined {
    return this.db
      .prepare('SELECT * FROM conversation WHERE channel = ? AND external_id = ?')
      .get(channel, externalId) as Conversation | undefined;
  }

  listConversations(limit = 200): Conversation[] {
    return this.db
      .prepare(
        `SELECT * FROM conversation
          ORDER BY suspicious DESC, escalated DESC, COALESCE(last_message_at, created_at) DESC
          LIMIT ?`,
      )
      .all(limit) as Conversation[];
  }

  listMessages(conversationId: number, limit = 200): Message[] {
    return this.db
      .prepare('SELECT * FROM message WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
      .all(conversationId, limit)
      .reverse() as Message[];
  }

  upsertConversation(input: {
    channel: Channel;
    externalId: string;
    tgUserId?: number;
    businessConnectionId?: string;
    username?: string;
    displayName?: string;
    subject?: string;
  }): Conversation {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO conversation
           (channel, external_id, tg_user_id, business_connection_id, username, display_name, subject, ai_mode, created_at, updated_at)
         VALUES (@channel, @externalId, @tgUserId, @businessConnectionId, @username, @displayName, @subject, 'inherit', @now, @now)
         ON CONFLICT (channel, external_id) DO UPDATE SET
           tg_user_id             = COALESCE(excluded.tg_user_id, conversation.tg_user_id),
           business_connection_id = COALESCE(excluded.business_connection_id, conversation.business_connection_id),
           username               = COALESCE(excluded.username, conversation.username),
           display_name           = COALESCE(excluded.display_name, conversation.display_name),
           subject                = COALESCE(excluded.subject, conversation.subject),
           updated_at             = @now`,
      )
      .run({
        channel: input.channel,
        externalId: input.externalId,
        tgUserId: input.tgUserId ?? null,
        businessConnectionId: input.businessConnectionId ?? null,
        username: input.username ?? null,
        displayName: input.displayName ?? null,
        subject: input.subject ?? null,
        now,
      });
    return this.findConversation(input.channel, input.externalId)!;
  }

  /**
   * Входящее от клиента. Повтор того же external_msg_id игнорируется —
   * защита от ретраев поллинга и переигранных апдейтов Telegram.
   */
  recordInbound(input: InboundMessage): { conversation: Conversation; message: Message } | null {
    const conversation = this.upsertConversation(input);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO message
           (conversation_id, direction, author, text, media_type, media_file_id, external_msg_id,
            reply_to_external_id, reply_excerpt, created_at)
         VALUES (?, 'in', 'client', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        conversation.id,
        input.text ?? null,
        input.mediaType ?? null,
        input.mediaFileId ?? null,
        input.externalMsgId ?? null,
        input.replyToExternalId ?? null,
        input.replyExcerpt ?? null,
        input.sentAt,
      );
    if (result.changes === 0) return null;
    const messageId = Number(result.lastInsertRowid);

    // Вложение регистрируем до рассылки события: подписчики получают кадр
    // синхронно, и если сделать это после, в панель уедет сообщение без
    // картинки — пустой пузырь без единого признака, что там был файл.
    if (input.mediaFileId) {
      const prefix = input.channel === 'bedolaga' ? 'bedolaga' : 'tg';
      this.addAttachment(messageId, input.mediaType, `${prefix}:${input.mediaFileId}`, {
        width: input.mediaWidth,
        height: input.mediaHeight,
      });
    }

    this.db
      .prepare(
        `UPDATE conversation
            SET first_inbound_at = COALESCE(first_inbound_at, ?),
                last_inbound_at = MAX(COALESCE(last_inbound_at, 0), ?),
                last_message_at = MAX(COALESCE(last_message_at, 0), ?),
                unread          = unread + 1,
                resolved_at     = NULL,
                status          = CASE WHEN status IN ('closed','resolved') THEN 'open' ELSE status END,
                updated_at      = ?
          WHERE id = ?`,
      )
      .run(input.sentAt, input.sentAt, input.sentAt, Date.now(), conversation.id);

    // Клиент написал снова — незакрытая предложка устарела.
    this.db
      .prepare(`UPDATE ai_suggestion SET status='superseded', decided_at=? WHERE conversation_id=? AND status='pending'`)
      .run(Date.now(), conversation.id);

    return this.emitMessage(conversation.id, messageId, input.backfill === true);
  }

  /**
   * Исходящее — вызывается уже после успешной отправки.
   * `dedupe` включается для поллинга: наши же ответы возвращаются из API
   * следующим циклом, и без проверки история задвоится. Проверка сделана
   * запросом, а не уникальным индексом: индекс уронил бы запись уже
   * доставленного сообщения, а это худший из возможных отказов.
   */
  recordOutbound(input: {
    conversationId: number;
    author: Author;
    text?: string;
    mediaType?: string;
    mediaFileId?: string;
    externalMsgId?: string;
    suggestionId?: number;
    replyToExternalId?: string;
    replyExcerpt?: string;
    sentAt?: number;
    dedupe?: boolean;
  }): { conversation: Conversation; message: Message } | null {
    if (input.dedupe && input.externalMsgId) {
      const existing = this.db
        .prepare(
          `SELECT id FROM message WHERE conversation_id = ? AND external_msg_id = ? AND direction = 'out'`,
        )
        .get(input.conversationId, input.externalMsgId) as { id: number } | undefined;
      if (existing) return null;
    }

    const at = input.sentAt ?? Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO message
           (conversation_id, direction, author, text, media_type, media_file_id, external_msg_id,
            suggestion_id, reply_to_external_id, reply_excerpt, created_at)
         VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.conversationId,
        input.author,
        input.text ?? null,
        input.mediaType ?? null,
        input.mediaFileId ?? null,
        input.externalMsgId ?? null,
        input.suggestionId ?? null,
        input.replyToExternalId ?? null,
        input.replyExcerpt ?? null,
        at,
      );

    this.db
      .prepare(
        `UPDATE conversation
            SET last_message_at   = MAX(COALESCE(last_message_at, 0), ?),
                first_response_at = COALESCE(first_response_at, ?),
                last_ai_at        = CASE WHEN ? = 'ai' THEN ? ELSE last_ai_at END,
                -- Передачу снимает только человек: ответ самого AI её сохраняет,
                -- иначе напоминание «ожидайте» тут же разблокировало бы модель.
                handoff_at        = CASE WHEN ? = 'agent' THEN NULL ELSE handoff_at END,
                unread            = 0,
                updated_at        = ?
          WHERE id = ?`,
      )
      .run(at, at, input.author, at, input.author, Date.now(), input.conversationId);

    return this.emitMessage(input.conversationId, Number(result.lastInsertRowid));
  }

  addNote(conversationId: number, text: string): { conversation: Conversation; message: Message } {
    const result = this.db
      .prepare(
        `INSERT INTO message (conversation_id, direction, author, text, created_at)
         VALUES (?, 'note', 'agent', ?, ?)`,
      )
      .run(conversationId, text, Date.now());
    return this.emitMessage(conversationId, Number(result.lastInsertRowid))!;
  }

  /**
   * Всё, что клиент написал после нашего последнего ответа, одним текстом.
   * Люди пишут мысль в три-четыре сообщения: «Ау», «ты где», а следом суть.
   * По отдельности это мусор, вместе — обращение.
   */
  pendingInbound(conversationId: number, limit = 12): Message[] {
    const lastOut = this.db
      .prepare(`SELECT MAX(id) AS id FROM message WHERE conversation_id = ? AND direction != 'in'`)
      .get(conversationId) as { id: number | null };
    return this.db
      .prepare(
        `SELECT * FROM message WHERE conversation_id = ? AND direction = 'in' AND id > ?
          ORDER BY id DESC LIMIT ?`,
      )
      .all(conversationId, lastOut.id ?? 0, limit)
      .reverse() as Message[];
  }

  lastInboundMessage(conversationId: number): Message | undefined {
    return this.db
      .prepare(`SELECT * FROM message WHERE conversation_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1`)
      .get(conversationId) as Message | undefined;
  }

  /**
   * Кладёт расшифровку голосового в текст сообщения и переигрывает событие,
   * чтобы AI увидел его уже со словами: до расшифровки текста нет и отвечать
   * не на что.
   */
  attachTranscript(messageId: number, text: string): void {
    const row = this.db.prepare('SELECT conversation_id, text FROM message WHERE id = ?').get(messageId) as
      | { conversation_id: number; text: string | null }
      | undefined;
    if (!row || row.text) return;
    this.db.prepare('UPDATE message SET text = ? WHERE id = ?').run(text, messageId);
    this.emitMessage(row.conversation_id, messageId);
  }

  markRead(conversationId: number): void {
    this.db.prepare('UPDATE conversation SET unread = 0, updated_at = ? WHERE id = ?').run(Date.now(), conversationId);
  }

  setConversationUser(conversationId: number, tgUserId: number, username?: string): void {
    this.db
      .prepare('UPDATE conversation SET tg_user_id = ?, username = COALESCE(?, username), updated_at = ? WHERE id = ?')
      .run(tgUserId, username ?? null, Date.now(), conversationId);
  }

  setAiMode(conversationId: number, mode: 'inherit' | 'off' | 'suggest' | 'auto'): void {
    this.db.prepare('UPDATE conversation SET ai_mode = ?, updated_at = ? WHERE id = ?').run(mode, Date.now(), conversationId);
  }

  setStatus(conversationId: number, status: string): void {
    const resolved = status === 'resolved' || status === 'closed' ? Date.now() : null;
    this.db
      .prepare('UPDATE conversation SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?')
      .run(status, resolved, Date.now(), conversationId);
  }

  /**
   * Диалог передан человеку. Пока метка стоит, AI не отвечает по существу —
   * только напоминает клиенту, что вопрос у специалиста.
   */
  setHandoff(conversationId: number, at: number | null): void {
    this.db
      .prepare('UPDATE conversation SET handoff_at = ?, handoff_notified_at = NULL, updated_at = ? WHERE id = ?')
      .run(at, Date.now(), conversationId);
  }

  markHandoffNotified(conversationId: number): void {
    this.db.prepare('UPDATE conversation SET handoff_notified_at = ? WHERE id = ?').run(Date.now(), conversationId);
  }

  setSuspicious(conversationId: number, suspicious: boolean): void {
    this.db
      .prepare('UPDATE conversation SET suspicious = ?, updated_at = ? WHERE id = ?')
      .run(suspicious ? 1 : 0, Date.now(), conversationId);
  }

  /** Ссылка подписки, которую прислал сам клиент: по ней его можно найти. */
  setSubLink(conversationId: number, link: string): void {
    this.db.prepare('UPDATE conversation SET sub_link = ?, updated_at = ? WHERE id = ?')
      .run(link, Date.now(), conversationId);
  }

  setEscalated(conversationId: number, escalated: boolean, priority?: string): void {
    this.db
      .prepare('UPDATE conversation SET escalated = ?, priority = COALESCE(?, priority), updated_at = ? WHERE id = ?')
      .run(escalated ? 1 : 0, priority ?? null, Date.now(), conversationId);
  }

  /**
   * Диалоги, где клиент ждёт первого ответа дольше указанного срока.
   * Нижняя граница по возрасту обязательна: без неё первая же синхронизация
   * архива тикетов выдала бы пачку уведомлений о переписке месячной давности.
   */
  overdueConversations(minutes: number, maxAgeHours = 24): Conversation[] {
    const now = Date.now();
    const cutoff = now - minutes * 60_000;
    const floor = now - maxAgeHours * 3_600_000;
    // Два повода ждать: клиенту вообще не отвечали, либо AI передал вопрос
    // человеку, а человек ещё не ответил. Второй случай без этого запроса
    // был невидим: «ожидайте» от AI закрывало первый ответ.
    return this.db
      .prepare(
        `SELECT * FROM conversation
          WHERE status NOT IN ('closed','resolved')
            AND (
              (first_response_at IS NULL AND last_inbound_at IS NOT NULL
                 AND last_inbound_at < ? AND last_inbound_at > ?)
              OR
              (handoff_at IS NOT NULL AND handoff_at < ? AND handoff_at > ?
                 AND NOT EXISTS (
                   SELECT 1 FROM message
                    WHERE message.conversation_id = conversation.id
                      AND message.author = 'agent' AND message.direction = 'out'
                      AND message.created_at > conversation.handoff_at))
            )
          ORDER BY COALESCE(handoff_at, last_inbound_at) ASC`,
      )
      .all(cutoff, floor, cutoff, floor) as Conversation[];
  }

  // --- предложения AI --------------------------------------------------

  createSuggestion(input: {
    conversationId: number;
    messageId?: number;
    text: string;
    confidence?: number;
    needsHuman?: boolean;
    reason?: string;
    model?: string;
    sources?: string[];
  }): Suggestion {
    const result = this.db
      .prepare(
        `INSERT INTO ai_suggestion
           (conversation_id, message_id, text, confidence, needs_human, reason, model, sources, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.conversationId,
        input.messageId ?? null,
        input.text,
        input.confidence ?? null,
        input.needsHuman ? 1 : 0,
        input.reason ?? null,
        input.model ?? null,
        input.sources ? JSON.stringify(input.sources) : null,
        Date.now(),
      );
    const suggestion = this.getSuggestion(Number(result.lastInsertRowid))!;
    const conversation = this.getConversation(input.conversationId)!;
    this.emit('suggestion', { conversation, suggestion });
    return suggestion;
  }

  getSuggestion(id: number): Suggestion | undefined {
    return this.db.prepare('SELECT * FROM ai_suggestion WHERE id = ?').get(id) as Suggestion | undefined;
  }

  pendingSuggestion(conversationId: number): Suggestion | undefined {
    return this.db
      .prepare(`SELECT * FROM ai_suggestion WHERE conversation_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`)
      .get(conversationId) as Suggestion | undefined;
  }

  decideSuggestion(id: number, status: SuggestionStatus): void {
    this.db.prepare('UPDATE ai_suggestion SET status = ?, decided_at = ? WHERE id = ?').run(status, Date.now(), id);
  }

  aiRepliesSince(conversationId: number, since: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM message WHERE conversation_id = ? AND author = 'ai' AND created_at > ?`)
      .get(conversationId, since) as { n: number };
    return row.n;
  }

  lastHumanReplyAt(conversationId: number): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(created_at) AS at FROM message
          WHERE conversation_id = ? AND author = 'agent' AND direction IN ('out','note')`,
      )
      .get(conversationId) as { at: number | null };
    return row.at;
  }

  // --- добыча знаний из переписки ---------------------------------------

  /**
   * Диалоги, где база знаний подвела: предложку отклонили или переписали.
   * Это самая ценная выборка — рядом лежит правильный ответ человека.
   */
  gapConversations(limit = 100): number[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT conversation_id FROM ai_suggestion
            WHERE status IN ('rejected','edited')
            ORDER BY conversation_id DESC LIMIT ?`,
        )
        .all(limit) as { conversation_id: number }[]
    ).map((row) => row.conversation_id);
  }

  /** Диалоги, где человек вообще что-то отвечал. */
  answeredConversations(limit = 200): number[] {
    return (
      this.db
        .prepare(
          `SELECT conversation_id, MAX(created_at) AS last
             FROM message WHERE direction = 'out' AND author = 'agent'
            GROUP BY conversation_id ORDER BY last DESC LIMIT ?`,
        )
        .all(limit) as { conversation_id: number }[]
    ).map((row) => row.conversation_id);
  }

  /**
   * Пары «вопрос клиента → ответ человека». Берём последнее входящее перед
   * ответом: промежуточные уточнения только зашумляют статью.
   */
  exchanges(conversationIds: number[]): { conversationId: number; subject: string | null; question: string; answer: string }[] {
    const found: { conversationId: number; subject: string | null; question: string; answer: string }[] = [];

    for (const id of conversationIds) {
      const conversation = this.getConversation(id);
      if (!conversation) continue;
      const messages = this.listMessages(id, 100);

      let question: string | null = null;
      for (const message of messages) {
        if (message.direction === 'in' && message.text?.trim()) {
          question = message.text.trim();
          continue;
        }
        if (message.direction === 'out' && message.author === 'agent' && message.text?.trim() && question) {
          const answer = message.text.trim();
          // Односложные «ок» и «принял» ничему не учат.
          if (answer.length >= 40 && question.length >= 10) {
            found.push({ conversationId: id, subject: conversation.subject, question, answer });
          }
          question = null;
        }
      }
    }
    return found;
  }

  // --- база знаний -----------------------------------------------------

  /** Полная замена документов источника: правки и удаления доезжают сами. */
  syncKb(source: string, docs: { extId: string; title: string; body: string }[]): number {
    const now = Date.now();
    const replace = this.db.transaction(() => {
      this.db.prepare('DELETE FROM kb_doc WHERE source = ?').run(source);
      const insert = this.db.prepare(
        'INSERT INTO kb_doc (source, ext_id, title, body, updated_at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const doc of docs) insert.run(source, doc.extId, doc.title, doc.body, now);
      this.db.prepare(`INSERT INTO kb_fts(kb_fts) VALUES('rebuild')`).run();
    });
    replace();
    return docs.length;
  }

  kbCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM kb_doc').get() as { n: number }).n;
  }

  /**
   * Поиск по базе знаний. FTS5 падает на служебных символах запроса,
   * поэтому текст клиента разбирается на слова и склеивается через OR.
   */
  searchKb(query: string, limit = 5): KbHit[] {
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2)
      .slice(0, 12);
    if (!terms.length) return [];
    const expression = terms.map((word) => `"${word.replace(/"/g, '')}"*`).join(' OR ');
    try {
      return this.db
        .prepare(
          `SELECT d.id, d.source, d.title, d.body, bm25(kb_fts) AS score
             FROM kb_fts JOIN kb_doc d ON d.id = kb_fts.rowid
            WHERE kb_fts MATCH ?
            ORDER BY score LIMIT ?`,
        )
        .all(expression, limit) as KbHit[];
    } catch {
      return [];
    }
  }

  // --- шаблоны ---------------------------------------------------------

  listTemplates(): Template[] {
    return this.db.prepare('SELECT * FROM template ORDER BY uses DESC, shortcut').all() as Template[];
  }

  upsertTemplate(shortcut: string, title: string, body: string): void {
    this.db
      .prepare(
        `INSERT INTO template (shortcut, title, body, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (shortcut) DO UPDATE SET title = excluded.title, body = excluded.body`,
      )
      .run(shortcut, title, body, Date.now());
  }

  deleteTemplate(id: number): void {
    this.db.prepare('DELETE FROM template WHERE id = ?').run(id);
  }

  bumpTemplate(shortcut: string): void {
    this.db.prepare('UPDATE template SET uses = uses + 1 WHERE shortcut = ?').run(shortcut);
  }

  // --- вложения --------------------------------------------------------

  addAttachment(
    messageId: number,
    mediaType: string | undefined,
    fileRef: string,
    size?: { width?: number; height?: number },
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO attachment (message_id, media_type, file_ref, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(messageId, mediaType ?? null, fileRef, size?.width ?? null, size?.height ?? null, Date.now());
    return Number(result.lastInsertRowid);
  }

  markAttachmentDownloaded(id: number, localPath: string, bytes: number): void {
    this.db
      .prepare('UPDATE attachment SET local_path = ?, bytes = ?, downloaded_at = ? WHERE id = ?')
      .run(localPath, bytes, Date.now(), id);
  }

  mediaBytes(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM attachment').get() as { n: number };
    return Number(row.n) || 0;
  }

  /**
   * Невыкачанные вложения. Ссылки Telegram живут около часа, поэтому вечно
   * ретраить бессмысленно — после нескольких неудач вложение бросаем,
   * иначе очередь будет молотить одни и те же мёртвые file_id каждые 15 секунд.
   */
  pendingAttachments(limit = 20, maxAttempts = 5): { id: number; message_id: number; media_type: string | null; file_ref: string }[] {
    return this.db
      .prepare('SELECT id, message_id, media_type, file_ref FROM attachment WHERE local_path IS NULL AND attempts < ? LIMIT ?')
      .all(maxAttempts, limit) as { id: number; message_id: number; media_type: string | null; file_ref: string }[];
  }

  bumpAttachmentAttempt(id: number): void {
    this.db.prepare('UPDATE attachment SET attempts = attempts + 1 WHERE id = ?').run(id);
  }

  getAttachment(id: number): { id: number; local_path: string | null; media_type: string | null } | undefined {
    return this.db.prepare('SELECT id, local_path, media_type FROM attachment WHERE id = ?').get(id) as
      | { id: number; local_path: string | null; media_type: string | null }
      | undefined;
  }

  attachmentsFor(messageIds: number[]): Record<number, Attachment[]> {
    if (!messageIds.length) return {};
    const rows = this.db
      .prepare(
        `SELECT id, message_id, media_type, width, height
           FROM attachment WHERE message_id IN (${messageIds.map(() => '?').join(',')})`,
      )
      .all(...messageIds) as (Attachment & { message_id: number })[];
    const grouped: Record<number, Attachment[]> = {};
    for (const row of rows) {
      (grouped[row.message_id] ??= []).push({
        id: row.id, media_type: row.media_type, width: row.width, height: row.height,
      });
    }
    return grouped;
  }

  // --- служебное -------------------------------------------------------

  getSetting(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return undefined;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  /**
   * Псевдонимы узлов: внутреннее имя из Remnawave → имя для модели и клиента.
   * Внутренние названия несут адреса и хостнеймы, поэтому оператор закрывает
   * их понятными ярлыками, а модель видит только их.
   */
  nodeAliases(): Record<string, string> {
    const raw = this.getSetting('nodeAliases');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
  }

  setNodeAlias(name: string, alias: string): void {
    const map = this.nodeAliases();
    const clean = alias.trim();
    if (clean) map[name] = clean;
    else delete map[name];
    this.setSetting('nodeAliases', map);
  }

  // --- фоновые задачи ---------------------------------------------------

  startJob(kind: string): number {
    // Две одинаковые задачи разом не нужны: майнинг тратит дневной лимит.
    const running = this.db
      .prepare(`SELECT id FROM job WHERE kind = ? AND status = 'running'`)
      .get(kind) as { id: number } | undefined;
    if (running) return -running.id;
    const result = this.db
      .prepare(`INSERT INTO job (kind, started_at) VALUES (?, ?)`)
      .run(kind, Date.now());
    return Number(result.lastInsertRowid);
  }

  updateJob(id: number, progress: string): void {
    this.db.prepare('UPDATE job SET progress = ? WHERE id = ?').run(progress, id);
  }

  finishJob(id: number, result?: unknown, error?: string): void {
    this.db
      .prepare(`UPDATE job SET status = ?, result = ?, error = ?, ended_at = ? WHERE id = ?`)
      .run(error ? 'failed' : 'done', result ? JSON.stringify(result) : null, error ?? null, Date.now(), id);
  }

  latestJob(kind: string): Record<string, unknown> | undefined {
    return this.db
      .prepare('SELECT * FROM job WHERE kind = ? ORDER BY id DESC LIMIT 1')
      .get(kind) as Record<string, unknown> | undefined;
  }

  getState(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM poll_state WHERE key = ?').get(key) as { value: string } | undefined)
      ?.value;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO poll_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  saveCustomer(tgUserId: number, snapshot: unknown, profile?: { username?: string; firstName?: string }): void {
    this.db
      .prepare(
        `INSERT INTO customer (tg_user_id, username, first_name, snapshot, snapshot_at, updated_at)
         VALUES (@id, @username, @firstName, @snapshot, @now, @now)
         ON CONFLICT (tg_user_id) DO UPDATE SET
           username    = COALESCE(excluded.username, customer.username),
           first_name  = COALESCE(excluded.first_name, customer.first_name),
           snapshot    = excluded.snapshot,
           snapshot_at = excluded.snapshot_at,
           updated_at  = excluded.updated_at`,
      )
      .run({
        id: tgUserId,
        username: profile?.username ?? null,
        firstName: profile?.firstName ?? null,
        snapshot: snapshot === undefined ? null : JSON.stringify(snapshot),
        now: Date.now(),
      });
  }

  getCustomer(tgUserId: number): { snapshot: unknown; snapshot_at: number | null } | undefined {
    const row = this.db.prepare('SELECT snapshot, snapshot_at FROM customer WHERE tg_user_id = ?').get(tgUserId) as
      | { snapshot: string | null; snapshot_at: number | null }
      | undefined;
    if (!row) return undefined;
    // Снимок пишем сами через JSON.stringify, но повреждённая строка в базе
    // не должна ронять карточку: как и в getSetting, битый JSON — это «нет
    // данных», а не исключение наружу.
    let snapshot: unknown = null;
    if (row.snapshot) {
      try {
        snapshot = JSON.parse(row.snapshot);
      } catch {
        snapshot = null;
      }
    }
    return { snapshot, snapshot_at: row.snapshot_at };
  }

  saveBusinessConnection(input: {
    id: string;
    userId: number;
    userChatId?: number;
    isEnabled: boolean;
    rights?: unknown;
    connectedAt?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO business_connection (id, user_id, user_chat_id, is_enabled, rights, connected_at, updated_at)
         VALUES (@id, @userId, @userChatId, @isEnabled, @rights, @connectedAt, @now)
         ON CONFLICT (id) DO UPDATE SET
           is_enabled = excluded.is_enabled,
           rights     = excluded.rights,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: input.id,
        userId: input.userId,
        userChatId: input.userChatId ?? null,
        isEnabled: input.isEnabled ? 1 : 0,
        rights: input.rights ? JSON.stringify(input.rights) : null,
        connectedAt: input.connectedAt ?? Date.now(),
        now: Date.now(),
      });
  }

  /**
   * Любой известный id бизнес-подключения из диалогов. Апдейт
   * business_connection прилетает один раз — в момент подключения бота,
   * и если процесс тогда не работал, в таблице пусто. Зато id приезжает
   * с каждым входящим, и по нему подключение можно дотянуть из Telegram.
   */
  anyBusinessConnectionId(): string | undefined {
    return (
      this.db
        .prepare(
          `SELECT business_connection_id AS id FROM conversation
            WHERE business_connection_id IS NOT NULL
            ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 1`,
        )
        .get() as { id: string } | undefined
    )?.id;
  }

  activeBusinessConnectionId(): string | undefined {
    return (
      this.db
        .prepare('SELECT id FROM business_connection WHERE is_enabled = 1 ORDER BY updated_at DESC LIMIT 1')
        .get() as { id: string } | undefined
    )?.id;
  }

  /** Диалоги без единого ответа — для сводки в уведомлениях. */
  waitingCount(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM conversation
            WHERE first_response_at IS NULL AND last_inbound_at IS NOT NULL
              AND status NOT IN ('closed','resolved')`,
        )
        .get() as { n: number }
    ).n;
  }

  businessOwnerChatId(): number | undefined {
    return (
      this.db
        .prepare('SELECT user_chat_id AS id FROM business_connection WHERE user_chat_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1')
        .get() as { id: number } | undefined
    )?.id;
  }

  logEvent(kind: string, conversationId: number | null, payload?: unknown): void {
    this.db
      .prepare('INSERT INTO event (kind, conversation_id, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(kind, conversationId, payload ? JSON.stringify(payload) : null, Date.now());
  }

  // --- статистика ------------------------------------------------------

  /**
   * Сводка за период. Считаем в одном месте, потому что половина метрик
   * связана: доля автоответов бессмысленна без объёма, а среднее время
   * первого ответа врёт без медианы — один забытый на ночь диалог утягивает
   * среднее так, что цифра перестаёт что-либо значить.
   */
  stats(days = 14) {
    const since = Date.now() - days * 86_400_000;
    const one = <T>(sql: string, ...params: unknown[]): T => this.db.prepare(sql).get(...(params as [])) as T;
    const all = <T>(sql: string, ...params: unknown[]): T[] => this.db.prepare(sql).all(...(params as [])) as T[];

    const totals = one<{ total: number; open: number; escalated: number; suspicious: number; waiting: number; handoff: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status NOT IN ('closed','resolved') THEN 1 ELSE 0 END) AS open,
              SUM(escalated) AS escalated,
              SUM(suspicious) AS suspicious,
              SUM(CASE WHEN first_response_at IS NULL AND last_inbound_at IS NOT NULL THEN 1 ELSE 0 END) AS waiting,
              SUM(CASE WHEN handoff_at IS NOT NULL THEN 1 ELSE 0 END) AS handoff
         FROM conversation`,
    );

    // Медиана устойчивее среднего: считаем её по всем отвеченным диалогам.
    const responseTimes = all<{ ms: number }>(
      `SELECT (first_response_at - first_inbound_at) AS ms FROM conversation
        WHERE first_response_at IS NOT NULL AND first_inbound_at IS NOT NULL
          AND first_response_at >= first_inbound_at AND created_at > ?
        ORDER BY ms`,
      since,
    ).map((row) => row.ms);
    const median = responseTimes.length
      ? responseTimes[Math.floor(responseTimes.length / 2)]!
      : null;
    const average = responseTimes.length
      ? Math.round(responseTimes.reduce((sum, ms) => sum + ms, 0) / responseTimes.length)
      : null;

    const byChannel = all<{ channel: string; n: number }>(
      `SELECT channel, COUNT(*) AS n FROM conversation GROUP BY channel`,
    );

    const suggestions = all<{ status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM ai_suggestion WHERE created_at > ? GROUP BY status`,
      since,
    );

    const volume = all<{ day: string; incoming: number; outgoing: number; byAi: number }>(
      `SELECT DATE(created_at / 1000, 'unixepoch') AS day,
              SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS incoming,
              SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS outgoing,
              SUM(CASE WHEN direction = 'out' AND author = 'ai' THEN 1 ELSE 0 END) AS byAi
         FROM message WHERE created_at > ? GROUP BY day ORDER BY day`,
      since,
    );

    // Часы суток: показывает, когда обращения приходят, а когда можно спать.
    const hours = all<{ hour: string; n: number }>(
      `SELECT STRFTIME('%H', created_at / 1000, 'unixepoch') AS hour, COUNT(*) AS n
         FROM message WHERE direction = 'in' AND created_at > ? GROUP BY hour ORDER BY hour`,
      since,
    );

    const events = all<{ kind: string; n: number }>(
      `SELECT kind, COUNT(*) AS n FROM event WHERE created_at > ? GROUP BY kind ORDER BY n DESC LIMIT 8`,
      since,
    );

    // Какие статьи базы знаний реально работают: по ним видно, что дописать.
    const sourceCount = new Map<string, number>();
    for (const row of all<{ sources: string | null }>(
      `SELECT sources FROM ai_suggestion WHERE sources IS NOT NULL AND created_at > ?`, since,
    )) {
      try {
        for (const title of JSON.parse(row.sources ?? '[]') as string[]) {
          sourceCount.set(title, (sourceCount.get(title) ?? 0) + 1);
        }
      } catch { /* повреждённую запись пропускаем */ }
    }
    const topSources = [...sourceCount.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([title, n]) => ({ title, n }));

    const accepted = suggestions.filter((r) => r.status === 'sent' || r.status === 'edited').reduce((s2, r) => s2 + r.n, 0);
    const decided = suggestions.filter((r) => r.status !== 'pending').reduce((s2, r) => s2 + r.n, 0);
    const outgoing = volume.reduce((s2, v) => s2 + v.outgoing, 0);
    const byAi = volume.reduce((s2, v) => s2 + v.byAi, 0);

    return {
      days,
      totals,
      avgFirstResponseMs: average,
      medianFirstResponseMs: median,
      answered: responseTimes.length,
      byChannel,
      suggestions,
      acceptanceRate: decided ? accepted / decided : null,
      aiShare: outgoing ? byAi / outgoing : null,
      volume,
      hours,
      events,
      topSources,
      kb: this.kbCount(),
    };
  }

  private emitMessage(conversationId: number, messageId: number, backfill = false) {
    const conversation = this.getConversation(conversationId)!;
    const message = this.db.prepare('SELECT * FROM message WHERE id = ?').get(messageId) as Message;
    this.emit('message', { conversation, message, backfill });
    return { conversation, message };
  }
}
