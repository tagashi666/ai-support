import type { Store } from '../store.js';

/** Служебное: настройки, состояние опросов, журнал событий. */
export class StateRepo {
  getSetting(this: Store, key: string): unknown {
    const row = this.db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return undefined;
    }
  }

  setSetting(this: Store, key: string, value: unknown): void {
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
  nodeAliases(this: Store): Record<string, string> {
    const raw = this.getSetting('nodeAliases');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
  }

  setNodeAlias(this: Store, name: string, alias: string): void {
    const map = this.nodeAliases();
    const clean = alias.trim();
    if (clean) map[name] = clean;
    else delete map[name];
    this.setSetting('nodeAliases', map);
  }

  getState(this: Store, key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM poll_state WHERE key = ?').get(key) as { value: string } | undefined)
      ?.value;
  }

  /** Удаляет ключи с префиксом, не обновлявшиеся дольше `olderThanMs`. */
  pruneState(this: Store, prefix: string, olderThanMs: number): void {
    this.db
      .prepare(`DELETE FROM poll_state WHERE key LIKE ? ESCAPE '\\' AND updated_at < ?`)
      .run(prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + '%', Date.now() - olderThanMs);
  }

  setState(this: Store, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO poll_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  logEvent(this: Store, kind: string, conversationId: number | null, payload?: unknown): void {
    this.db
      .prepare('INSERT INTO event (kind, conversation_id, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(kind, conversationId, payload ? JSON.stringify(payload) : null, Date.now());
  }
}
