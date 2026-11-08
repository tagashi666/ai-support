import type { Store } from '../store.js';
import type { Channel, Conversation, SourceAccount } from './types.js';
import { CHANNEL_IDS, CHANNELS } from '../channels.js';

// Идентификаторы каналов — константы справочника, не ввод: можно вставить в SQL.
const TELEGRAM_CHANNELS_SQL = CHANNEL_IDS.filter((id) => CHANNELS[id].telegram).map((id) => `'${id}'`).join(',');

/** Диалоги: карточка, флаги, профиль клиента, SLA. */
export class ConversationRepo {
  getConversation(this: Store, id: number): Conversation | undefined {
    return this.db.prepare('SELECT * FROM conversation WHERE id = ?').get(id) as Conversation | undefined;
  }

  findConversation(this: Store, channel: Channel, externalId: string, sourceId?: string): Conversation | undefined {
    if (sourceId) {
      const found = this.db
        .prepare('SELECT * FROM conversation WHERE channel = ? AND source_id = ? AND remote_external_id = ?')
        .get(channel, sourceId, externalId) as Conversation | undefined;
      if (found) return found;
    }
    return this.db
      .prepare('SELECT * FROM conversation WHERE channel = ? AND external_id = ?')
      .get(channel, externalId) as Conversation | undefined;
  }

  listConversations(this: Store, limit = 200): Conversation[] {
    return this.db
      .prepare(
        `SELECT * FROM conversation
          WHERE hidden_at IS NULL
            AND EXISTS (SELECT 1 FROM message WHERE message.conversation_id = conversation.id)
          ORDER BY suspicious DESC, escalated DESC, COALESCE(last_message_at, created_at) DESC
          LIMIT ?`,
      )
      .all(limit) as Conversation[];
  }

  /** Полный список одного транспорта нужен для редких repair/backfill-задач. */
  listConversationsByChannel(this: Store, channel: Channel): Conversation[] {
    return this.db
      .prepare(
        `SELECT * FROM conversation
          WHERE channel = ?
          ORDER BY id`,
      )
      .all(channel) as Conversation[];
  }

  /** Скрывает карточку, не удаляя историю. Новое входящее вернёт её само. */
  hideConversation(this: Store, conversationId: number): Conversation | undefined {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return undefined;
    this.db.prepare('UPDATE conversation SET hidden_at = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?')
      .run(Date.now(), Date.now(), conversationId);
    this.emit('conversation_deleted', conversation);
    return this.getConversation(conversationId);
  }

  /**
   * Telegram-профили, которым не хватает имени или аватарки. Legacy Business
   * использовал общий avatar_source_id, поэтому выбираем и по нему: после
   * обновления карточки должны восстановиться без нового сообщения клиента.
   */
  telegramProfilesForRefresh(this: Store, sourceId: string, limit = 200): Conversation[] {
    return this.db.prepare(
      `SELECT * FROM conversation
        WHERE channel IN (${TELEGRAM_CHANNELS_SQL})
          AND tg_user_id IS NOT NULL
          AND (source_id = ? OR avatar_source_id = ?)
          AND (avatar_file_id IS NULL OR avatar_file_id = ''
               OR username IS NULL OR username = ''
               OR display_name IS NULL OR display_name = '')
        ORDER BY COALESCE(last_message_at, created_at) DESC
        LIMIT ?`,
    ).all(sourceId, sourceId, limit) as Conversation[];
  }

