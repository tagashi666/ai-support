/**
 * «Отчёты» (6.8): чистые функции без сети — разбор периода, подписи медиан
 * («9 из 10 быстрее …»), проценты, «мало данных», срок «вышел / осталось»,
 * фильтры очереди, события и каналы словами, часы суток по местному времени.
 */
import { t } from '@/i18n/ru';
import { tr } from '@/i18n/sections/reports';
import { duration } from '@/lib/format/format';

export const PERIODS = [7, 14, 30, 90] as const;
export type Period = typeof PERIODS[number];
export const DEFAULT_PERIOD: Period = 7;
/** Меньше стольких диалогов за период — цифры с пометкой «мало данных». */
export const FEW_DIALOGS = 5;
const MIN = 60_000;

/** Период из хранилища или адреса: только 7 / 14 / 30 / 90, иначе 7. */
export function parsePeriod(raw: unknown): Period {
  const n = typeof raw === 'string' ? Number(raw.trim()) : typeof raw === 'number' ? raw : NaN;
  return (PERIODS as readonly number[]).includes(n) ? n as Period : DEFAULT_PERIOD;
}

// ---------- Формы ответов сервера ----------

export interface StatsResponse {
  days: number;
  since: number;
  resetAt: number | null;
  totals: { total: number; open: number; escalated: number; suspicious: number; handoff: number; waiting: number };
  period: { conversations: number; resolved: number };
  avgFirstResponseMs: number | null;
  medianFirstResponseMs: number | null;
  p90FirstResponseMs: number | null;
  answered: number;
  avgResolutionMs: number | null;
  medianResolutionMs: number | null;
  resolved: number;
  byChannel: { channel: string; n: number }[];
  suggestions: { status: string; n: number }[];
  acceptanceRate: number | null;
  aiShare: number | null;
  automationRate: number | null;
  aiReplies: number;
  humanReplies: number;
  volume: { day: string; incoming: number; outgoing: number; byAi: number; byHuman: number }[];
  hours: { hour: string; n: number }[];
  events: { kind: string; n: number }[];
  topSources: { title: string; n: number }[];
  aiUsage: AiUsage;
  kb: number;
}

export interface UsageRow { purpose: string; requests: number; prompt: number; completion: number; cached: number }
export interface AiUsage { today: UsageRow[]; week: UsageRow[]; avgReplyPrompt: number | null }

export interface OperatorStat {
  id: number | null;
  key: string;
  name: string;
  role: string;
  active: boolean | number;
  handled: number;
  resolved: number;
  replies: number;
  average_response_ms: number | null;
  median_response_ms: number | null;
  active_assigned: number;
  last_activity_at: number | null;
}
export interface OperatorStatsResponse { days: number; since: number; operators: OperatorStat[] }

export type Priority = 'urgent' | 'high' | 'normal' | 'low';
export const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];
export interface SlaPolicy { priority: Priority; first_response_minutes: number; resolution_minutes: number }
export interface SlaResponse { policies: SlaPolicy[] }

export interface QueueRow {
  id: number;
  channel: string;
  username: string | null;
  display_name: string | null;
  status: string;
  priority: Priority | string;
  due_at: number;
  overdue: boolean;
  owner_name: string | null;
  owner_live: boolean;
}
export interface QueueResponse { conversations: QueueRow[]; policies: SlaPolicy[] }

// ---------- Числа словами ----------

export const percent = (rate: number | null): string | null => (rate === null || !Number.isFinite(rate) ? null : `${Math.round(rate * 100)}%`);

/** Вторая строка карточки «Первый ответ»: «9 из 10 быстрее 40 мин»; нет ответов — null. */
export function firstResponseLines(stats: Pick<StatsResponse, 'medianFirstResponseMs' | 'p90FirstResponseMs'>): { median: string; slowest: string } | null {
  if (stats.medianFirstResponseMs === null) return null;
  return {
    median: tr('reports.firstMedian', { time: duration(stats.medianFirstResponseMs) }),
    slowest: stats.p90FirstResponseMs === null ? '' : tr('reports.firstNine', { time: duration(stats.p90FirstResponseMs) }),
  };
}

/** Решено X из Y: Y — диалоги, начавшиеся за период. */
export const resolvedLine = (stats: Pick<StatsResponse, 'period'>): string =>
  tr('reports.resolvedOf', { done: stats.period.resolved, all: stats.period.conversations });

