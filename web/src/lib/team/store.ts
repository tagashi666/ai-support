/**
 * «Команда» на живых данных (6.10): люди, последняя активность, права ролей,
 * журнал. Ключ входа нового человека сюда не попадает — он живёт только в
 * состоянии листа и стирается при его закрытии.
 */
import { signal } from '@preact/signals';
import { tr } from '@/i18n/sections/team';
import { ApiError, getJson, readToken, sendJson } from '@/lib/live/api';
import type { AuditEvent } from './model';

export interface Operator {
  id: number;
  name: string;
  role: string;
  active: 0 | 1;
  created_at: number;
  updated_at: number;
}
export interface RolesData {
  catalog: Array<{ id: string; group: string; label: string }>;
  roles: Record<string, string[]>;
  defaults: Record<string, string[]>;
}
export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export const operators = signal<Operator[] | null>(null);
export const peopleState = signal<LoadState>('idle');
export const peopleError = signal('');
/** Последняя активность по ключу `op:N` (нужно право operator_stats:read). */
export const lastSeen = signal<Record<string, number | null>>({});
export const rolesData = signal<RolesData | null>(null);
export const rolesState = signal<LoadState>('idle');
export const rolesError = signal('');
export const auditEvents = signal<AuditEvent[] | null>(null);
export const auditState = signal<LoadState>('idle');
export const auditError = signal('');

const token = (): string => readToken() ?? '';

/** Причина словами: без сырых кодов сервера, но с его русским пояснением для 400. */
export function reasonOf(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'network') return tr('team.reason.network');
    if (err.status === 403) return tr('team.reason.permission');
    if (err.status === 400 || err.status === 404 || err.status === 409) return err.message;
    return tr('team.reason.generic', { code: String(err.status) });
  }
  return tr('team.reason.network');
}

export async function loadPeople(withStats: boolean): Promise<void> {
  peopleState.value = operators.peek() ? 'ready' : 'loading';
  try {
    const data = await getJson<{ operators: Operator[] }>('/api/operators', token());
    operators.value = data.operators;
    peopleState.value = 'ready';
    peopleError.value = '';
  } catch (err) {
    peopleError.value = reasonOf(err);
    peopleState.value = operators.peek() ? 'ready' : 'error';
    return;
  }
  if (!withStats) return;
  try {
    const stats = await getJson<{ operators: Array<{ key: string; last_activity_at: number | null }> }>('/api/operator-stats?days=365', token());
    lastSeen.value = Object.fromEntries(stats.operators.map((row) => [row.key, row.last_activity_at]));
  } catch { /* «последняя активность» — приятное дополнение, список важнее */ }
}

export async function loadRoles(): Promise<void> {
  rolesState.value = rolesData.peek() ? 'ready' : 'loading';
  try {
    rolesData.value = await getJson<RolesData>('/api/roles', token());
    rolesState.value = 'ready';
    rolesError.value = '';
  } catch (err) {
    rolesError.value = reasonOf(err);
    rolesState.value = rolesData.peek() ? 'ready' : 'error';
  }
}

export async function loadAudit(): Promise<void> {
  auditState.value = auditEvents.peek() ? 'ready' : 'loading';
  try {
    const data = await getJson<{ events: AuditEvent[] }>('/api/audit?limit=500', token());
    auditEvents.value = data.events;
    auditState.value = 'ready';
    auditError.value = '';
  } catch (err) {
    auditError.value = reasonOf(err);
    auditState.value = auditEvents.peek() ? 'ready' : 'error';
  }
}

export type Done<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

export async function createOperator(name: string, role: string): Promise<Done<{ token: string; operator: Operator }>> {
  try {
    const data = await sendJson<{ token: string; operator: Operator }>('/api/operators', token(), { name, role });
    void loadPeople(false);
    return { ok: true, token: data.token, operator: data.operator };
  } catch (err) {
    return { ok: false, error: reasonOf(err) };
  }
}

export async function rotateKey(id: number): Promise<Done<{ token: string }>> {
  try {
    const data = await sendJson<{ token: string }>(`/api/operators/${id}`, token(), { rotate: true });
    return { ok: true, token: data.token };
  } catch (err) {
    return { ok: false, error: reasonOf(err) };
  }
}

export async function setActive(id: number, active: boolean): Promise<Done> {
  try {
    await sendJson(`/api/operators/${id}`, token(), { active });
    await loadPeople(false);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: reasonOf(err) };
  }
}

export async function setRole(id: number, role: string): Promise<Done> {
  try {
    await sendJson(`/api/operators/${id}`, token(), { role });
    await loadPeople(false);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: reasonOf(err) };
  }
}

export async function saveRole(role: string, permissions: string[]): Promise<Done<{ permissions: string[] }>> {
  try {
    const data = await sendJson<{ permissions: string[] }>(`/api/roles/${role}`, token(), { permissions }, { method: 'PUT' });
    const current = rolesData.peek();
    if (current) rolesData.value = { ...current, roles: { ...current.roles, [role]: data.permissions } };
    return { ok: true, permissions: data.permissions };
  } catch (err) {
    return { ok: false, error: reasonOf(err) };
  }
}