  upsertConversation(this: Store, input: {
    channel: Channel;
    externalId: string;
    sourceId?: string;
    sourceName?: string;
    sourceKind?: SourceAccount['kind'];
    avatarSourceId?: string;
    tgUserId?: number;
    businessConnectionId?: string;
    username?: string;
    displayName?: string;
    subject?: string;
    avatarFileId?: string;
  }): Conversation {
    const now = Date.now();
    const defaultSource = CHANNELS[input.channel].defaultSource;
    const sourceId = input.sourceId ?? defaultSource.id;
    this.syncSource({
      id: sourceId,
      kind: input.sourceKind ?? defaultSource.kind,
      name: input.sourceName ?? sourceId,
    });
    const sourceKey = `${sourceId}:${input.externalId}`;
    const legacy = this.findConversation(input.channel, input.externalId);
    const reusableLegacy = legacy && (
      !legacy.source_id
      || (legacy.source_id === 'telegram-business:legacy' && input.channel === 'tg_dm')
      || (legacy.source_id === 'telegram-default' && sourceId === 'telegram-default')
      || (legacy.source_id === 'bedolaga-default' && sourceId === 'bedolaga-default')
      || (legacy.source_id === 'minishop-default' && sourceId === 'minishop-default')
    );
    const externalId = this.findConversation(input.channel, input.externalId, sourceId)?.external_id
      ?? (reusableLegacy ? legacy.external_id : sourceKey);
    this.db
      .prepare(
        `INSERT INTO conversation
           (channel, external_id, remote_external_id, source_id, avatar_source_id,
            tg_user_id, business_connection_id, username, display_name, subject,
            avatar_file_id, ai_mode, created_at, updated_at)
         VALUES (@channel, @externalId, @remoteExternalId, @sourceId, @avatarSourceId,
                 @tgUserId, @businessConnectionId, @username, @displayName, @subject,
                 @avatarFileId, 'inherit', @now, @now)
         ON CONFLICT (channel, external_id) DO UPDATE SET
           remote_external_id     = excluded.remote_external_id,
           source_id              = excluded.source_id,
           avatar_source_id       = COALESCE(excluded.avatar_source_id, conversation.avatar_source_id),
           tg_user_id             = COALESCE(excluded.tg_user_id, conversation.tg_user_id),
           business_connection_id = COALESCE(excluded.business_connection_id, conversation.business_connection_id),
           username               = COALESCE(excluded.username, conversation.username),
           display_name           = COALESCE(excluded.display_name, conversation.display_name),
           subject                = COALESCE(excluded.subject, conversation.subject),
           avatar_file_id         = COALESCE(excluded.avatar_file_id, conversation.avatar_file_id),
           updated_at             = @now`,
      )
      .run({
        channel: input.channel,
        externalId,
        remoteExternalId: input.externalId,
        sourceId,
        avatarSourceId: input.avatarSourceId ?? sourceId,
        tgUserId: input.tgUserId ?? null,
        businessConnectionId: input.businessConnectionId ?? null,
        username: input.username ?? null,
        displayName: input.displayName ?? null,
        subject: input.subject ?? null,
        avatarFileId: input.avatarFileId ?? null,
        now,
      });
    const conversation = this.findConversation(input.channel, input.externalId, sourceId)
      ?? this.findConversation(input.channel, externalId)!;
    this.db.prepare('INSERT OR IGNORE INTO conversation_source (conversation_id, source_id) VALUES (?, ?)')
      .run(conversation.id, sourceId);
    // При первом живом update после миграции старый общий источник заменяется
    // конкретным Business-аккаунтом. Иначе один диалог оставался сразу в
    // legacy-папке и в новой папке, что выглядело как дубликат.
    if (reusableLegacy && legacy.source_id && legacy.source_id !== sourceId) {
      this.db.prepare('DELETE FROM conversation_source WHERE conversation_id = ? AND source_id = ?')
        .run(conversation.id, legacy.source_id);
    }
    return conversation;
  }

  markRead(this: Store, conversationId: number): void {
    const result = this.db.prepare('UPDATE conversation SET unread = 0, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND unread != 0')
      .run(Date.now(), conversationId);
    if (result.changes) {
      const conversation = this.getConversation(conversationId);
      if (conversation) this.emit('conversation', conversation);
    }
  }

  /**
   * Оператор начал печатать, явно взял диалог или отправляет ответ. Метка
   * ставится синхронно, поэтому медленный внешний API не оставляет AI окно
   * для параллельного ответа. Простой просмотр диалога её не выставляет.
   */
  markOperatorActive(this: Store, conversationId: number, at = Date.now()): void {
    this.db
      .prepare('UPDATE conversation SET operator_active_at = ?, updated_at = ? WHERE id = ?')
      .run(at, at, conversationId);
  }