export const resolutionLine = (stats: Pick<StatsResponse, 'medianResolutionMs'>): string | null =>
  stats.medianResolutionMs === null ? null : tr('reports.resolutionMedian', { time: duration(stats.medianResolutionMs) });

/**
 * «Сам написал помощник»: доля исходящих сообщений периода, отправленных
 * помощником без человека (aiShare = byAi / все исходящие, store/stats.ts).
 */
export const assistantOwnShare = (stats: Pick<StatsResponse, 'aiShare'>): string | null => percent(stats.aiShare);

/**
 * «Черновики без правок»: из решённых по черновикам (отправлен как есть,
 * отправлен после правки, отклонён; «ждёт» и «заменён» не считаем) — доля
 * отправленных как есть. Серверный acceptanceRate включает и «после правки»,
 * поэтому считаем сами из suggestions.
 */
export function draftsUnchanged(suggestions: readonly { status: string; n: number }[]): { share: string; of: number } | null {
  const count = (status: string): number => suggestions.find((row) => row.status === status)?.n ?? 0;
  const decided = count('sent') + count('edited') + count('rejected');
  if (decided === 0) return null;
  return { share: `${Math.round((count('sent') / decided) * 100)}%`, of: decided };
}

/** Мало данных: диалогов за период больше нуля, но меньше пяти. */
export const fewData = (stats: Pick<StatsResponse, 'period'>): boolean =>
  stats.period.conversations > 0 && stats.period.conversations < FEW_DIALOGS;
export const noData = (stats: Pick<StatsResponse, 'period'>): boolean => stats.period.conversations === 0;

export const fewDataNote = (): string => tr('reports.fewData', { n: FEW_DIALOGS });

// ---------- Каналы, события, расход ----------

const CHANNEL_KEY = {
  tg_bot: 'channel.telegram', tg_dm: 'channel.business', bedolaga: 'channel.bedolaga', minishop: 'channel.minishop',
  telegram: 'channel.telegram', business: 'channel.business',
} as const;

export function channelName(channel: string): string {
  const key = (CHANNEL_KEY as Record<string, (typeof CHANNEL_KEY)[keyof typeof CHANNEL_KEY]>)[channel];
  return key ? t(key) : tr('reports.other');
}

const EVENT_KEY = {
  ai_handoff: 'reports.event.handoff',
  ai_draft: 'reports.event.draft',
  ai_blocked: 'reports.event.blocked',
  ai_error: 'reports.event.error',
  ai_feedback: 'reports.event.feedback',
  ai_paused: 'reports.event.paused',
  ai_resumed: 'reports.event.resumed',
  suggestion_rejected: 'reports.event.rejected',
  sla_breach: 'reports.event.slaBreach',
  conversation_hidden: 'reports.event.hidden',
  handoff_send_failed: 'reports.event.handoffFailed',
  stats_reset: 'reports.event.statsReset',
} as const;

/** События словами; неизвестные коды складываются в «Другое», сырой код на экран не выходит. */
export function eventRows(events: readonly { kind: string; n: number }[]): { label: string; n: number }[] {
  const known = new Map<(typeof EVENT_KEY)[keyof typeof EVENT_KEY], number>();
  let other = 0;
  for (const event of events) {
    const key = (EVENT_KEY as Record<string, (typeof EVENT_KEY)[keyof typeof EVENT_KEY]>)[event.kind];
    if (key) known.set(key, (known.get(key) ?? 0) + event.n);
    else other += event.n;
  }
  const rows = [...known.entries()].map(([key, n]) => ({ label: tr(key), n }));
  rows.sort((a, b) => b.n - a.n);
  if (other > 0) rows.push({ label: tr('reports.other'), n: other });
  return rows;
}

const PURPOSE_KEY = {
  reply: 'reports.purpose.reply', repair: 'reports.purpose.repair', mining: 'reports.purpose.mining',
  try: 'reports.purpose.try', eval: 'reports.purpose.try',
} as const;
export const purposeName = (purpose: string): string => {
  const key = (PURPOSE_KEY as Record<string, (typeof PURPOSE_KEY)[keyof typeof PURPOSE_KEY]>)[purpose];
  return tr(key ?? 'reports.purpose.other');
};

