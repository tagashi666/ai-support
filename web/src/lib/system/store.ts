/**
 * «Система» на живых данных (6.9): проверки здоровья, серверы, обновление и
 * уведомления. Каждый блок грузится сам и падает сам: ошибка одного не роняет
 * остальные. Права — из bootstrap (`can`).
 */
import { computed, signal } from '@preact/signals';
import { tr } from '@/i18n/sections/system';
import { can } from '@/lib/assistant/store';
import { showToast, undoToast } from '@/lib/actions/toasts';
import { ApiError, getJson, readToken, sendJson } from '@/lib/live/api';
import { announceUpdated, bootstrap } from '@/lib/live/store';
import type { ConnectionsResponse } from '@shared/api-types';
import type { Diagnostics, Health, NodesState, NodesSnapshot, NotificationsInfo, NotifyLevel, UpdateInfo } from './model';

export type Load<T> = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T };

export const rights = computed(() => ({
  diagnostics: can('diagnostics:read'),
  read: can('settings:read'),
  /** Серверы: чтение — settings:read и опрос включён в сборке. */
  servers: can('settings:read') && bootstrap.value?.capabilities.nodes !== false,
  editNodes: can('settings:nodes'),
  update: can('settings:update'),
  alerts: can('settings:alerts'),
  level: can('setting:notifyLevel'),
}));

export const reason = (err: unknown): string => (err instanceof ApiError || err instanceof Error ? err.message : String(err));
const token = (): string => readToken() ?? '';

/* ---------- Здоровье ---------- */

export const diag = signal<Load<Diagnostics>>({ state: 'idle' });
export const health = signal<Health | null | undefined>(undefined);
export const connections = signal<ConnectionsResponse | null | undefined>(undefined);
export const checkedAt = signal<number | null>(null);

export async function loadHealth(): Promise<void> {
  const r = rights.peek();
  if (!r.diagnostics) return;
  diag.value = { state: 'loading' };
  const safe = async <T,>(allowed: boolean, path: string): Promise<T | null | undefined> => {
    if (!allowed) return undefined;
    try { return await getJson<T>(path, token()); } catch { return null; }
  };
  const [d, h, c] = await Promise.all([
    getJson<Diagnostics>('/api/diagnostics', token()).then((data) => ({ data }), (err: unknown) => ({ err })),
    safe<Health>(can('conversation:read'), '/api/health'),
    safe<ConnectionsResponse>(r.read, '/api/connections'),
    loadNotifications(),
    r.servers ? loadNodes() : Promise.resolve(),
    r.update ? loadUpdate() : Promise.resolve(),
  ]);
  health.value = h;
  connections.value = c;
  checkedAt.value = Date.now();
  diag.value = 'data' in d ? { state: 'ready', data: d.data } : { state: 'error', message: reason(d.err) };
}

/* ---------- Серверы ---------- */

export const nodes = signal<NodesState | null | undefined>(undefined);

function nodesFrom(err: unknown): NodesState {
  return err instanceof ApiError && err.status === 501 ? { kind: 'off', message: err.message } : { kind: 'error', message: reason(err) };
}

export async function loadNodes(): Promise<void> {
  if (!rights.peek().servers) return;
  try { nodes.value = { kind: 'ok', snapshot: await getJson<NodesSnapshot>('/api/nodes', token()) }; } catch (err) { nodes.value = nodesFrom(err); }
}

/** «Обновить»: свежий опрос панели, потом список с псевдонимами. */
export async function refreshNodes(): Promise<void> {
  try {
    await sendJson<NodesSnapshot>('/api/nodes/refresh', token(), {});
    await loadNodes();
  } catch (err) {
    showToast({ text: tr('system.servers.refreshFailed', { reason: reason(err) }), kind: 'error', ttl: null });
  }
}

