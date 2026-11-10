import type Database from 'better-sqlite3';

/**
 * Черновики операторов на сервере (план редизайна, 7.8 и 10.6 п.5): начатый
 * на телефоне ответ можно дописать на компьютере. Один черновик на человека
 * и диалог; старше 30 дней — удаляются.
 *
 * Таблица создаётся здесь через CREATE TABLE IF NOT EXISTS, а не миграцией:
 * миграция подняла бы PRAGMA user_version, и прежний образ отказался бы
 * стартовать («откат не поддерживается»). Прежний образ эту таблицу просто
 * не знает и не трогает; убрать её вручную — `DROP TABLE operator_draft`.
 */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60_000;
export const DRAFT_TEXT_MAX = 10_000;

export interface DraftRow {
  text: string;
  mode: 'reply' | 'note';
  quote: { id: number; quote_id: string; excerpt: string } | null;
  from_suggestion: number | null;
  /** Вкладка, с которой записан черновик: свой кадр не возвращается этой же вкладке как «чужой текст». */
  device: string;
  updated_at: number;
}

export interface DraftInput {
  text: string;
  mode: 'reply' | 'note';
  quote: DraftRow['quote'];
  from_suggestion: number | null;
  device: string;
}

interface Stored {
  text: string;
  mode: string;
  quote_json: string | null;
  from_suggestion: number | null;
  device: string;
  updated_at: number;
}

export class OperatorDrafts {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS operator_draft (
        actor_key       TEXT    NOT NULL,
        conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
        text            TEXT    NOT NULL,
        mode            TEXT    NOT NULL DEFAULT 'reply',
        quote_json      TEXT,
        from_suggestion INTEGER,
        device          TEXT    NOT NULL DEFAULT '',
        updated_at      INTEGER NOT NULL,
        PRIMARY KEY (actor_key, conversation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_operator_draft_updated ON operator_draft (updated_at);
    `);
    this.prune();
  }

  get(actorKey: string, conversationId: number, now = Date.now()): DraftRow | null {
    const row = this.db.prepare(`
      SELECT text, mode, quote_json, from_suggestion, device, updated_at FROM operator_draft
       WHERE actor_key = ? AND conversation_id = ? AND updated_at >= ?
    `).get(actorKey, conversationId, now - DRAFT_TTL_MS) as Stored | undefined;
    return row ? toRow(row) : null;
  }

  /** Пустой текст без цитаты во вкладке «Ответ» — то же, что удалить. Возвращает записанное или null. */
  put(actorKey: string, conversationId: number, input: DraftInput, now = Date.now()): DraftRow | null {
    if (!input.text.trim() && !input.quote && input.mode === 'reply') {
      this.delete(actorKey, conversationId);
      return null;
    }
    // Время строго растёт: две записи за одну миллисекунду не путают «новее».
    const previous = this.db.prepare(`SELECT updated_at FROM operator_draft WHERE actor_key = ? AND conversation_id = ?`)
      .get(actorKey, conversationId) as { updated_at: number } | undefined;
    const at = Math.max(now, (previous?.updated_at ?? 0) + 1);
    this.db.prepare(`
      INSERT INTO operator_draft (actor_key, conversation_id, text, mode, quote_json, from_suggestion, device, updated_at)
      VALUES (@actor, @conversation, @text, @mode, @quote, @from, @device, @at)
      ON CONFLICT(actor_key, conversation_id) DO UPDATE SET
        text = excluded.text, mode = excluded.mode, quote_json = excluded.quote_json,
        from_suggestion = excluded.from_suggestion, device = excluded.device, updated_at = excluded.updated_at
    `).run({
      actor: actorKey, conversation: conversationId, text: input.text, mode: input.mode,
      quote: input.quote ? JSON.stringify(input.quote) : null, from: input.from_suggestion, device: input.device, at,
    });
    if (Math.random() < 0.02) this.prune(now);
    return { ...input, updated_at: at };
  }

  delete(actorKey: string, conversationId: number): boolean {
    return this.db.prepare(`DELETE FROM operator_draft WHERE actor_key = ? AND conversation_id = ?`).run(actorKey, conversationId).changes > 0;
  }

  prune(now = Date.now()): number {
    return this.db.prepare(`DELETE FROM operator_draft WHERE updated_at < ?`).run(now - DRAFT_TTL_MS).changes;
  }
}

function toRow(row: Stored): DraftRow {
  let quote: DraftRow['quote'] = null;
  try {
    const parsed = row.quote_json ? JSON.parse(row.quote_json) as DraftRow['quote'] : null;
    if (parsed && typeof parsed.id === 'number' && typeof parsed.quote_id === 'string' && typeof parsed.excerpt === 'string') quote = parsed;
  } catch { quote = null; }
  return {
    text: row.text,
    mode: row.mode === 'note' ? 'note' : 'reply',
    quote,
    from_suggestion: row.from_suggestion,
    device: row.device,
    updated_at: row.updated_at,
  };
}

/** Разбор тела PUT; строка — текст ошибки 400. */
export function parseDraftInput(body: unknown): DraftInput | string {
  if (!body || typeof body !== 'object') return 'Нужен черновик';
  const raw = body as Record<string, unknown>;
  if (typeof raw.text !== 'string') return 'text — строка';
  if (raw.text.length > DRAFT_TEXT_MAX) return `Черновик длиннее ${DRAFT_TEXT_MAX} символов`;
  const mode = raw.mode === undefined ? 'reply' : raw.mode;
  if (mode !== 'reply' && mode !== 'note') return 'mode — reply или note';
  let quote: DraftRow['quote'] = null;
  if (raw.quote !== undefined && raw.quote !== null) {
    const q = raw.quote as Record<string, unknown>;
    if (typeof q !== 'object' || !Number.isSafeInteger(q.id) || typeof q.quote_id !== 'string' || typeof q.excerpt !== 'string'
      || q.quote_id.length > 200 || q.excerpt.length > 500) return 'Некорректная цитата';
    quote = { id: q.id as number, quote_id: q.quote_id, excerpt: q.excerpt };
  }
  const from = raw.from_suggestion;
  if (from !== undefined && from !== null && !Number.isSafeInteger(from)) return 'from_suggestion — число';
  const device = raw.device === undefined ? '' : raw.device;
  if (typeof device !== 'string' || device.length > 64) return 'device — строка до 64 символов';
  return { text: raw.text, mode, quote, from_suggestion: (from as number | null | undefined) ?? null, device };
}
