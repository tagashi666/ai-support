/**
 * «Система» (6.9): чистая модель — вердикт и список проверок, сводка серверов,
 * разбор списка изменений, подписи шагов обновления и уровня уведомлений.
 * Ничего не ходит в сеть: данные приходят готовыми, подписи — из словаря раздела.
 */
import { tr, trn } from '@/i18n/sections/system';
import { clock, duration, fullDate } from '@/lib/format/format';
import { problemText } from './problems';
import type { ConnectionsResponse, SystemProblem } from '@shared/api-types';

/* ---------- Формы ответов сервера (по src/panel/routes/*) ---------- */

export interface JobRow { id: number; kind: string; status: string; progress: string | null; error: string | null; started_at: number; ended_at: number | null }
export interface Diagnostics {
  application: { version: string; uptime: number; memory: { rss: number; heapUsed: number; heapTotal: number } };
  database: { integrity: unknown; schema: number; counts: Record<string, number>; jobs: JobRow[] };
  channels: Record<string, boolean>;
  integrations: Record<string, boolean>;
  cursors: { bedolaga: string | null; minishop: string | null };
  kb: number;
  settingOverrides: Array<{ key: string; value: unknown; env: unknown }>;
}
export interface Health { ok: boolean; kb: number; businessConnection: boolean; lastBedolagaPoll: string | null; lastMinishopPoll: string | null }
export interface NodeRow {
  uuid?: string; rawName: string; name: string; country?: string; online: boolean; disabled: boolean;
  usersOnline?: number; trafficUsedBytes?: number; sourceId?: string; sourceName?: string; aliasKey?: string; alias: string | null;
}
export interface NodesSnapshot { at: number; error?: string; nodes: NodeRow[] }
/** Снимок серверов: данные · опрос выключен (501) · ошибка. */
export type NodesState = { kind: 'ok'; snapshot: NodesSnapshot } | { kind: 'off'; message: string } | { kind: 'error'; message: string };
export type NotifyLevel = 'all' | 'important' | 'minimal';
export interface NotificationsInfo { configured: boolean; level: NotifyLevel; lastError: string | null }
export type UpdateStatus = 'queued' | 'backing_up' | 'installing' | 'checking' | 'completed' | 'rolled_back' | 'failed';
export interface UpdateProgress { action: 'update' | 'rollback'; status: UpdateStatus; stage?: string; percent?: number; version?: string; detail?: string; startedAt?: string; updatedAt?: string }
export interface HistoryRow { id: number; action: string; version: string | null; status: string; detail: string | null; created_at: number }
export interface UpdateInfo {
  enabled: boolean; current: string; available: boolean; reinstallable: boolean; queued: boolean; latest: string | null; name: string | null;
  publishedAt: string | null; changelog: string | null; progress: UpdateProgress | null; error?: string;
  compatibility?: { rollbackAvailable?: boolean }; history?: HistoryRow[];
}

/* ---------- Единицы ---------- */

export function bytesWords(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return tr('system.bytes.zero');
  const units = ['system.bytes.b', 'system.bytes.kb', 'system.bytes.mb', 'system.bytes.gb', 'system.bytes.tb'] as const;
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  const text = value >= 100 || index === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '').replace('.', ',');
  return `${text} ${tr(units[index]!)}`;
}

/** Память словами: «занимает 180 МБ». */
export function memoryWords(rss: number): string {
  return tr('system.app.memory', { size: bytesWords(rss) });
}

export function uptimeWords(seconds: number): string {
  return tr('system.app.uptime', { time: duration(Math.max(0, seconds) * 1000) });
}