export const tokensOf = (rows: readonly UsageRow[]): number => rows.reduce((sum, row) => sum + row.prompt + row.completion, 0);
export const requestsOf = (rows: readonly UsageRow[]): number => rows.reduce((sum, row) => sum + row.requests, 0);

/** «410 тыс.», «1,2 млн», «850». */
export function tokensText(n: number): string {
  if (n >= 1_000_000) return tr('reports.millions', { n: (Math.round(n / 100_000) / 10).toLocaleString('ru') });
  if (n >= 10_000) return tr('reports.thousands', { n: Math.round(n / 1000) });
  return n.toLocaleString('ru');
}

// ---------- Графики ----------

/** Часы суток из UTC (так считает сервер) в местные; всегда 24 столбика. */
export function localHours(hours: readonly { hour: string; n: number }[], offsetMinutes = -new Date().getTimezoneOffset()): { hour: number; n: number }[] {
  const out = Array.from({ length: 24 }, (_, hour) => ({ hour, n: 0 }));
  const shift = Math.round(offsetMinutes / 60);
  for (const row of hours) {
    const utc = Number(row.hour);
    if (!Number.isFinite(utc) || utc < 0 || utc > 23) continue;
    const local = (((utc + shift) % 24) + 24) % 24;
    out[local]!.n += row.n;
  }
  return out;
}

/** Высота столбика в процентах от самого высокого; ненулевой — не ниже 4%. */
export function barHeights(values: readonly number[]): number[] {
  const max = Math.max(0, ...values);
  if (max === 0) return values.map(() => 0);
  return values.map((value) => (value === 0 ? 0 : Math.max(4, Math.round((value / max) * 100))));
}

/** «2026-11-09» (день по UTC) → полдень этого дня, чтобы подпись не съезжала. */
export const dayStamp = (day: string): number => Date.parse(`${day}T12:00:00Z`);

// ---------- Сроки ответа ----------

export const priorityName = (priority: string): string => {
  switch (priority) {
    case 'urgent': return tr('reports.priority.urgent');
    case 'high': return tr('reports.priority.high');
    case 'normal': return tr('reports.priority.normal');
    case 'low': return tr('reports.priority.low');
    default: return tr('reports.other');
  }
};

/** Минуты цели словами: «15 мин», «4 ч», «2 д». Пустое подставляем «=» снаружи. */
export const minutesText = (minutes: number): string => duration(minutes * MIN);

/** Ввод цели: целое число минут 1..10080 (неделя). Иначе — null. */
export function parseMinutes(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 10_080 ? n : null;
}

/** «срок вышел 40 мин назад» / «осталось 12 мин». */
export function dueText(row: Pick<QueueRow, 'due_at' | 'overdue'>, now: number): string {
  const left = row.due_at - now;
  return row.overdue || left < 0 ? tr('reports.dueLate', { time: duration(-left) }) : tr('reports.dueLeft', { time: duration(left) });
}

/** «ведёт Мария» / «вёл Мария» / «никто не ведёт». */
export function ownerText(row: Pick<QueueRow, 'owner_name' | 'owner_live'>): string {
  if (!row.owner_name) return tr('reports.ownerNone');
  return row.owner_live ? tr('reports.ownerLive', { name: row.owner_name }) : tr('reports.ownerWas', { name: row.owner_name });
}

export type QueueMode = 'all' | 'overdue' | 'free';
export interface QueueFilter { mode: QueueMode; priority: Priority | 'any' }
export const NO_QUEUE_FILTER: QueueFilter = { mode: 'all', priority: 'any' };

/** Просроченные первыми, дальше по сроку; «Никто не ведёт» — закрепления нет (вёл — не считается). */
export function filterQueue(rows: readonly QueueRow[], filter: QueueFilter): QueueRow[] {
  return rows
    .filter((row) => (filter.mode === 'overdue' ? row.overdue : filter.mode === 'free' ? !row.owner_live : true))
    .filter((row) => filter.priority === 'any' || row.priority === filter.priority)
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.due_at - b.due_at);
}

export const overdueCount = (rows: readonly QueueRow[]): number => rows.filter((row) => row.overdue).length;

export const dialogName = (row: Pick<QueueRow, 'display_name' | 'username' | 'id'>): string =>
  row.display_name?.trim() || (row.username ? `@${row.username.replace(/^@/, '')}` : tr('reports.dialogN', { n: row.id }));
