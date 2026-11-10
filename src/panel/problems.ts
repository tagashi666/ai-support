import type { SystemProblem } from '../shared/api-types.js';
import type { RouteContext } from './context.js';

const DAY = 86_400_000;

/**
 * Неполадки системы для «Нужно внимание» на «Сегодня» и точки у «Системы»
 * (план 6.1, 6.9; этап 6). Только локальное состояние: снимок серверов в
 * памяти, журнал обновлений и задачи в базе — ни одного сетевого вызова,
 * поэтому считается на каждом bootstrap. Порядок: сначала error, потом warn.
 */
export function systemProblems(ctx: Pick<RouteContext, 'nodes' | 'operations' | 'store'>, now = Date.now()): SystemProblem[] {
  const problems: SystemProblem[] = [];
  if (ctx.nodes) {
    const snap = ctx.nodes.get();
    // Выключенный сервер — решение человека, а не неполадка.
    const down = snap.nodes.filter((node) => !node.online && !node.disabled);
    if (down.length > 0) {
      problems.push({ code: 'nodes_offline', severity: 'error', count: down.length, subject: down[0]!.name || down[0]!.rawName, at: snap.at || null });
    }
    if (snap.error) problems.push({ code: 'nodes_error', severity: 'warn', count: 1, subject: null, at: snap.at || null });
  }
  // Последняя операция обновления не удалась (и после неё не было удачной) — за неделю.
  const last = ctx.operations.updateHistory(1)[0];
  if (last && ['failed', 'rolled_back'].includes(String(last.status)) && Number(last.updated_at ?? last.created_at) > now - 7 * DAY) {
    problems.push({ code: 'update_failed', severity: 'warn', count: 1, subject: last.version ? String(last.version) : null, at: Number(last.updated_at ?? last.created_at) });
  }
  const failed = ctx.store.db.prepare(`SELECT kind, ended_at FROM job WHERE status = 'failed' AND COALESCE(ended_at, started_at) > ? ORDER BY id DESC`)
    .all(now - DAY) as Array<{ kind: string; ended_at: number | null }>;
  if (failed.length > 0) problems.push({ code: 'job_failed', severity: 'warn', count: failed.length, subject: failed[0]!.kind, at: failed[0]!.ended_at });
  return problems.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}