/** Время опроса из строки состояния («1731165900000») или ничего. */
export function pollTime(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/* ---------- Проверки и вердикт ---------- */

export type Tone = 'error' | 'warn' | 'ok' | 'off';
export type CheckId =
  | 'app' | 'database' | 'bot' | 'business' | 'bedolaga' | 'minishop' | 'remnawave' | 'notifications'
  | 'model' | 'servers' | 'kb' | 'jobs' | 'update';
export interface Check {
  id: CheckId;
  tone: Tone;
  title: string;
  summary: string;
  /** Фраза о неполадке для вердикта: «Сервер Франкфурт-2 не отвечает». */
  issue?: string;
  details: Array<{ label: string; value: string }>;
  link?: 'servers' | 'update' | 'notifications';
  test?: boolean;
}

/** Часть данных: undefined — нет права (проверки нет), null — не смогли загрузить. */
export interface HealthInput {
  diag: Diagnostics | null;
  health?: Health | null;
  nodes?: NodesState | null;
  notifications?: NotificationsInfo | null;
  connections?: ConnectionsResponse | null;
  update?: UpdateInfo | null;
  problems: SystemProblem[];
  aiKeys?: boolean | null;
  canTest?: boolean;
  now: number;
}

const DAY = 86_400_000;
const RANK: Record<Tone, number> = { error: 0, warn: 1, ok: 2, off: 3 };

export function nodesSummary(nodes: NodeRow[]): { total: number; responding: number; silent: number; disabled: number } {
  const disabled = nodes.filter((n) => n.disabled).length;
  const responding = nodes.filter((n) => !n.disabled && n.online).length;
  return { total: nodes.length, responding, silent: nodes.length - disabled - responding, disabled };
}

/** Сводка словами: «3 из 5 отвечают, 1 выключен». */
export function serversWords(nodes: NodeRow[]): string {
  const s = nodesSummary(nodes);
  if (s.total === 0) return tr('system.servers.none');
  const head = tr('system.servers.summary', { ok: s.responding, total: s.total, verb: trn('system.servers.respond', s.responding) });
  return s.disabled > 0 ? `${head}, ${tr('system.servers.disabledCount', { n: s.disabled, word: trn('system.servers.disabledWord', s.disabled) })}` : head;
}

/** Вид задачи словами; незнакомый вид — общая фраза, сырое имя на экран не идёт. */
export function jobKindWords(kind: string): string {
  switch (kind) {
    case 'mine': return tr('system.job.mine');
    case 'auto-learn': return tr('system.job.learn');
    default: return tr('system.job.other');
  }
}

const CHECK_TITLE: Record<CheckId, string> = {
  app: 'system.check.app', database: 'system.check.database', bot: 'system.check.bot', business: 'system.check.business',
  bedolaga: 'system.check.bedolaga', minishop: 'system.check.minishop', remnawave: 'system.check.remnawave',
  notifications: 'system.check.notifications', model: 'system.check.model', servers: 'system.check.servers',
  kb: 'system.check.kb', jobs: 'system.check.jobs', update: 'system.check.update',
};

function checkOf(id: CheckId, tone: Tone, summary: string, extra: Partial<Check> = {}): Check {
  return { id, tone, title: tr(CHECK_TITLE[id] as 'system.check.app'), summary, details: [], ...extra };
}

function detail(label: string, value: string): { label: string; value: string } { return { label, value }; }

function serversCheck(nodes: NodesState | null | undefined, enabled: boolean): Check | null {
  if (nodes === undefined) return null;
  if (nodes === null) return checkOf('servers', 'warn', tr('system.cannotCheck'), { link: 'servers', issue: tr('system.servers.errorIssue') });
  if (nodes.kind === 'off') return checkOf('servers', 'off', tr('system.servers.offShort'), { link: 'servers' });
  if (nodes.kind === 'error') return checkOf('servers', 'warn', tr('system.cannotCheckReason', { reason: nodes.message }), { link: 'servers', issue: tr('system.servers.errorIssue') });
  void enabled;
  const list = nodes.snapshot.nodes;
  const s = nodesSummary(list);
  const names = list.filter((n) => !n.disabled && !n.online).map((n) => n.name);
  const tone: Tone = nodes.snapshot.error ? 'warn' : s.silent === 0 ? 'ok' : s.responding === 0 ? 'error' : 'warn';
  const issue = s.silent > 0
    ? problemText({ code: 'nodes_offline', severity: 'warn', count: s.silent, subject: names[0] ?? null, at: null })
    : nodes.snapshot.error ? tr('system.servers.errorIssue') : undefined;
  return checkOf('servers', tone, serversWords(list), {
    link: 'servers', ...(issue ? { issue } : {}),
    details: [detail(tr('system.servers.dataAt'), clock(nodes.snapshot.at)), ...(names.length ? [detail(tr('system.servers.silentList'), names.join(', '))] : [])],
  });
}

/** Проверки в порядке показа: красное, потом янтарное, потом остальное; внутри — как собраны. */
export function sortChecks(checks: Check[]): Check[] {
  return checks.map((check, index) => ({ check, index }))
    .sort((a, b) => RANK[a.check.tone] - RANK[b.check.tone] || a.index - b.index)
    .map((entry) => entry.check);
}

const PROBLEM_CHECK: Record<SystemProblem['code'], CheckId> = {
  nodes_offline: 'servers', nodes_error: 'servers', update_failed: 'update', job_failed: 'jobs',
};

export function buildChecks(input: HealthInput): Check[] {
  const { diag, health, now } = input;
  const checks: Check[] = [];
  if (diag) {
    const app = diag.application;
    checks.push(checkOf('app', 'ok', tr('system.app.summary', { version: app.version, memory: memoryWords(app.memory.rss) }), {
      details: [detail(tr('system.app.versionLabel'), app.version), detail(tr('system.app.memoryLabel'), bytesWords(app.memory.rss)), detail(tr('system.app.uptimeLabel'), duration(app.uptime * 1000))],
    }));
    const intact = String(diag.database.integrity) === 'ok';
    checks.push(checkOf('database', intact ? 'ok' : 'error', intact ? tr('system.db.ok') : tr('system.db.bad'), {
      ...(intact ? {} : { issue: tr('system.db.badIssue') }),
      details: [detail(tr('system.db.schema'), tr('system.db.schemaValue', { n: diag.database.schema }))],
    }));
    const tgBot = diag.channels.tg_bot === true;
    checks.push(checkOf('bot', tgBot ? 'ok' : 'off', tgBot ? tr('system.bot.on') : tr('system.off')));
    const tgDm = diag.channels.tg_dm === true;
    const linked = health ? health.businessConnection : null;
    checks.push(checkOf('business', !tgDm ? 'off' : linked === false ? 'warn' : 'ok',
      !tgDm ? tr('system.off') : linked === false ? tr('system.business.noLink') : tr('system.business.on'), {
        ...(tgDm && linked === false ? { issue: tr('system.business.noLinkIssue') } : {}),
        details: [detail(tr('system.business.linkLabel'), linked === null ? tr('system.unknown') : linked ? tr('system.yes') : tr('system.no'))],
      }));
    for (const id of ['bedolaga', 'minishop'] as const) {
      const on = diag.channels[id] === true || diag.integrations[id] === true;
      const raw = health ? (id === 'bedolaga' ? health.lastBedolagaPoll : health.lastMinishopPoll) : diag.cursors[id];
      const at = pollTime(raw ?? diag.cursors[id]);
      checks.push(checkOf(id, on ? 'ok' : 'off', !on ? tr('system.off') : at ? tr('system.poll.at', { time: clock(at) }) : tr('system.poll.none'), {
        details: [detail(tr('system.poll.label'), at ? fullDate(at) : tr('system.poll.none'))],
      }));
    }
    if (input.connections !== undefined || diag.integrations.remnawave !== undefined) {
      const on = diag.integrations.remnawave === true;
      const panels = input.connections?.remnawave ?? [];
      const readOnly = panels.length > 0 ? panels.every((p) => p.readOnly) : null;
      const access = readOnly === null ? tr('system.unknown') : readOnly ? tr('system.rw.readOnly') : tr('system.rw.write');
      checks.push(checkOf('remnawave', on ? (readOnly === false ? 'warn' : 'ok') : 'off',
        !on ? tr('system.off') : readOnly === null ? tr('system.rw.on') : tr('system.rw.onAccess', { access }), {
          details: [detail(tr('system.rw.accessLabel'), access)],
        }));
    }
    const failedJobs = diag.database.jobs.filter((job) => job.status === 'failed' && (job.ended_at ?? job.started_at) > now - DAY);
    checks.push(checkOf('jobs', failedJobs.length ? 'warn' : 'ok',
      failedJobs.length ? tr('system.jobs.failed', { kind: jobKindWords(failedJobs[0]!.kind) }) : tr('system.jobs.ok'), {
        ...(failedJobs.length ? { issue: tr('system.jobs.failedIssue', { kind: jobKindWords(failedJobs[0]!.kind) }) } : {}),
        details: failedJobs.slice(0, 3).map((job) => detail(jobKindWords(job.kind), job.error ?? tr('system.jobs.noReason'))),
      }));
    const kb = health?.kb ?? diag.kb;
    checks.push(checkOf('kb', kb > 0 ? 'ok' : 'warn', kb > 0 ? tr('system.kb.count', { n: kb, word: trn('system.kb.word', kb) }) : tr('system.kb.empty'),
      kb > 0 ? {} : { issue: tr('system.kb.emptyIssue') }));
  }
  if (input.notifications !== undefined) {
    const n = input.notifications;
    if (n === null) checks.push(checkOf('notifications', 'warn', tr('system.cannotCheck'), { link: 'notifications' }));
    else checks.push(checkOf('notifications', !n.configured ? 'off' : n.lastError ? 'error' : 'ok',
      !n.configured ? tr('system.notify.unset') : n.lastError ? tr('system.notify.error', { reason: n.lastError }) : tr('system.notify.ok'), {
        link: 'notifications', test: n.configured && input.canTest === true,
        ...(n.lastError ? { issue: tr('system.notify.errorIssue') } : {}),
      }));
  }
  if (input.aiKeys !== undefined && input.aiKeys !== null) {
    checks.push(checkOf('model', input.aiKeys ? 'ok' : 'warn', input.aiKeys ? tr('system.model.ok') : tr('system.model.noKey'),
      input.aiKeys ? {} : { issue: tr('system.model.noKeyIssue') }));
  }
  const servers = serversCheck(input.nodes, diag?.integrations.nodes === true);
  if (servers) checks.push(servers);

  // Сигналы сервера (`problems`) поднимают тон соответствующей проверки или добавляют свою.
  for (const problem of input.problems) {
    const id = PROBLEM_CHECK[problem.code] ?? 'jobs';
    const found = checks.find((c) => c.id === id);
    const text = problemText(problem);
    if (!found) {
      checks.push(checkOf(id, problem.severity, text, { issue: text, ...(id === 'update' ? { link: 'update' as const } : id === 'servers' ? { link: 'servers' as const } : {}) }));
    } else if (RANK[problem.severity] < RANK[found.tone] || found.tone === 'ok' || found.tone === 'off') {
      found.tone = problem.severity;
      found.issue ??= text;
    }
  }
  return sortChecks(checks);
}

export type VerdictLevel = 'ok' | 'check' | 'fail';
export interface Verdict { level: VerdictLevel; count: number; title: string; text: string }

/** Вердикт одной фразой и вторая строка (6.9). */
export function verdictOf(checks: Check[]): Verdict {
  const errors = checks.filter((c) => c.tone === 'error');
  const bad = checks.filter((c) => c.tone === 'error' || c.tone === 'warn');
  if (errors.length > 0) {
    return { level: 'fail', count: bad.length, title: tr('system.verdict.fail'), text: issuesLine(bad) };
  }
  if (bad.length > 0) {
    return { level: 'check', count: bad.length, title: tr('system.verdict.check', { n: bad.length }), text: issuesLine(bad) };
  }
  return { level: 'ok', count: 0, title: tr('system.verdict.ok'), text: tr('system.verdict.okText') };
}

function issuesLine(bad: Check[]): string {
  const lines = bad.map((c) => c.issue ?? `${c.title}: ${c.summary}`).map((s) => (/[.!?]$/.test(s) ? s : `${s}.`));
  return lines.join(' ');
}

/** Куда ведёт «Подробнее» у вердикта: вкладка первой неполадки или никуда. */
export function verdictTarget(checks: Check[]): 'servers' | 'update' | 'notifications' | undefined {
  return checks.find((c) => (c.tone === 'error' || c.tone === 'warn') && c.link)?.link;
}

/* ---------- Настройки поверх файла настроек ---------- */

const OVERRIDE_LABEL: Record<string, string> = {
  aiMode: 'system.setting.aiMode', minConfidence: 'system.setting.minConfidence', autoPerHour: 'system.setting.autoPerHour',
  humanHoldMinutes: 'system.setting.humanHoldMinutes', maxAgeMinutes: 'system.setting.maxAgeMinutes',
  slaFirstResponseMinutes: 'system.setting.slaFirstResponseMinutes', brand: 'system.setting.brand',
  handoffRepeatMinutes: 'system.setting.handoffRepeatMinutes', notifyLevel: 'system.setting.notifyLevel', model: 'system.setting.model',
  fallbackModel: 'system.setting.fallbackModel', modelKey: 'system.setting.modelKey', fallbackKey: 'system.setting.fallbackKey',
  requireKb: 'system.setting.requireKb', autoLearn: 'system.setting.autoLearn',
};

export function overrideRows(list: Diagnostics['settingOverrides']): Array<{ key: string; label: string; value: string }> {
  return list.map((item) => {
    const labelKey = OVERRIDE_LABEL[item.key];
    const value = typeof item.value === 'boolean' ? (item.value ? tr('system.yes') : tr('system.no'))
      : typeof item.value === 'object' ? tr('system.setting.custom') : String(item.value);
    return { key: item.key, label: labelKey ? tr(labelKey as 'system.setting.aiMode') : tr('system.setting.other'), value };
  });
}

const COUNT_LABEL: Record<string, string> = {
  conversation: 'system.count.conversation', message: 'system.count.message', customer_profile: 'system.count.customer_profile',
  kb_doc: 'system.count.kb_doc', kb_candidate: 'system.count.kb_candidate', audit_log: 'system.count.audit_log',
};

export function countRows(counts: Record<string, number>): Array<{ key: string; label: string; value: number }> {
  return Object.entries(counts).map(([key, value]) => ({ key, value, label: COUNT_LABEL[key] ? tr(COUNT_LABEL[key] as 'system.count.message') : tr('system.setting.other') }));
}

/* ---------- Серверы ---------- */

/** Название страны по коду; нет кода — пусто. */
export function countryName(code: string | undefined): string {
  if (!code) return '';
  try { return new Intl.DisplayNames(['ru'], { type: 'region' }).of(code.toUpperCase()) ?? code; } catch { return code; }
}

export function nodeState(node: NodeRow): 'online' | 'offline' | 'disabled' {
  return node.disabled ? 'disabled' : node.online ? 'online' : 'offline';
}

export function nodeStateWords(node: NodeRow): string {
  const state = nodeState(node);
  return state === 'online' ? tr('system.node.online') : state === 'offline' ? tr('system.node.offline') : tr('system.node.disabled');
}

/** Серверы для списка: не отвечающие сверху, выключенные внизу. */
export function sortNodes(nodes: NodeRow[]): NodeRow[] {
  const order = { offline: 0, online: 1, disabled: 2 } as const;
  return nodes.map((node, index) => ({ node, index }))
    .sort((a, b) => order[nodeState(a.node)] - order[nodeState(b.node)] || a.index - b.index).map((e) => e.node);
}

/** Ключ имени «для помощника»: aliasKey, иначе внутреннее имя (контракт POST /api/nodes/alias). */
export function aliasName(node: NodeRow): string {
  return node.aliasKey ?? node.rawName;
}

/* ---------- Обновление ---------- */

/** Список изменений из markdown: простой текст пунктами, без разметки и без HTML. */
export function parseChangelog(markdown: string | null | undefined): string[] {
  if (!markdown) return [];
  const items: string[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^(-{3,}|\*{3,}|={3,})$/.test(line)) continue;
    const text = line.replace(/^([-*+]|\d+[.)])\s+/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '').replace(/(\*\*|__|`|~~)/g, '').replace(/(^|\s)[*_](\S[^*_]*)[*_](?=\s|$)/g, '$1$2').trim();
    if (text) items.push(text);
  }
  return items;
}

export const STEPS = ['queued', 'backing_up', 'installing', 'checking'] as const;
export type StepId = (typeof STEPS)[number];
export type StepState = 'done' | 'current' | 'todo';

/** Подпись состояния операции: «Копия», «Готово», «Вернули как было». */
export function statusWords(status: string): string {
  switch (status) {
    case 'queued': return tr('system.step.queued');
    case 'backing_up': return tr('system.step.backing_up');
    case 'installing': return tr('system.step.installing');
    case 'checking': return tr('system.step.checking');
    case 'completed': return tr('system.step.completed');
    case 'rolled_back': return tr('system.step.rolled_back');
    case 'failed': return tr('system.step.failed');
    default: return tr('system.step.unknown');
  }
}

export function isFinal(status: UpdateStatus | string | undefined): boolean {
  return status === 'completed' || status === 'rolled_back' || status === 'failed';
}

/** Шаги хода: пройденные, текущий, оставшиеся. После конца — все пройдены (или вернули как было). */
export function stepStates(progress: UpdateProgress | null): Array<{ id: StepId; label: string; state: StepState }> {
  const status = progress?.status;
  const at = status ? STEPS.indexOf(status as StepId) : -1;
  return STEPS.map((id, index) => ({
    id, label: statusWords(id),
    state: status === 'completed' ? 'done' : isFinal(status) ? (index < Math.max(at, 0) ? 'done' : 'todo') : index < at ? 'done' : index === at ? 'current' : 'todo',
  }));
}

/** Действие в истории: «Обновление» / «Откат». */
export function actionWords(action: string): string {
  return action === 'rollback' ? tr('system.action.rollback') : tr('system.action.update');
}

export function historyRows(history: HistoryRow[] | undefined): Array<{ id: number; text: string; status: string; at: string }> {
  return (history ?? []).map((row) => ({
    id: row.id,
    text: row.version ? tr('system.history.line', { action: actionWords(row.action), version: row.version }) : actionWords(row.action),
    status: statusWords(row.status),
    at: fullDate(row.created_at),
  }));
}

/** Текущее состояние кнопок обновления. */
export function updateHeadline(info: UpdateInfo): string {
  return info.available && info.latest
    ? tr('system.update.headline', { current: info.current, latest: info.latest })
    : tr('system.update.latest', { current: info.current });
}

/* ---------- Уведомления ---------- */

export const NOTIFY_LEVELS: readonly NotifyLevel[] = ['all', 'important', 'minimal'];

export function levelLabel(level: NotifyLevel): string {
  return level === 'all' ? tr('system.level.all') : level === 'important' ? tr('system.level.important') : tr('system.level.minimal');
}
export function levelHint(level: NotifyLevel): string {
  return level === 'all' ? tr('system.level.all.hint') : level === 'important' ? tr('system.level.important.hint') : tr('system.level.minimal.hint');
}
