/**
 * «Подключения» на живых данных (6.11): список без сети (/api/connections),
 * профиль «Как мы представляемся», мастер с ходом на экране, папки с окном отмены.
 */
import { computed, signal } from '@preact/signals';
import { tr } from '@/i18n/sections/connections';
import { can } from '@/lib/assistant/store';
import { showToast, undoToast, UNDO_MS } from '@/lib/actions/toasts';
import { ApiError, getJson, readToken, sendJson } from '@/lib/live/api';
import { bootstrap } from '@/lib/live/store';
import { deferred } from '@/lib/workspace/deferred';
import type { BootstrapResponse, ConnectionsResponse } from '@shared/api-types';
import { isFinished, runStep, type Profile } from './model';

export type Folder = BootstrapResponse['folders'][number];
export interface InboxMeta {
  sources: Array<{ id: string; kind: string; name: string; enabled: boolean }>;
  folders: Folder[];
}

export type Load = 'idle' | 'loading' | 'ready' | 'error';

/** Что можно этому человеку (6.11, состояния). */
export const rights = computed(() => ({
  read: can('settings:read'),
  sources: can('settings:sources'),
  services: can('settings:services'),
}));

const token = (): string => readToken() ?? '';
const reasonOf = (err: unknown): string => (err instanceof ApiError && err.code === 'network' ? tr('connections.error.network') : err instanceof Error ? err.message : String(err));

// --- каналы и источники ---------------------------------------------------

export const connections = signal<ConnectionsResponse | null>(null);
export const connectionsState = signal<Load>('idle');
export const connectionsError = signal('');

export async function loadConnections(): Promise<ConnectionsResponse | null> {
  if (!rights.value.read) return null;
  connectionsState.value = connections.peek() ? 'ready' : 'loading';
  try {
    const data = await getJson<ConnectionsResponse>('/api/connections', token());
    connections.value = data;
    connectionsState.value = 'ready';
    return data;
  } catch (err) {
    connectionsError.value = reasonOf(err);
    connectionsState.value = connections.peek() ? 'ready' : 'error';
    return null;
  }
}

/** Сохранить «Как мы представляемся»; ошибка — строкой для поля. */
export async function saveProfile(sourceId: string, profile: Profile): Promise<string | null> {
  try {
    const result = await sendJson<{ ok: boolean; serviceProfiles?: ConnectionsResponse['serviceProfiles'] }>(
      `/api/settings/services/${encodeURIComponent(sourceId)}`, token(),
      { serviceName: profile.serviceName.trim(), greetingMessage: profile.greetingMessage.trim(), handoffMessage: profile.handoffMessage.trim() },
    );
    const current = connections.peek();
    if (current) {
      connections.value = { ...current, serviceProfiles: result.serviceProfiles ?? {
        ...current.serviceProfiles,
        [sourceId]: { sourceId, serviceName: profile.serviceName.trim(), greetingMessage: profile.greetingMessage.trim(), handoffMessage: profile.handoffMessage.trim() },
      } };
    }
    return null;
  } catch (err) {
    return reasonOf(err);
  }
}

// --- мастер ---------------------------------------------------------------

export interface Run {
  /** sending — запрос ушёл; running — идёт цепочка; done / failed — итог. */
  phase: 'sending' | 'running' | 'done' | 'failed';
  name: string;
  /** Номер шага хода (0..4). */
  step: number;
  detail: string;
}

export const run = signal<Run | null>(null);
let timer: number | undefined;
let startedAt = 0;
const GIVE_UP_MS = 3 * 60_000;

function stopPolling(): void {
  window.clearInterval(timer);
  timer = undefined;
}

