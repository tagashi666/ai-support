/**
 * Запросы новой панели к серверу. Ключ входа общий с классикой
 * (localStorage `panelToken`): кто вошёл в классику, сразу видит живой список.
 * Ошибка приходит с кодом из единого формата (src/shared/api-types.ts).
 */
import type { ApiError as ApiErrorBody, ErrorCode } from '@shared/api-types';

const TOKEN_KEY = 'panelToken';

export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* панель работает и без хранилища */ }
}

export function clearToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* нечего чистить */ }
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode | 'network' | 'unknown', message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** GET с ключом. 401 — ApiError с кодом unauthorized; сеть — код network. */
export async function getJson<T>(path: string, token: string, fetcher: Fetch = fetch): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(path, { headers: { authorization: `Bearer ${token}` } });
  } catch (err) {
    throw new ApiError(0, 'network', err instanceof Error ? err.message : String(err));
  }
  if (response.ok) return await response.json() as T;
  const body = await response.json().catch(() => ({})) as Partial<ApiErrorBody>;
  const code = body.code ?? (response.status === 401 ? 'unauthorized' : response.status === 403 ? 'permission' : 'unknown');
  throw new ApiError(response.status, code, body.error ?? `HTTP ${response.status}`);
}
