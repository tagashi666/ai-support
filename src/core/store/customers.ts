import type { Store } from '../store.js';

/** Снимки клиентов и Telegram Business-подключения. */
export class CustomerRepo {
  saveCustomer(this: Store, tgUserId: number, snapshot: unknown, profile?: { username?: string; firstName?: string }): void {
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

  getCustomer(this: Store, tgUserId: number): { snapshot: unknown; snapshot_at: number | null } | undefined {
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

  saveBusinessConnection(this: Store, input: {
    id: string;
    userId: number;
    userChatId?: number;
    isEnabled: boolean;
    rights?: unknown;
    connectedAt?: number;
    sourceId?: string;
    displayName?: string;
    username?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO business_connection (id, user_id, user_chat_id, is_enabled, rights, connected_at,
                                          source_id, display_name, username, updated_at)
         VALUES (@id, @userId, @userChatId, @isEnabled, @rights, @connectedAt,
                 @sourceId, @displayName, @username, @now)
         ON CONFLICT (id) DO UPDATE SET
           is_enabled = excluded.is_enabled,
           rights     = excluded.rights,
           source_id  = COALESCE(excluded.source_id, business_connection.source_id),
           display_name = COALESCE(excluded.display_name, business_connection.display_name),
           username   = COALESCE(excluded.username, business_connection.username),
           updated_at = excluded.updated_at`,
      )
      .run({
        id: input.id,
        userId: input.userId,
        userChatId: input.userChatId ?? null,
        isEnabled: input.isEnabled ? 1 : 0,
        rights: input.rights ? JSON.stringify(input.rights) : null,
        connectedAt: input.connectedAt ?? Date.now(),
        sourceId: input.sourceId ?? null,
        displayName: input.displayName ?? null,
        username: input.username ?? null,
        now: Date.now(),
      });
  }

  /**
   * Любой известный id бизнес-подключения из диалогов. Апдейт
   * business_connection прилетает один раз — в момент подключения бота,
   * и если процесс тогда не работал, в таблице пусто. Зато id приезжает
   * с каждым входящим, и по нему подключение можно дотянуть из Telegram.
   */
  anyBusinessConnectionId(this: Store): string | undefined {
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

  activeBusinessConnectionId(this: Store): string | undefined {
    return (
      this.db
        .prepare('SELECT id FROM business_connection WHERE is_enabled = 1 ORDER BY updated_at DESC LIMIT 1')
        .get() as { id: string } | undefined
    )?.id;
  }

  businessConnection(this: Store, id: string | null | undefined): {
    id: string;
    user_id: number;
    source_id: string | null;
    display_name: string | null;
    username: string | null;
    is_enabled: number;
  } | undefined {
    if (!id) return undefined;
    return this.db.prepare(
      'SELECT id, user_id, source_id, display_name, username, is_enabled FROM business_connection WHERE id = ?',
    ).get(id) as {
      id: string;
      user_id: number;
      source_id: string | null;
      display_name: string | null;
      username: string | null;
      is_enabled: number;
    } | undefined;
  }

  businessConnections(this: Store): {
    id: string;
    source_id: string | null;
    display_name: string | null;
    username: string | null;
    is_enabled: number;
  }[] {
    return this.db.prepare(
      'SELECT id, source_id, display_name, username, is_enabled FROM business_connection ORDER BY updated_at DESC',
    ).all() as {
      id: string;
      source_id: string | null;
      display_name: string | null;
      username: string | null;
      is_enabled: number;
    }[];
  }
}