async function poll(): Promise<void> {
  const current = run.peek();
  if (!current || (current.phase !== 'running' && current.phase !== 'sending')) { stopPolling(); return; }
  try {
    const status = await getJson<{ queued: boolean; progress: { status: string; name?: string; detail?: string } | null }>('/api/sources/status', token());
    const progress = status.progress;
    // Чужой или прежний итог (другое название) пропускаем: ждём своего.
    if (progress && progress.name === current.name) {
      const step = runStep(progress.status);
      if (progress.status === 'completed') {
        stopPolling();
        run.value = { ...current, phase: 'done', step: 4, detail: '' };
        void loadConnections();
        void loadMeta();
        return;
      }
      if (isFinished(progress.status)) {
        stopPolling();
        run.value = { ...current, phase: 'failed', step: current.step, detail: progress.detail ?? '' };
        return;
      }
      if (step !== null) run.value = { ...current, phase: 'running', step: Math.max(current.step, step) };
    }
  } catch {
    // Связи нет в этот миг — опрос продолжится, пока не истечёт срок.
  }
  if (Date.now() - startedAt > GIVE_UP_MS && run.peek()?.phase !== 'done') {
    stopPolling();
    run.value = { ...current, phase: 'failed', detail: tr('connections.run.timeout') };
  }
}

/** Отправить запрос на подключение и следить за ходом раз в секунду. null — запрос принят; строка — ошибка у кнопки (409 и др.). */
export async function startRun(body: Record<string, unknown>): Promise<string | null> {
  const name = String(body.name ?? '');
  try {
    await sendJson('/api/sources/request', token(), body);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) return tr('connections.error.busy');
    return reasonOf(err);
  }
  startedAt = Date.now();
  run.value = { phase: 'running', name, step: 0, detail: '' };
  stopPolling();
  timer = window.setInterval(() => { void poll(); }, 1000);
  void poll();
  return null;
}

export function clearRun(): void {
  stopPolling();
  run.value = null;
}

// --- папки ----------------------------------------------------------------

export const meta = signal<InboxMeta | null>(null);
export const metaState = signal<Load>('idle');
export const metaError = signal('');
/** Папки, удаление которых ждёт окна отмены: из списка уже убраны. */
const held = signal<ReadonlySet<number>>(new Set());
export const folders = computed(() => (meta.value?.folders ?? []).filter((folder) => !held.value.has(folder.id)));

export async function loadMeta(): Promise<void> {
  if (!rights.value.sources) return;
  metaState.value = meta.peek() ? 'ready' : 'loading';
  try {
    meta.value = await getJson<InboxMeta>('/api/inbox/meta', token());
    metaState.value = 'ready';
  } catch (err) {
    metaError.value = reasonOf(err);
    metaState.value = meta.peek() ? 'ready' : 'error';
  }
}

function adopt(next: Folder[]): void {
  const current = meta.peek();
  if (current) meta.value = { ...current, folders: next };
  const boot = bootstrap.peek();
  if (boot) bootstrap.value = { ...boot, folders: next };
}

/** Создать или изменить папку; ошибка — строкой для поля. */
export async function saveFolder(input: { id?: number; name: string; color: string | null; sourceIds: string[] }): Promise<string | null> {
  try {
    const result = await sendJson<{ ok: boolean; folders: Folder[] }>('/api/inbox/folders', token(), {
      ...(input.id ? { id: input.id } : {}), name: input.name.trim(), color: input.color, sourceIds: input.sourceIds,
    });
    adopt(result.folders);
    return null;
  } catch (err) {
    return reasonOf(err);
  }
}

function hold(id: number, on: boolean): void {
  const next = new Set(held.peek());
  if (on) next.add(id); else next.delete(id);
  held.value = next;
}

/** Удаление папки (ярус 0): сразу из списка, запрос — после окна «Отменить». */
export function removeFolder(folder: Folder): void {
  hold(folder.id, true);
  deferred.schedule({
    key: `folder:${folder.id}`,
    async commit(keepalive) {
      const result = await sendJson<{ folders?: Folder[] }>(`/api/inbox/folders/${folder.id}`, token(), undefined, { method: 'DELETE', keepalive });
      if (result.folders) adopt(result.folders);
      else adopt((meta.peek()?.folders ?? []).filter((item) => item.id !== folder.id));
      hold(folder.id, false);
    },
    revert() { hold(folder.id, false); },
    failed() { showToast({ kind: 'error', ttl: null, text: tr('connections.folders.removeFailed', { name: folder.name }) }); },
  }, UNDO_MS);
  undoToast(tr('connections.folders.removed', { name: folder.name }), () => { deferred.cancel(`folder:${folder.id}`); }, tr('connections.undo'));
}
