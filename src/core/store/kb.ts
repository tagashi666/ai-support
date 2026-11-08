import type { Store } from '../store.js';
import type { KbHit } from './types.js';
import { ftsExpression } from '../fts.js';

/** База знаний: синхронизация и полнотекстовый поиск. */
export class KbRepo {
  /** Полная замена документов источника: правки и удаления доезжают сами. */
  syncKb(this: Store, source: string, docs: { extId: string; title: string; body: string }[]): number {
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

  kbCount(this: Store): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM kb_doc').get() as { n: number }).n;
  }

  /**
   * Поиск по базе знаний. FTS5 падает на служебных символах запроса,
   * поэтому текст клиента разбирается на слова и склеивается через OR.
   */
  searchKb(this: Store, query: string, limit = 5): KbHit[] {
    // Основа слова, а не слово целиком: «оплатила» находит «оплату».
    const expression = ftsExpression(query);
    if (!expression) return [];
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
}
