import type { Store } from '../store.js';
import type { Template } from './types.js';

/** Шаблоны ответов оператора. */
export class TemplateRepo {
  listTemplates(this: Store): Template[] {
    return this.db.prepare('SELECT * FROM template ORDER BY uses DESC, shortcut').all() as Template[];
  }

  upsertTemplate(this: Store, shortcut: string, title: string, body: string): void {
    this.db
      .prepare(
        `INSERT INTO template (shortcut, title, body, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (shortcut) DO UPDATE SET title = excluded.title, body = excluded.body`,
      )
      .run(shortcut, title, body, Date.now());
  }

  deleteTemplate(this: Store, id: number): void {
    this.db.prepare('DELETE FROM template WHERE id = ?').run(id);
  }
}
