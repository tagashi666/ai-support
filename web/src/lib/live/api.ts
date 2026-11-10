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

async function parseError(response: Response): Promise<ApiError> {
  const body = await response.json().catch(() => ({})) as Partial<ApiErrorBody>;
  const code = body.code ?? (response.status === 401 ? 'unauthorized' : response.status === 403 ? 'permission'
    : response.status === 429 ? 'rate_limited' : response.status >= 502 ? 'upstream' : 'unknown');
  return new ApiError(response.status, code, body.error ?? `HTTP ${response.status}`);
}

/**
 * Изменяющий запрос с ключом. `keepalive` — запрос уйдёт, даже если вкладку
 * закрывают (отложенная фиксация и окно отмены, 7.6 и 6.3.5).
 */
export async function sendJson<T>(path: string, token: string, body: unknown, options: { keepalive?: boolean; fetcher?: Fetch; method?: 'POST' | 'DELETE' | 'PUT' } = {}): Promise<T> {
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(path, {
      method: options.method ?? 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      ...(options.keepalive ? { keepalive: true } : {}),
    });
  } catch (err) {
    throw new ApiError(0, 'network', err instanceof Error ? err.message : String(err));
  }
  if (response.ok) return await response.json().catch(() => ({})) as T;
  throw await parseError(response);
}

/** Загрузка одного файла сырым телом, как у классики (заголовки x-file-*). */
export async function uploadFile<T>(path: string, token: string, file: Blob & { name?: string }, headers: Record<string, string>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        // Только этот тип сервер принимает потоком с пределом 45 МБ (server.ts);
        // octet-stream разбирается буфером до 1 МБ и ломал загрузку (ошибка этапа 3а).
        'content-type': 'application/vnd.ai-support.attachment',
        'x-file-name': encodeURIComponent(file.name ?? 'file'),
        'x-file-type': encodeURIComponent(file.type || 'application/octet-stream'),
        ...headers,
      },
      body: file,
    });
  } catch (err) {
    throw new ApiError(0, 'network', err instanceof Error ? err.message : String(err));
  }
  if (response.ok) return await response.json() as T;
  throw await parseError(response);
}

/** Новый id для повтора без дубля (10.3 п.2). */
export function newClientId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `cm-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
