/**
 * «Отчёты» на живых данных (6.8): один период для всех вкладок (помним на
 * устройстве), сводка, цифры по людям, цели и очередь сроков. Каждый блок
 * грузится сам: ошибка одного не роняет страницу.
 */
import { computed, signal } from '@preact/signals';
import { tr } from '@/i18n/sections/reports';
import { can } from '@/lib/assistant/store';
import { showToast } from '@/lib/actions/toasts';
import { ApiError, getJson, readToken, sendJson } from '@/lib/live/api';
import {
  parsePeriod, type OperatorStatsResponse, type Period, type QueueResponse, type SlaPolicy, type SlaResponse, type StatsResponse,
} from './model';

const PERIOD_KEY = 'next.reportsPeriod';

export interface Res<T> {
  state: 'idle' | 'loading' | 'ready' | 'error';
  data: T | null;
  error: string;
}
const empty = <T>(): Res<T> => ({ state: 'idle', data: null, error: '' });

function readPeriod(): Period {
  try { return parsePeriod(localStorage.getItem(PERIOD_KEY)); } catch { return parsePeriod(null); }
}

export const period = signal<Period>(readPeriod());
export function setPeriod(next: Period): void {
  period.value = next;
  try { localStorage.setItem(PERIOD_KEY, String(next)); } catch { /* период живёт до перезагрузки */ }
}

/** Что можно смотреть (6.8, состояния): нет stats:read — раздела нет. */
export const rights = computed(() => ({
  stats: can('stats:read'),
  reset: can('stats:reset'),
  people: can('operator_stats:read'),
  sla: can('queue:read'),
  manage: can('queue:manage'),
}));

export const stats = signal<Res<StatsResponse>>(empty());
export const people = signal<Res<OperatorStatsResponse>>(empty());
export const sla = signal<Res<SlaResponse>>(empty());
export const queue = signal<Res<QueueResponse>>(empty());

const token = (): string => readToken() ?? '';
const reason = (err: unknown): string => (err instanceof ApiError || err instanceof Error ? err.message : String(err));
const counters = new Map<unknown, number>();

async function load<T>(target: { value: Res<T> }, path: string): Promise<void> {
  const mine = (counters.get(target) ?? 0) + 1;
  counters.set(target, mine);
  target.value = { ...target.value, state: 'loading', error: '' };
  try {
    const data = await getJson<T>(path, token());
    if (counters.get(target) === mine) target.value = { state: 'ready', data, error: '' };
  } catch (err) {
    if (counters.get(target) === mine) target.value = { state: 'error', data: target.value.data, error: reason(err) };
  }
}

export const loadStats = (days: number = period.value): Promise<void> => load(stats, `/api/stats?days=${days}`);
export const loadPeople = (days: number = period.value): Promise<void> => load(people, `/api/operator-stats?days=${days}`);
export const loadSla = (): Promise<void> => load(sla, '/api/sla');
export const loadQueue = (): Promise<void> => load(queue, '/api/queue');

/** Начать отсчёт заново (ярус 2): данные не удаляются, сервер запоминает дату. */
export async function resetStats(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await sendJson('/api/stats/reset', token(), {});
  } catch (err) {
    return { ok: false, error: reason(err) };
  }
  showToast({ text: tr('reports.resetDone') });
  void loadStats();
  void loadPeople();
  return { ok: true };
}

/** Цель по срочности (queue:manage): обе цифры уходят вместе, сервер проверяет 1..10080. */
export async function saveTarget(priority: SlaPolicy['priority'], firstResponseMinutes: number, resolutionMinutes: number): Promise<void> {
  const answer = await sendJson<{ ok: boolean; policies: SlaPolicy[] }>(
    `/api/sla/${priority}`, token(), { firstResponseMinutes, resolutionMinutes }, { method: 'PUT' },
  );
  sla.value = { state: 'ready', data: { policies: answer.policies ?? sla.value.data?.policies ?? [] }, error: '' };
  void loadQueue();
}
