import type { Store } from '../store.js';
import type { StoredAttachment, Attachment } from './types.js';
import { ATTACHMENT_GAVE_UP } from './types.js';

/** Вложения: очередь загрузки, повторы, учёт на диске. */
export class AttachmentRepo {
  addAttachment(
    this: Store,
    messageId: number,
    mediaType: string | undefined,
    fileRef: string,
    size?: { width?: number; height?: number },
  ): number {
    const existing = this.db
      .prepare('SELECT id FROM attachment WHERE message_id = ? AND file_ref = ?')
      .get(messageId, fileRef) as { id: number } | undefined;
    if (existing) return existing.id;
    const result = this.db
      .prepare(
        `INSERT INTO attachment (message_id, media_type, file_ref, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(messageId, mediaType ?? null, fileRef, size?.width ?? null, size?.height ?? null, Date.now());
    return Number(result.lastInsertRowid);
  }

  addLocalAttachment(
    this: Store,
    messageId: number,
    input: { fileRef: string; localPath: string; mediaType: string; mimeType: string; originalName: string;
      bytes: number; sha256: string; width?: number; height?: number },
  ): number {
    const id = this.addAttachment(messageId, input.mediaType, input.fileRef, {
      width: input.width, height: input.height,
    });
    this.db.prepare(
      `UPDATE attachment SET local_path=?, bytes=?, downloaded_at=?, original_name=?, mime_type=?, sha256=? WHERE id=?`,
    ).run(input.localPath, input.bytes, Date.now(), input.originalName, input.mimeType, input.sha256, id);
    return id;
  }

  markAttachmentDownloaded(this: Store, id: number, localPath: string, bytes: number, mimeType?: string): void {
    this.db
      .prepare(`UPDATE attachment
                  SET local_path = ?, bytes = ?, downloaded_at = ?, mime_type = COALESCE(?, mime_type),
                      next_attempt_at = 0, last_error = NULL
                WHERE id = ?`)
      .run(localPath, bytes, Date.now(), mimeType ?? null, id);
  }

  /** Ссылки вложений на файлы — для сборщика сирот в MEDIA_DIR. */
  mediaFileReferences(this: Store): Array<{ file_ref: string; local_path: string | null }> {
    return this.db.prepare('SELECT file_ref, local_path FROM attachment')
      .all() as Array<{ file_ref: string; local_path: string | null }>;
  }

  /** Источник и file_id аватарок диалогов — для чистки кэша аватарок. */
  avatarReferences(this: Store): Array<{ source_id: string | null; file_id: string }> {
    return this.db.prepare(
      `SELECT COALESCE(avatar_source_id, source_id) AS source_id, avatar_file_id AS file_id
         FROM conversation WHERE avatar_file_id IS NOT NULL AND avatar_file_id <> ''`,
    ).all() as Array<{ source_id: string | null; file_id: string }>;
  }

  mediaBytes(this: Store): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM attachment').get() as { n: number };
    return Number(row.n) || 0;
  }

  /**
   * Невыкачанные вложения и, по запросу MediaFetcher, уже сохранённые
   * голосовые без текста. Второй вариант нужен для повторной расшифровки:
   * файл остаётся доступен оператору и учитывается в дисковой квоте.
   */
  pendingAttachments(this: Store, limit = 20, now = Date.now(), retryVoice = false): { id: number; message_id: number; media_type: string | null; file_ref: string; attempts: number }[] {
    return this.db
      .prepare(`SELECT attachment.id, attachment.message_id, attachment.media_type,
                       attachment.file_ref, attachment.attempts
                  FROM attachment JOIN message ON message.id = attachment.message_id
                 WHERE attachment.next_attempt_at <= ?
                   AND (attachment.local_path IS NULL
                     OR (? = 1 AND attachment.media_type IN ('voice','audio','video_note')
                         AND (message.text IS NULL OR trim(message.text) = '')))
                 ORDER BY attachment.next_attempt_at, attachment.id LIMIT ?`)
      .all(now, retryVoice ? 1 : 0, limit) as { id: number; message_id: number; media_type: string | null; file_ref: string; attempts: number }[];
  }

  /**
   * Откладывает вложение. Постоянная ошибка (файл больше лимита Bot API,
   * удалён у источника) больше не повторяется: next_attempt_at уходит в
   * «никогда», а панель показывает причину и кнопку повтора.
   */
  deferAttachment(this: Store, id: number, error: unknown, now = Date.now(), permanent = false): number {
    const row = this.db.prepare('SELECT attempts FROM attachment WHERE id = ?').get(id) as { attempts: number } | undefined;
    if (!row) return 0;
    const attempts = row.attempts + 1;
    const delay = Math.min(6 * 60 * 60_000, 5_000 * 2 ** Math.min(12, attempts - 1));
    const nextAttemptAt = permanent ? ATTACHMENT_GAVE_UP : now + delay;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    this.db.prepare('UPDATE attachment SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?')
      .run(attempts, nextAttemptAt, message, id);
    return nextAttemptAt;
  }

  getAttachment(this: Store, id: number): StoredAttachment | undefined {
    return this.db.prepare(
      `SELECT id, local_path, media_type, file_ref, original_name, mime_type, bytes, next_attempt_at, attempts, last_error
         FROM attachment WHERE id = ?`,
    ).get(id) as StoredAttachment | undefined;
  }

  /** Ручной повтор из панели: вложение снова встаёт в очередь сейчас. */
  retryAttachment(this: Store, id: number, now = Date.now()): boolean {
    const changed = this.db.prepare('UPDATE attachment SET next_attempt_at = ?, attempts = 0 WHERE id = ? AND local_path IS NULL')
      .run(now, id).changes > 0;
    if (changed) this.emit('attachment_retry', { id });
    return changed;
  }

  attachmentsFor(this: Store, messageIds: number[]): Record<number, Attachment[]> {
    if (!messageIds.length) return {};
    const rows = this.db
      .prepare(
        `SELECT id, message_id, media_type, width, height, original_name, mime_type, bytes
           FROM attachment WHERE message_id IN (${messageIds.map(() => '?').join(',')})`,
      )
      .all(...messageIds) as (Attachment & { message_id: number })[];
    const grouped: Record<number, Attachment[]> = {};
    for (const row of rows) {
      (grouped[row.message_id] ??= []).push({
        id: row.id, media_type: row.media_type, width: row.width, height: row.height,
        original_name: row.original_name, mime_type: row.mime_type, bytes: row.bytes,
      });
    }
    return grouped;
  }
}