export async function saveAlias(name: string, alias: string): Promise<void> {
  await sendJson<{ ok: boolean }>('/api/nodes/alias', token(), { name, alias: alias.trim() });
  const current = nodes.value;
  if (current?.kind === 'ok') {
    nodes.value = { kind: 'ok', snapshot: { ...current.snapshot, nodes: current.snapshot.nodes.map((n) => ((n.aliasKey ?? n.rawName) === name ? { ...n, alias: alias.trim() || null } : n)) } };
  }
}

/* ---------- Обновление ---------- */

export const update = signal<Load<UpdateInfo>>({ state: 'idle' });
let sawRun = false;

export async function loadUpdate(force = false): Promise<UpdateInfo | null> {
  if (!rights.peek().update) return null;
  if (update.peek().state !== 'ready') update.value = { state: 'loading' };
  try {
    const data = await getJson<UpdateInfo>(force ? '/api/update?force=1' : '/api/update', token());
    update.value = { state: 'ready', data };
    watchRun(data);
    return data;
  } catch (err) {
    // Во время установки служба перезапускается: пропавшая связь — не ошибка, опрос продолжится.
    if (!sawRun || !(err instanceof ApiError) || err.code !== 'network') update.value = { state: 'error', message: reason(err) };
    return null;
  }
}

/** Видели ход, а теперь «Готово» — сказать всем вкладкам (6.9). */
function watchRun(data: UpdateInfo): void {
  const progress = data.progress;
  if (data.queued) sawRun = true;
  if (sawRun && progress && progress.action === 'update' && progress.status === 'completed') {
    sawRun = false;
    announceUpdated(progress.version ?? data.current);
  } else if (sawRun && progress && (progress.status === 'rolled_back' || progress.status === 'failed')) sawRun = false;
}

export async function requestUpdate(action: 'update' | 'rollback', force = false): Promise<boolean> {
  try {
    const res = await sendJson<{ ok: boolean; update: UpdateInfo }>('/api/update/request', token(), force ? { action, force: true } : { action });
    sawRun = true;
    const prev = update.peek();
    update.value = { state: 'ready', data: { ...(prev.state === 'ready' ? prev.data : {}), ...res.update } as UpdateInfo };
    return true;
  } catch (err) {
    showToast({ text: tr('system.update.requestFailed', { reason: reason(err) }), kind: 'error', ttl: null });
    return false;
  }
}

/* ---------- Уведомления ---------- */

export const notifications = signal<NotificationsInfo | null | undefined>(undefined);

export async function loadNotifications(): Promise<void> {
  if (!rights.peek().read) return;
  try { notifications.value = await getJson<NotificationsInfo>('/api/system/notifications', token()); } catch { notifications.value = null; }
}

async function postLevel(level: NotifyLevel): Promise<void> {
  await sendJson<{ ok: boolean }>('/api/settings', token(), { notifyLevel: level });
  const info = notifications.peek();
  if (info) notifications.value = { ...info, level };
}

/** Уровень применяется сразу; «Отменить» в тосте возвращает прежний (ярус 0). */
export async function changeLevel(next: NotifyLevel, labelOf: (level: NotifyLevel) => string): Promise<void> {
  const prev = notifications.peek()?.level;
  if (!prev || prev === next) return;
  try {
    await postLevel(next);
  } catch (err) {
    showToast({ text: tr('system.notify.levelFailed', { reason: reason(err) }), kind: 'error', ttl: null });
    return;
  }
  undoToast(tr('system.notify.levelDone', { level: labelOf(next) }), () => {
    postLevel(prev).catch((err: unknown) => showToast({ text: tr('system.notify.levelFailed', { reason: reason(err) }), kind: 'error', ttl: null }));
  }, tr('system.undo'));
}

/** «Отправить тест»: итог словами, причина — при сбое. */
export async function sendTestAlert(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await sendJson<{ ok: boolean }>('/api/settings/test-alert', token(), {});
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof ApiError && err.status === 501 ? tr('system.notify.testUnset') : reason(err) };
  }
}
