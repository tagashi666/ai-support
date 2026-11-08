import type { Store } from '../store.js';
import type { Direction, Author, Conversation, Message, InboundMessage } from './types.js';
import { releaseMediaFiles } from './media-files.js';
import { attachmentFileRef } from '../channels.js';

/** Отдаёт свежие диалог и сообщение слушателям `message`. */
export function emitMessage(store: Store, conversationId: number, messageId: number, backfill = false) {
  const conversation = store.getConversation(conversationId)!;
  const message = store.db.prepare('SELECT * FROM message WHERE id = ?').get(messageId) as Message;
  store.emit('message', { conversation, message, backfill });
  return { conversation, message };
}

/** Сообщения: запись входящих и исходящих, правка и удаление. */
export class MessageRepo {
  listMessages(this: Store, conversationId: number, limit = 200): Message[] {
    return this.db
      .prepare('SELECT * FROM message WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
      .all(conversationId, limit)
      .reverse() as Message[];
  }

  /** Страница истории старше известного клиенту сообщения — подгрузка «ранних». */
  listMessagesBefore(this: Store, conversationId: number, beforeId: number, limit = 100): Message[] {
    return this.db
      .prepare('SELECT * FROM message WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
      .all(conversationId, beforeId, limit)
      .reverse() as Message[];
  }

  /** Только сообщения новее известного клиенту: фоновой синхронизации не нужна вся история. */
  listMessagesAfter(this: Store, conversationId: number, afterId: number, limit = 200): Message[] {
    return this.db
      .prepare('SELECT * FROM message WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT ?')
      .all(conversationId, afterId, limit) as Message[];
  }

  /**
   * Входящее от клиента. Повтор того же external_msg_id игнорируется —
   * защита от ретраев поллинга и переигранных апдейтов Telegram.
   */
  recordInbound(this: Store, input: InboundMessage): { conversation: Conversation; message: Message } | null {
    // Сообщение, вложение и счётчики диалога пишутся одной транзакцией: сбой
    // между ними оставлял сообщение без файла, а повторная доставка того же
    // update отсекается INSERT OR IGNORE — восстановить вложение было нечем.
    const saved = this.db.transaction(() => {
      const conversation = this.upsertConversation(input);
      const backfill = input.backfill === true ? 1 : 0;
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO message
             (conversation_id, direction, author, text, media_type, media_file_id, external_msg_id, sender_tg_user_id,
              reply_to_external_id, reply_excerpt, created_at, is_backfill)
           VALUES (?, 'in', 'client', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          conversation.id,
          input.text ?? null,
          input.mediaType ?? null,
          input.mediaFileId ?? null,
          input.externalMsgId ?? null,
          input.senderTgUserId ?? null,
          input.replyToExternalId ?? null,
          input.replyExcerpt ?? null,
          input.sentAt,
          backfill,
        );
      if (result.changes === 0) return null;
      const messageId = Number(result.lastInsertRowid);

      // Вложение регистрируем до рассылки события: подписчики получают кадр
      // синхронно, и если сделать это после, в панель уедет сообщение без
      // картинки — пустой пузырь без единого признака, что там был файл.
      if (input.mediaFileId) {
        const fileRef = attachmentFileRef(input.channel, input.mediaFileId, input.avatarSourceId ?? input.sourceId);
        this.addAttachment(messageId, input.mediaType, fileRef, {
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
                  unread          = unread + CASE WHEN ? = 1 THEN 0 ELSE 1 END,
                  resolved_at     = CASE WHEN ? = 1 THEN resolved_at ELSE NULL END,
                  status          = CASE WHEN ? = 1 THEN status
                                         ELSE 'open' END,
                  hidden_at       = CASE WHEN ? = 1 THEN hidden_at ELSE NULL END,
                  updated_at      = ?
            WHERE id = ?`,
        )
        .run(input.sentAt, input.sentAt, input.sentAt, backfill, backfill, backfill, backfill, Date.now(), conversation.id);

      // Клиент написал снова — незакрытая предложка устарела.
      if (!backfill) {
        this.db
          .prepare(`UPDATE ai_suggestion SET status='superseded', decided_at=? WHERE conversation_id=? AND status='pending'`)
          .run(Date.now(), conversation.id);
      }

      return { conversationId: conversation.id, messageId };
    })();
    if (!saved) return null;
    return emitMessage(this, saved.conversationId, saved.messageId, input.backfill === true);
  }

  /**
   * Исходящее — вызывается уже после успешной отправки.
   * `dedupe` включается для поллинга: наши же ответы возвращаются из API
   * следующим циклом, и без проверки история задвоится. Проверка сделана
   * запросом, а не уникальным индексом: индекс уронил бы запись уже
   * доставленного сообщения, а это худший из возможных отказов.
   */
  recordOutbound(this: Store, input: {
    conversationId: number;
    author: Author;
    text?: string;
    mediaType?: string;
    mediaFileId?: string;
    mediaWidth?: number;
    mediaHeight?: number;
    /** Источник Telegram, через который можно скачать вложение. */
    mediaSourceId?: string;
    externalMsgId?: string;
    senderTgUserId?: number;
    suggestionId?: number;
    replyToExternalId?: string;
    replyExcerpt?: string;
    sentAt?: number;
    dedupe?: boolean;
    /** Импорт старой истории не должен менять текущее состояние диалога. */
    backfill?: boolean;
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
           (conversation_id, direction, author, text, media_type, media_file_id, external_msg_id, sender_tg_user_id,
            suggestion_id, reply_to_external_id, reply_excerpt, created_at, is_backfill)
         VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.conversationId,
        input.author,
        input.text ?? null,
        input.mediaType ?? null,
        input.mediaFileId ?? null,
        input.externalMsgId ?? null,
        input.senderTgUserId ?? null,
        input.suggestionId ?? null,
        input.replyToExternalId ?? null,
        input.replyExcerpt ?? null,
        at,
        input.backfill === true ? 1 : 0,
      );

    const messageId = Number(result.lastInsertRowid);
    if (input.mediaFileId) {
      const conversation = this.getConversation(input.conversationId);
      const fileRef = attachmentFileRef(conversation?.channel, input.mediaFileId,
        input.mediaSourceId ?? conversation?.avatar_source_id ?? conversation?.source_id);
      this.addAttachment(messageId, input.mediaType, fileRef, {
        width: input.mediaWidth,
        height: input.mediaHeight,
      });
    }

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
                resolved_at       = CASE WHEN ? = 1 THEN resolved_at ELSE NULL END,
                status            = CASE WHEN ? = 1 THEN status ELSE 'pending' END,
                updated_at        = ?
          WHERE id = ?`,
      )
      .run(
        at,
        at,
        input.author,
        at,
        input.author,
        input.backfill === true ? 1 : 0,
        input.backfill === true ? 1 : 0,
        Date.now(),
        input.conversationId,
      );

    // Человек ответил сам — из панели, Telegram Business или админки тикетов.
    // Черновик AI к тому же вопросу устарел; отправляемую предложку решает
    // маршрут ответа (sent/edited).
    if (input.author === 'agent' && input.backfill !== true) {
      this.db
        .prepare(`UPDATE ai_suggestion SET status = 'superseded', decided_at = ?
                   WHERE conversation_id = ? AND status = 'pending' AND id != ?`)
        .run(Date.now(), input.conversationId, input.suggestionId ?? 0);
    }

    return emitMessage(this, input.conversationId, messageId, input.backfill === true);
  }

  /**
   * Исходящее сообщение, отправленное владельцем Telegram Business вне
   * панели. Telegram присылает его тем же `business_message`, что и
   * сообщение клиента, поэтому сначала связываем его с диалогом, а затем
   * записываем как ответ живого оператора. События входящего здесь нет — AI
   * на собственное сообщение поддержки не запустится.
   */
  recordExternalOutbound(this: Store, input: InboundMessage): { conversation: Conversation; message: Message } | null {
    const conversation = this.upsertConversation(input);
    return this.recordOutbound({
      conversationId: conversation.id,
      author: 'agent',
      text: input.text,
      mediaType: input.mediaType,
      mediaFileId: input.mediaFileId,
      mediaWidth: input.mediaWidth,
      mediaHeight: input.mediaHeight,
      mediaSourceId: input.avatarSourceId ?? input.sourceId,
      externalMsgId: input.externalMsgId,
      senderTgUserId: input.senderTgUserId,
      replyToExternalId: input.replyToExternalId,
      replyExcerpt: input.replyExcerpt,
      sentAt: input.sentAt,
      dedupe: true,
    });
  }

  addNote(this: Store, conversationId: number, text: string): { conversation: Conversation; message: Message } {
    const result = this.db
      .prepare(
        `INSERT INTO message (conversation_id, direction, author, text, created_at)
         VALUES (?, 'note', 'agent', ?, ?)`,
      )
      .run(conversationId, text, Date.now());
    return emitMessage(this, conversationId, Number(result.lastInsertRowid))!;
  }

  /**
   * Всё, что клиент написал после нашего последнего ответа, одним текстом.
   * Люди пишут мысль в три-четыре сообщения: «Ау», «ты где», а следом суть.
   * По отдельности это мусор, вместе — обращение.
   */
  pendingInbound(this: Store, conversationId: number, limit = 12): Message[] {
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

  lastInboundMessage(this: Store, conversationId: number): Message | undefined {
    return this.db
      .prepare(`SELECT * FROM message WHERE conversation_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1`)
      .get(conversationId) as Message | undefined;
  }

  /**
   * Кладёт расшифровку голосового в текст сообщения и переигрывает событие,
   * чтобы AI увидел его уже со словами: до расшифровки текста нет и отвечать
   * не на что.
   */
  attachTranscript(this: Store, messageId: number, text: string): void {
    const row = this.db.prepare('SELECT conversation_id, text FROM message WHERE id = ?').get(messageId) as
      | { conversation_id: number; text: string | null }
      | undefined;
    if (!row || row.text) return;
    this.db.prepare('UPDATE message SET text = ? WHERE id = ?').run(text, messageId);
    emitMessage(this, row.conversation_id, messageId);
  }

  findMessageByExternalId(
    this: Store,
    conversationId: number,
    externalMsgId: string,
    direction?: Direction,
  ): Message | undefined {
    return (direction
      ? this.db.prepare('SELECT * FROM message WHERE conversation_id = ? AND external_msg_id = ? AND direction = ?')
        .get(conversationId, externalMsgId, direction)
      : this.db.prepare('SELECT * FROM message WHERE conversation_id = ? AND external_msg_id = ?')
        .get(conversationId, externalMsgId)) as Message | undefined;
  }

  /** Обновляет Telegram-сообщение без повторного запуска AI-конвейера. */
  editExternalMessage(this: Store, input: {
    conversationId: number;
    externalMsgId: string;
    direction: Direction;
    text?: string;
    mediaType?: string;
    mediaFileId?: string;
    mediaWidth?: number;
    mediaHeight?: number;
    mediaSourceId?: string;
    replyToExternalId?: string;
    replyExcerpt?: string;
  }): { conversation: Conversation; message: Message } | null {
    const previous = this.findMessageByExternalId(input.conversationId, input.externalMsgId, input.direction);
    if (!previous) return null;
    const mediaChanged = Boolean(input.mediaFileId && input.mediaFileId !== previous.media_file_id);
    let removedFileRefs: string[] = [];
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE message
            SET text = ?,
                media_type = CASE WHEN ? = 1 THEN ? ELSE media_type END,
                media_file_id = CASE WHEN ? = 1 THEN ? ELSE media_file_id END,
                reply_to_external_id = ?, reply_excerpt = ?
          WHERE id = ?`,
      ).run(
        input.text ?? null,
        mediaChanged ? 1 : 0, input.mediaType ?? null,
        mediaChanged ? 1 : 0, input.mediaFileId ?? null,
        input.replyToExternalId ?? null,
        input.replyExcerpt ?? null,
        previous.id,
      );
      if (mediaChanged) {
        removedFileRefs = (this.db.prepare('SELECT file_ref FROM attachment WHERE message_id = ?')
          .all(previous.id) as Array<{ file_ref: string }>).map((row) => row.file_ref);
        this.db.prepare('DELETE FROM attachment WHERE message_id = ?').run(previous.id);
        const conversation = this.getConversation(input.conversationId);
        const fileRef = attachmentFileRef(conversation?.channel, input.mediaFileId!,
          input.mediaSourceId ?? conversation?.avatar_source_id ?? conversation?.source_id);
        this.addAttachment(previous.id, input.mediaType, fileRef, {
          width: input.mediaWidth, height: input.mediaHeight,
        });
      }
      this.db.prepare('UPDATE conversation SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?')
        .run(Date.now(), input.conversationId);
    })();
    const conversation = this.getConversation(input.conversationId)!;
    const message = this.db.prepare('SELECT * FROM message WHERE id = ?').get(previous.id) as Message;
    this.emit('message_updated', { conversation, message });
    releaseMediaFiles(this.db, removedFileRefs);
    return { conversation, message };
  }

  /** Удаляет сообщения из локальной истории и пересчитывает активность диалога. */
  deleteExternalMessages(this: Store, conversationId: number, externalMsgIds: string[]): number {
    const ids = [...new Set(externalMsgIds.filter(Boolean))];
    if (!ids.length) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const messages = this.db.prepare(
      `SELECT * FROM message WHERE conversation_id = ? AND external_msg_id IN (${placeholders})`,
    ).all(conversationId, ...ids) as Message[];
    if (!messages.length) return 0;
    const conversation = this.getConversation(conversationId);
    if (!conversation) return 0;
    const unread = Number((this.db.prepare('SELECT unread FROM conversation WHERE id = ?').get(conversationId) as { unread: number } | undefined)?.unread ?? 0);
    const unreadIds = unread > 0
      ? new Set((this.db.prepare(`
          SELECT id FROM message
           WHERE conversation_id = ? AND direction = 'in' AND is_backfill = 0
           ORDER BY id DESC LIMIT ?
        `).all(conversationId, unread) as Array<{ id: number }>).map((row) => row.id))
      : new Set<number>();
    const deletedUnread = messages.filter((message) => unreadIds.has(message.id)).length;
    let conversationDeleted = false;
    let removedFileRefs: string[] = [];
    this.db.transaction(() => {
      // Вложения уходят каскадом вместе с сообщениями; их файлы стираем после фиксации.
      removedFileRefs = (this.db.prepare(
        `SELECT file_ref FROM attachment WHERE message_id IN (${messages.map(() => '?').join(',')})`,
      ).all(...messages.map((message) => message.id)) as Array<{ file_ref: string }>).map((row) => row.file_ref);
      this.db.prepare(`DELETE FROM message WHERE id IN (${messages.map(() => '?').join(',')})`)
        .run(...messages.map((message) => message.id));
      // Клиент удалил вопрос — черновик ответа на него больше не нужен.
      this.db.prepare(
        `UPDATE ai_suggestion SET status = 'superseded', decided_at = ?
          WHERE conversation_id = ? AND status = 'pending' AND message_id IN (${messages.map(() => '?').join(',')})`,
      ).run(Date.now(), conversationId, ...messages.map((message) => message.id));
      this.db.prepare(
        `UPDATE conversation
            SET last_message_at = (SELECT MAX(created_at) FROM message WHERE conversation_id = ?),
                last_inbound_at = (SELECT MAX(created_at) FROM message WHERE conversation_id = ? AND direction = 'in'),
                first_inbound_at = (SELECT MIN(created_at) FROM message WHERE conversation_id = ? AND direction = 'in'),
                first_response_at = CASE
                  WHEN EXISTS (SELECT 1 FROM message WHERE conversation_id = ? AND direction = 'in')
                  THEN (SELECT MIN(outbound.created_at) FROM message outbound
                         WHERE outbound.conversation_id = ? AND outbound.direction = 'out'
                           AND outbound.created_at >= (SELECT MIN(inbound.created_at) FROM message inbound
                             WHERE inbound.conversation_id = ? AND inbound.direction = 'in'))
                  ELSE NULL END,
                unread = MAX(0, unread - ?), updated_at = MAX(updated_at + 1, ?)
          WHERE id = ?`,
      ).run(conversationId, conversationId, conversationId,
        conversationId, conversationId, conversationId,
        deletedUnread, Date.now(), conversationId);
      const remaining = this.db.prepare('SELECT 1 FROM message WHERE conversation_id = ? LIMIT 1')
        .get(conversationId);
      if (!remaining) {
        this.db.prepare('DELETE FROM conversation WHERE id = ?').run(conversationId);
        conversationDeleted = true;
      }
    })();
    for (const message of messages) this.emit('message_deleted', { conversation, message });
    if (conversationDeleted) this.emit('conversation_deleted', conversation);
    releaseMediaFiles(this.db, removedFileRefs);
    return messages.length;
  }
}
