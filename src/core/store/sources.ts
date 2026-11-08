import type { Store } from '../store.js';
import type { SourceAccount, InboxFolder, ServiceProfile } from './types.js';

/** Источники, профили сервиса и папки inbox. */
export class SourceRepo {
  syncSource(this: Store, input: { id: string; kind: SourceAccount['kind']; name: string; enabled?: boolean; metadata?: unknown }): void {
    this.db.prepare(
      `INSERT INTO source_account (id, kind, name, enabled, metadata, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name,
         enabled=excluded.enabled, metadata=excluded.metadata, updated_at=excluded.updated_at`,
    ).run(input.id, input.kind, input.name, input.enabled === false ? 0 : 1,
      input.metadata === undefined ? null : JSON.stringify(input.metadata), Date.now());
  }

  sourceAccount(this: Store, id: string | null | undefined): SourceAccount | undefined {
    if (!id) return undefined;
    return this.db.prepare('SELECT * FROM source_account WHERE id = ?').get(id) as SourceAccount | undefined;
  }

  sourceAccounts(this: Store): SourceAccount[] {
    return this.db.prepare('SELECT * FROM source_account WHERE enabled = 1 ORDER BY kind, name, id').all() as SourceAccount[];
  }

  conversationSourceIds(this: Store, conversationId: number): string[] {
    return (this.db.prepare('SELECT source_id FROM conversation_source WHERE conversation_id = ? ORDER BY source_id')
      .all(conversationId) as { source_id: string }[]).map((row) => row.source_id);
  }

  linkConversationSource(this: Store, conversationId: number, sourceId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO conversation_source (conversation_id, source_id) VALUES (?, ?)')
      .run(conversationId, sourceId);
  }

  serviceProfiles(this: Store): Record<string, ServiceProfile> {
    const raw = this.getSetting('serviceProfiles');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const result: Record<string, ServiceProfile> = {};
    for (const [sourceId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      const serviceName = typeof item.serviceName === 'string' ? item.serviceName.trim() : '';
      const greetingMessage = typeof item.greetingMessage === 'string' ? item.greetingMessage.trim() : '';
      const handoffMessage = typeof item.handoffMessage === 'string' ? item.handoffMessage.trim() : '';
      if (!serviceName) continue;
      result[sourceId] = { sourceId, serviceName, greetingMessage, handoffMessage };
    }
    return result;
  }

  saveServiceProfile(this: Store, sourceId: string, input: {
    serviceName?: unknown;
    greetingMessage?: unknown;
    handoffMessage?: unknown;
  }): ServiceProfile {
    if (!this.sourceAccount(sourceId)) throw new Error('Источник не найден');
    const serviceName = String(input.serviceName ?? '').trim();
    const greetingMessage = String(input.greetingMessage ?? '').trim();
    const handoffMessage = String(input.handoffMessage ?? '').trim();
    if (!serviceName || serviceName.length > 80) {
      throw new Error('Название сервиса должно быть от 1 до 80 символов');
    }
    if (greetingMessage.length > 600) throw new Error('Приветствие не длиннее 600 символов');
    if (handoffMessage.length > 600 || (handoffMessage.length > 0 && handoffMessage.length < 5)) {
      throw new Error('Фраза передачи должна быть от 5 до 600 символов');
    }
    const profile = { sourceId, serviceName, greetingMessage, handoffMessage };
    const profiles = this.serviceProfiles();
    profiles[sourceId] = profile;
    this.setSetting('serviceProfiles', profiles);
    return profile;
  }

  folders(this: Store): InboxFolder[] {
    const rows = this.db.prepare('SELECT id, name, color, position FROM inbox_folder ORDER BY position, id').all() as Omit<InboxFolder, 'source_ids'>[];
    const sourceRows = this.db.prepare('SELECT folder_id, source_id FROM inbox_folder_source ORDER BY source_id')
      .all() as { folder_id: number; source_id: string }[];
    const grouped = new Map<number, string[]>();
    for (const row of sourceRows) {
      const ids = grouped.get(row.folder_id) ?? [];
      ids.push(row.source_id);
      grouped.set(row.folder_id, ids);
    }
    return rows.map((row) => ({ ...row, source_ids: grouped.get(row.id) ?? [] }));
  }

  saveFolder(this: Store, input: { id?: number; name: string; color?: string | null; sourceIds: string[] }): InboxFolder {
    const name = input.name.trim();
    if (!name || name.length > 80) throw new Error('Название папки должно быть от 1 до 80 символов');
    const sourceIds = [...new Set(input.sourceIds)].filter((id) => this.sourceAccount(id));
    const id = this.db.transaction(() => {
      let folderId = input.id;
      if (folderId) {
        const changed = this.db.prepare('UPDATE inbox_folder SET name=?, color=?, updated_at=? WHERE id=?')
          .run(name, input.color ?? null, Date.now(), folderId);
        if (!changed.changes) throw new Error('Папка не найдена');
      } else {
        const position = (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM inbox_folder').get() as { n: number }).n;
        folderId = Number(this.db.prepare('INSERT INTO inbox_folder (name,color,position,created_at,updated_at) VALUES (?,?,?,?,?)')
          .run(name, input.color ?? null, position, Date.now(), Date.now()).lastInsertRowid);
      }
      this.db.prepare('DELETE FROM inbox_folder_source WHERE folder_id=?').run(folderId);
      const link = this.db.prepare('INSERT INTO inbox_folder_source (folder_id,source_id) VALUES (?,?)');
      for (const sourceId of sourceIds) link.run(folderId, sourceId);
      return folderId!;
    })();
    return this.folders().find((folder) => folder.id === id)!;
  }

  deleteFolder(this: Store, id: number): boolean {
    return this.db.prepare('DELETE FROM inbox_folder WHERE id=?').run(id).changes > 0;
  }
}
