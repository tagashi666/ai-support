import type { Store } from '../store.js';

// Задачи, запущенные этим процессом: запись `running` без неё — след
// перезапуска. WeakMap вместо поля, чтобы не расширять публичный API Store.
const runningJobs = new WeakMap<Store, Set<number>>();

function activeJobs(store: Store): Set<number> {
  let jobs = runningJobs.get(store);
  if (!jobs) runningJobs.set(store, jobs = new Set<number>());
  return jobs;
}

/** Фоновые задачи (майнинг KB и т.п.). */
export class JobRepo {
  startJob(this: Store, kind: string): number {
    // Две одинаковые задачи разом не нужны: майнинг тратит дневной лимит.
    const running = this.db
      .prepare(`SELECT id FROM job WHERE kind = ? AND status = 'running'`)
      .get(kind) as { id: number } | undefined;
    if (running && activeJobs(this).has(running.id)) return -running.id;
    if (running) {
      this.db.prepare(`
        UPDATE job SET status = 'failed', error = ?, ended_at = ?
         WHERE kind = ? AND status = 'running'
      `).run('Процесс был перезапущен до завершения задачи', Date.now(), kind);
    }
    const result = this.db
      .prepare(`INSERT INTO job (kind, started_at) VALUES (?, ?)`)
      .run(kind, Date.now());
    const id = Number(result.lastInsertRowid);
    activeJobs(this).add(id);
    return id;
  }

  updateJob(this: Store, id: number, progress: string): void {
    this.db.prepare('UPDATE job SET progress = ? WHERE id = ?').run(progress, id);
  }

  finishJob(this: Store, id: number, result?: unknown, error?: string): void {
    this.db
      .prepare(`UPDATE job SET status = ?, result = ?, error = ?, ended_at = ? WHERE id = ?`)
      .run(error ? 'failed' : 'done', result ? JSON.stringify(result) : null, error ?? null, Date.now(), id);
    activeJobs(this).delete(id);
  }

  latestJob(this: Store, kind: string): Record<string, unknown> | undefined {
    return this.db
      .prepare('SELECT * FROM job WHERE kind = ? ORDER BY id DESC LIMIT 1')
      .get(kind) as Record<string, unknown> | undefined;
  }
}
