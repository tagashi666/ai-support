/**
 * Неполадки системы (этап 6): одно место для «Нужно внимание» на «Сегодня»,
 * точки у «Системы» в рейке и вердикта в «Системе → Здоровье». Начальное
 * значение — из bootstrap, дальше кадр problems с сервера (L-3) — на любом
 * экране, без опроса. Без diagnostics:read — пусто.
 */
import { computed } from '@preact/signals';
import { t, tn } from '@/i18n/ru';
import { getJson, readToken } from '@/lib/live/api';
import { bootstrap, problemsAt } from '@/lib/live/store';
import type { ProblemsResponse, SystemProblem } from '@shared/api-types';

/** Последний известный список: bootstrap, дальше кадры problems (L-3) и «Проверить». */
export const problems = computed<SystemProblem[]>(() => bootstrap.value?.problems ?? []);
export const problemsCheckedAt = computed(() => problemsAt.value);
export const canSeeProblems = computed(() => bootstrap.value?.problems !== null && bootstrap.value?.problems !== undefined);
/** Цвет точки у «Системы»: красная — неполадка, синяя — новая версия (5.1). */
export const systemDot = computed<'error' | 'warn' | 'update' | null>(() => {
  const list = problems.value;
  if (list.some((p) => p.severity === 'error')) return 'error';
  if (list.length > 0) return 'warn';
  return bootstrap.value?.update?.available ? 'update' : null;
});

export async function refreshProblems(): Promise<void> {
  if (!canSeeProblems.peek()) return;
  try {
    const res = await getJson<ProblemsResponse>('/api/system/problems', readToken() ?? '');
    const current = bootstrap.peek();
    if (current) bootstrap.value = { ...current, problems: res.problems, counts: { ...current.counts, problems: res.problems.length } };
    problemsAt.value = res.checkedAt;
  } catch { /* остаётся прежний список; ошибку покажет сам экран */ }
}

/** Одна фраза о неполадке: «Сервер Франкфурт-2 не отвечает». */
export function problemText(problem: SystemProblem): string {
  switch (problem.code) {
    case 'nodes_offline':
      return problem.count > 1
        ? t('problem.nodesMany', { count: problem.count, servers: tn('plural.servers', problem.count), name: problem.subject ?? '' })
        : t('problem.nodesOne', { name: problem.subject ?? '' });
    case 'nodes_error': return t('problem.nodesError');
    case 'update_failed': return problem.subject ? t('problem.updateFailedVersion', { version: problem.subject }) : t('problem.updateFailed');
    case 'job_failed': return t('problem.jobFailed');
    default: return t('problem.other');
  }
}

/** Куда ведёт «Подробнее»: вкладка «Системы». */
export function problemTarget(problem: SystemProblem): string | undefined {
  if (problem.code === 'nodes_offline' || problem.code === 'nodes_error') return 'servers';
  if (problem.code === 'update_failed') return 'update';
  return undefined;
}
