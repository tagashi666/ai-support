/**
 * Данные панели «Клиент» на живом сервере. Блоки грузятся и ошибаются по
 * отдельности (6.4): сбой Bedolaga не ломает подписку Remnawave и профиль.
 * Ответ для уже закрытого диалога в панель другого диалога не попадает.
 */
import { signal, type Signal } from '@preact/signals';
import { ApiError, getJson, readToken, sendJson } from '@/lib/live/api';
import type { BedolagaResponse, CustomerResponse, SubscriptionResponse, UnifiedProfile } from './types';

export type Block<T> =
  | { state: 'loading' }
  | { state: 'ready'; data: T }
  /** none — источник не подключён (501) или нет права: блока нет вовсе. */
  | { state: 'none' }
  | { state: 'error'; status: number; message: string };

export interface ClientData {
  customer: Block<CustomerResponse>;
  profile: Block<UnifiedProfile>;
  subscription: Block<SubscriptionResponse>;
  bedolaga: Block<BedolagaResponse>;
}

const empty = (): ClientData => ({ customer: { state: 'loading' }, profile: { state: 'loading' }, subscription: { state: 'loading' }, bedolaga: { state: 'loading' } });

/** Данные по диалогам: панель открывается снова — показываем последнее известное и тихо обновляем. */
export const clientData: Signal<Map<number, ClientData>> = signal(new Map());

const token = (): string => readToken() ?? '';

function put<K extends keyof ClientData>(id: number, key: K, value: ClientData[K]): void {
  const next = new Map(clientData.peek());
  next.set(id, { ...(next.get(id) ?? empty()), [key]: value });
  clientData.value = next;
}

function failed<T>(err: unknown): Block<T> {
  if (err instanceof ApiError) {
    if (err.status === 501 || err.status === 403) return { state: 'none' };
    return { state: 'error', status: err.status, message: err.message };
  }
  return { state: 'error', status: 0, message: String(err) };
}

async function load<K extends keyof ClientData>(id: number, key: K, path: string, keepOld: boolean, unwrap?: (body: unknown) => unknown): Promise<void> {
  const current = clientData.peek().get(id)?.[key];
  if (!keepOld || !current || current.state !== 'ready') put(id, key, { state: 'loading' } as ClientData[K]);
  try {
    const body = await getJson<unknown>(path, token());
    const data = unwrap ? unwrap(body) : body;
    put(id, key, { state: 'ready', data } as ClientData[K]);
  } catch (err) {
    put(id, key, failed(err) as ClientData[K]);
  }
}

const profileOf = (body: unknown): unknown => (body as { profile: UnifiedProfile }).profile;

export interface Allowed { subscription: boolean; bedolaga: boolean }

export function loadClient(id: number, allowed: Allowed): void {
  const keep = clientData.peek().has(id);
  void load(id, 'customer', `/api/conversations/${id}/customer`, keep);
  void load(id, 'profile', `/api/conversations/${id}/profile`, keep, profileOf);
  if (allowed.subscription) void load(id, 'subscription', `/api/conversations/${id}/subscription`, keep);
  else put(id, 'subscription', { state: 'none' });
  if (allowed.bedolaga) void load(id, 'bedolaga', `/api/conversations/${id}/bedolaga/customer`, keep);
  else put(id, 'bedolaga', { state: 'none' });
}

export const reloadSubscription = (id: number): Promise<void> => load(id, 'subscription', `/api/conversations/${id}/subscription`, true);
export const reloadProfile = (id: number): Promise<void> => load(id, 'profile', `/api/conversations/${id}/profile`, true, profileOf);
export const reloadBedolaga = (id: number): Promise<void> => load(id, 'bedolaga', `/api/conversations/${id}/bedolaga/customer`, true);

/** «Обновить»: собрать карточку заново из всех источников. */
export async function refreshCustomer(id: number): Promise<void> {
  const response = await sendJson<CustomerResponse & { ok: boolean }>(`/api/conversations/${id}/customer/refresh`, token(), {});
  put(id, 'customer', { state: 'ready', data: { customer: response.customer, checkedAt: response.checkedAt ?? Date.now() } });
}

/** PATCH профиля (классика шлёт так же). */
export async function saveProfile(id: number, values: Record<string, unknown>): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/conversations/${id}/profile`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(values),
    });
  } catch (err) {
    throw new ApiError(0, 'network', String(err));
  }
  if (!response.ok) throw new ApiError(response.status, response.status === 403 ? 'permission' : 'unknown', `HTTP ${response.status}`);
  const body = await response.json() as { profile: UnifiedProfile };
  put(id, 'profile', { state: 'ready', data: body.profile });
}