  operatorIsActive(this: Store, conversationId: number, withinMs = 45_000, now = Date.now()): boolean {
    const row = this.db
      .prepare('SELECT operator_active_at AS at FROM conversation WHERE id = ?')
      .get(conversationId) as { at: number | null } | undefined;
    return !!row?.at && now - row.at <= withinMs;
  }

  setConversationUser(this: Store, conversationId: number, tgUserId: number, username?: string): void {
    this.db
      .prepare('UPDATE conversation SET tg_user_id = ?, username = COALESCE(?, username), updated_at = ? WHERE id = ?')
      .run(tgUserId, username ?? null, Date.now(), conversationId);
  }

  /** Обновляет карточку только данными её реального Telegram-собеседника. */
  setTelegramProfile(this: Store, conversationId: number, input: {
    tgUserId: number;
    username?: string;
    displayName?: string;
    avatarFileId?: string;
    avatarSourceId?: string;
  }): boolean {
    const now = Date.now();
    const result = this.db.prepare(
      `UPDATE conversation
          SET username = COALESCE(NULLIF(?, ''), username),
              display_name = COALESCE(NULLIF(?, ''), display_name),
              avatar_file_id = COALESCE(NULLIF(?, ''), avatar_file_id),
              avatar_source_id = COALESCE(NULLIF(?, ''), avatar_source_id),
              updated_at = ?
        WHERE id = ? AND tg_user_id = ?`,
    ).run(
      input.username ?? null,
      input.displayName ?? null,
      input.avatarFileId ?? null,
      input.avatarSourceId ?? null,
      now,
      conversationId,
      input.tgUserId,
    );
    if (result.changes === 0) return false;
    this.db.prepare(
      `UPDATE customer_profile
          SET username = COALESCE(NULLIF(?, ''), username),
              display_name = COALESCE(NULLIF(?, ''), display_name),
              updated_at = ?
        WHERE id = (SELECT customer_profile_id FROM conversation WHERE id = ?)`,
    ).run(input.username ?? null, input.displayName ?? null, now, conversationId);
    const conversation = this.getConversation(conversationId);
    if (conversation) this.emit('conversation', conversation);
    return true;
  }

  setConversationAvatar(this: Store, conversationId: number, fileId: string, sourceId?: string): void {
    this.db
      .prepare('UPDATE conversation SET avatar_file_id = ?, avatar_source_id = COALESCE(?, avatar_source_id), updated_at = ? WHERE id = ?')
      .run(fileId, sourceId ?? null, Date.now(), conversationId);
    const conversation = this.getConversation(conversationId);
    if (conversation) this.emit('conversation', conversation);
  }

  /** Фото у клиента больше нет: панель покажет инициалы вместо битой картинки. */
  clearConversationAvatar(this: Store, conversationId: number): void {
    this.db.prepare('UPDATE conversation SET avatar_file_id = NULL, updated_at = ? WHERE id = ?').run(Date.now(), conversationId);
    const conversation = this.getConversation(conversationId);
    if (conversation) this.emit('conversation', conversation);
  }

  setAiMode(this: Store, conversationId: number, mode: 'inherit' | 'off' | 'shadow' | 'suggest' | 'auto'): void {
    this.db.prepare('UPDATE conversation SET ai_mode = ?, updated_at = ? WHERE id = ?').run(mode, Date.now(), conversationId);
  }

  setStatus(this: Store, conversationId: number, status: string): boolean {
    const before = this.getConversation(conversationId);
    if (!before) return false;
    const isResolved = status === 'resolved' || status === 'closed';
    const resolved = isResolved ? (before.resolved_at ?? Date.now()) : null;
    if (before.status === status && before.resolved_at === resolved) return false;
    this.db
      // Закрытие завершает и передачу человеку: новое обращение после него —
      // новый разговор, а не «ждите специалиста» по старому.
      .prepare(`UPDATE conversation SET status = ?, resolved_at = ?, last_resolved_at = COALESCE(?, last_resolved_at),
                       handoff_at = CASE WHEN ? IS NULL THEN handoff_at ELSE NULL END, updated_at = ? WHERE id = ?`)
      .run(status, resolved, resolved, resolved, Date.now(), conversationId);
    const conversation = this.getConversation(conversationId);
    if (conversation) this.emit('conversation', conversation);
    return true;
  }

  /**
   * Диалог передан человеку. Пока метка стоит, AI не отвечает по существу —
   * только напоминает клиенту, что вопрос у специалиста.
   */
  setHandoff(this: Store, conversationId: number, at: number | null): void {
    this.db
      .prepare('UPDATE conversation SET handoff_at = ?, handoff_notified_at = NULL, updated_at = ? WHERE id = ?')
      .run(at, Date.now(), conversationId);
  }

  markHandoffNotified(this: Store, conversationId: number): void {
    this.db.prepare('UPDATE conversation SET handoff_notified_at = ? WHERE id = ?').run(Date.now(), conversationId);
  }

  setSuspicious(this: Store, conversationId: number, suspicious: boolean): void {
    this.db
      .prepare('UPDATE conversation SET suspicious = ?, updated_at = ? WHERE id = ?')
      .run(suspicious ? 1 : 0, Date.now(), conversationId);
  }

  /** Ссылка подписки, которую прислал сам клиент: по ней его можно найти. */
  setSubLink(this: Store, conversationId: number, link: string): void {
    this.db.prepare('UPDATE conversation SET sub_link = ?, updated_at = ? WHERE id = ?')
      .run(link, Date.now(), conversationId);
  }

  setEscalated(this: Store, conversationId: number, escalated: boolean, priority?: string): void {
    this.db
      .prepare('UPDATE conversation SET escalated = ?, priority = COALESCE(?, priority), updated_at = ? WHERE id = ?')
      .run(escalated ? 1 : 0, priority ?? null, Date.now(), conversationId);
  }

  /**
   * Диалоги, где клиент ждёт первого ответа дольше указанного срока.
   * Нижняя граница по возрасту обязательна: без неё первая же синхронизация
   * архива тикетов выдала бы пачку уведомлений о переписке месячной давности.
   */
  /**
   * Срок первого ответа берётся из sla_policy по приоритету диалога — той же
   * таблицы, что показывает экран SLA. Раньше уведомления жили по отдельному
   * глобальному сроку и расходились с очередью. `overrideMinutes` — для тестов.
   */
  overdueConversations(this: Store, maxAgeHours = 24, overrideMinutes?: number): Conversation[] {
    const now = Date.now();
    const floor = now - maxAgeHours * 3_600_000;
    // Два повода ждать: клиенту вообще не отвечали, либо AI передал вопрос
    // человеку, а человек ещё не ответил. Второй случай без этого запроса
    // был невидим: «ожидайте» от AI закрывало первый ответ.
    return this.db
      .prepare(
        `SELECT c.* FROM conversation c
           LEFT JOIN sla_policy p ON p.priority = c.priority
          WHERE c.status NOT IN ('closed','resolved')
            AND (
              (c.first_response_at IS NULL AND c.last_inbound_at IS NOT NULL
                 AND COALESCE(c.first_inbound_at, c.last_inbound_at) < :now - COALESCE(:override, p.first_response_minutes, 60) * 60000
                 AND COALESCE(c.first_inbound_at, c.last_inbound_at) > :floor)
              OR
              (c.handoff_at IS NOT NULL
                 AND c.handoff_at < :now - COALESCE(:override, p.first_response_minutes, 60) * 60000
                 AND c.handoff_at > :floor
                 AND NOT EXISTS (
                   SELECT 1 FROM message
                    WHERE message.conversation_id = c.id
                      AND message.author = 'agent' AND message.direction = 'out'
                      AND message.created_at > c.handoff_at))
            )
          ORDER BY COALESCE(c.handoff_at, c.last_inbound_at) ASC`,
      )
      .all({ now, floor, override: overrideMinutes ?? null }) as Conversation[];
  }

  /** Однократно переносит прежний глобальный срок в политику «normal». */
  seedSlaFirstResponse(this: Store, minutes: number): void {
    const key = 'sla:policy-seeded';
    if (this.getState(key)) return;
    this.db.prepare(`UPDATE sla_policy SET first_response_minutes = ? WHERE priority = 'normal'`).run(minutes);
    this.setState(key, String(Date.now()));
  }

  /** Диалоги без единого ответа — для сводки в уведомлениях. */
  waitingCount(this: Store): number {
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
}
