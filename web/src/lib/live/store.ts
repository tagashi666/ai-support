/**
 * Живые данные на сигналах: режим (прототип или сервер), bootstrap, список,
 * состояние связи. Кадры складываются в очередь и применяются пачкой раз в
 * кадр отрисовки (7.2): пачка событий — одна перерисовка.
 */
import { computed, signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { BootstrapResponse, EventsResponse, InboxCounts, InboxResponse, InvalidateScope, LiveFrame } from '@shared/api-types';
import { ApiError, clearToken, getJson, readToken, saveToken } from './api';
import { LiveClient, type ConnectionState, type Position } from './client';
import { applyFrames, emptyInbox, mergeSnapshot, ordered, type InboxState } from './inbox';
import { onThreadFrame, openThreadId, syncThread } from '@/lib/workspace/thread';
import { loadPresence, onCollabFrame } from '@/lib/workspace/collab';

export type Mode = 'demo' | 'live';
const MODE_KEY = 'next.mode';
const OPEN_LIMIT = 200;
/** Открытых догружаем страницами до этого числа (риск 13: установки на 200+ диалогов). */
const OPEN_MAX = 1000;
const DONE_LIMIT = 50;

function initialMode(): Mode {
  const query = new URLSearchParams(location.search);
  if (query.get('demo') === '1') return 'demo';
  if (query.get('live') === '1') return 'live';
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === 'demo' || saved === 'live') return saved === 'live' && !readToken() ? 'demo' : saved;
  } catch { /* без хранилища — по наличию ключа */ }
  return readToken() ? 'live' : 'demo';
}

export const mode = signal<Mode>(initialMode());
/** expired — сервер ответил 401: экран «Войдите снова» вместо перезагрузки страницы. */
export const session = signal<'ok' | 'expired'>('ok');
export const bootstrap = signal<BootstrapResponse | null>(null);
export const inbox = signal<InboxState>(emptyInbox());
export const connection = signal<ConnectionState>('connecting');
export const loading = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
export const loadError = signal<string | null>(null);
/** Когда данные в последний раз сверены с сервером: «данные на 14:02». */
export const syncedAt = signal<number | null>(null);
/** Права изменились во время работы (6.14). */
export const rightsChanged = signal(false);

export const liveItems = computed(() => ordered(inbox.value));
export const liveCounts = computed<InboxCounts | null>(() => inbox.value.counts);
/** «Ждут вас» — бейдж «Диалогов» (7.1 п.9). */
export const liveMine = computed(() => inbox.value.counts?.sections.mine ?? bootstrap.value?.counts.mine ?? 0);

let client: LiveClient | null = null;
/** Кадр settings (10.4 п.7): раздел «Помощник» перечитывает настройки и говорит, кто менял. */
let onSettingsFrame: ((frame: Extract<LiveFrame, { type: 'settings' }>) => void) | null = null;
export function listenSettings(listener: typeof onSettingsFrame): void { onSettingsFrame = listener; }
/** Когда сервер в последний раз прислал неполадки (кадр problems, L-3). */
export const problemsAt = signal<number | null>(null);

/**
 * L-4: открытый раздел подписан на свой scope и перечитывает себя по кадру
 * invalidate (GET с проверкой прав). Закрытые разделы ничего не грузят.
 */
const watchers = new Map<InvalidateScope, Set<{ current: () => void }>>();
export function useInvalidate(scope: InvalidateScope, reload: () => void): void {
  const ref = useRef(reload);
  ref.current = reload;
  useEffect(() => {
    const set = watchers.get(scope) ?? new Set();
    watchers.set(scope, set);
    set.add(ref);
    return () => { set.delete(ref); };
  }, [scope]);
}
function invalidate(scope: InvalidateScope): void {
  const set = watchers.get(scope);
  if (set?.size) for (const ref of set) ref.current();
  // Счётчик идей в рейке виден всегда: раздел закрыт — свежий bootstrap.
  else if (scope === 'ideas' && bootstrap.peek()?.counts.ideas != null) void loadBootstrap().catch(() => undefined);
}

let snapshotEpoch = '';
let queue: { frames: LiveFrame[]; counts?: InboxCounts }[] = [];
let scheduled = false;

const token = (): string => readToken() ?? '';

function flush(): void {
  scheduled = false;
  const batch = queue;
  queue = [];
  let state = inbox.peek();
  const stale = new Set<InvalidateScope>();
  for (const { frames, counts } of batch) {
    state = applyFrames(state, frames, counts);
    for (const frame of frames) {
      if (frame.type === 'invalidate') stale.add(frame.scope);
      if (frame.type === 'problems') {
        const current = bootstrap.peek();
        if (current) bootstrap.value = { ...current, problems: frame.problems, counts: { ...current.counts, problems: frame.problems.length } };
        problemsAt.value = frame.at;
      }
      if (frame.type !== 'settings') continue;
      const current = bootstrap.peek();
      if (current) {
        bootstrap.value = { ...current, assistant: {
          ...current.assistant, mode: frame.aiMode, minConfidence: frame.minConfidence,
          ...(frame.pause !== undefined ? { pause: frame.pause } : {}),
        } };
      }
      onSettingsFrame?.(frame);
    }
  }
  inbox.value = state;
  syncedAt.value = Date.now();
  for (const scope of stale) invalidate(scope);
}

function enqueue(frames: LiveFrame[], counts?: InboxCounts): void {
  if (frames.length === 0 && !counts) return;
  queue.push({ frames, ...(counts ? { counts } : {}) });
  if (scheduled) return;
  scheduled = true;
  // L-7: в скрытой вкладке rAF не идёт, а таймеры тормозятся до 1 с и реже —
  // заголовок «(N)», звук и уведомление ждали бы. Там применяем в микрозадаче.
  if (typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible') requestAnimationFrame(flush);
  else queueMicrotask(flush);
}

function expired(err: unknown): boolean {
  if (err instanceof ApiError && err.code === 'unauthorized') {
    session.value = 'expired';
    stopLive();
    return true;
  }
  return false;
}

/** Снимок списка: открытые и последние решённые. Позиция — меньший из двух seq. */
async function loadSnapshot(): Promise<Position> {
  const [open, done] = await Promise.all([
    getJson<InboxResponse>(`/api/inbox?view=open&limit=${OPEN_LIMIT}`, token()),
    getJson<InboxResponse>(`/api/inbox?view=resolved&limit=${DONE_LIMIT}`, token()),
  ]);
  const base = Math.min(open.seq, done.seq);
  // Другая эпоха — сервер перезапущен, номера кадров начались заново: старое не сливается.
  const previous = open.epoch === snapshotEpoch ? inbox.peek() : emptyInbox();
  snapshotEpoch = open.epoch;
  let state = mergeSnapshot(previous, open.items, open.seq, open.counts, new Set(['mine', 'colleagues', 'ai', 'client']), base);
  state = mergeSnapshot(state, done.items, done.seq, null, new Set(['done']), base);
  // Следующие страницы открытых — по курсору; строки только добавляются (пустой scope),
  // а всё, что сдвинулось между страницами, придёт кадрами с seq больше base.
  let next = open.next;
  let seq = base;
  let epoch = open.epoch === done.epoch ? open.epoch : '';
  for (let total = open.items.length; next && total < OPEN_MAX; ) {
    const page = await getJson<InboxResponse>(`/api/inbox?view=open&limit=${OPEN_LIMIT}&cursor=${encodeURIComponent(next)}`, token());
    if (page.epoch !== open.epoch) { epoch = ''; break; }
    state = mergeSnapshot(state, page.items, page.seq, null, new Set(), base);
    seq = Math.min(seq, page.seq);
    total += page.items.length;
    next = page.next;
  }
  inbox.value = state;
  syncedAt.value = Date.now();
  return epoch ? { seq, epoch } : { seq: 0, epoch: '' };
}

/**
 * Версия кода, с которой открыта вкладка. После установки обновления сервер
 * перезапускается, сокет переподключается, bootstrap приходит с другой
 * версией — вкладка показывает «Вышла новая версия панели · Обновить страницу»
 * (6.9). Другие вкладки узнают о готовой установке и через BroadcastChannel.
 */
let loadedVersion: string | null = null;
export const newVersion = signal<string | null>(null);
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('ai-support-panel');
channel?.addEventListener('message', (event: MessageEvent<{ type?: string; version?: string }>) => {
  if (event.data?.type === 'updated' && event.data.version && event.data.version !== loadedVersion) newVersion.value = event.data.version;
});
/** Установка закончилась в этой вкладке («Система → Обновление»): сказать остальным. */
export function announceUpdated(version: string): void {
  if (version !== loadedVersion) newVersion.value = version;
  channel?.postMessage({ type: 'updated', version });
}

async function loadBootstrap(): Promise<void> {
  const next = await getJson<BootstrapResponse>('/api/bootstrap', token());
  bootstrap.value = next;
  if (loadedVersion === null) loadedVersion = next.version;
  else if (next.version !== loadedVersion) newVersion.value = next.version;
}

export async function startLive(): Promise<void> {
  stopLive();
  if (!readToken()) { session.value = 'expired'; return; }
  loading.value = 'loading';
  loadError.value = null;
  try {
    await loadBootstrap();
    const position = await loadSnapshot();
    loading.value = 'ready';
    void loadPresence();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    client = new LiveClient({
      socketUrl: (ticket) => `${proto}://${location.host}/ws?v=2&token=${encodeURIComponent(ticket)}`,
      ticket: async () => (await getJson<{ ticket: string }>('/api/ticket', token())).ticket,
      events: async (since, epoch) => {
        try {
          return await getJson<EventsResponse>(`/api/events?since=${since}&epoch=${encodeURIComponent(epoch)}`, token());
        } catch (err) {
          expired(err);
          throw err;
        }
      },
      reload: loadSnapshot,
      onFrames: enqueue,
      onState: (state) => {
        const was = connection.peek();
        connection.value = state;
        // Связь вернулась: открытый диалог догоняет пропущенное (кадры ленты без seq).
        const open = openThreadId.peek();
        if (state === 'live' && was !== 'live' && open !== null) void syncThread(open);
        // После обрыва — свежий bootstrap: права, неполадки и версия (после обновления сервер перезапускался).
        if (state === 'live' && was !== 'live' && was !== 'connecting') {
          void loadBootstrap().catch(() => undefined);
          void loadPresence();
        }
      },
      onThread: (frame) => { onCollabFrame(frame); onThreadFrame(frame); },
      onPermission: () => {
        rightsChanged.value = true;
        void loadBootstrap().catch(expired);
      },
    });
    client.start(position);
  } catch (err) {
    if (expired(err)) return;
    loading.value = 'error';
    loadError.value = err instanceof ApiError ? err.code : 'unknown';
  }
}

export function stopLive(): void {
  client?.stop();
  client = null;
  queue = [];
}

/** Вход по ключу: проверить ключ на сервере и только потом сохранить. */
export async function signIn(key: string): Promise<'ok' | 'wrong' | 'network'> {
  const value = key.trim();
  if (!value) return 'wrong';
  try {
    await getJson<BootstrapResponse>('/api/bootstrap', value);
  } catch (err) {
    return err instanceof ApiError && err.status === 0 ? 'network' : 'wrong';
  }
  saveToken(value);
  session.value = 'ok';
  setMode('live');
  return 'ok';
}

export function signOut(): void {
  clearToken();
  stopLive();
  inbox.value = emptyInbox();
  bootstrap.value = null;
  setMode('demo');
}

export function setMode(next: Mode): void {
  mode.value = next;
  try { localStorage.setItem(MODE_KEY, next); } catch { /* режим живёт до перезагрузки */ }
  if (next === 'live') void startLive();
  else stopLive();
}

/** Возврат во вкладку или в сеть — догнать пропущенное. */
function resume(): void {
  if (document.visibilityState !== 'visible') return;
  void client?.resume();
  const open = openThreadId.peek();
  if (open !== null) void syncThread(open);
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', resume);
  addEventListener('online', resume);
  addEventListener('pageshow', (event) => { if ((event as PageTransitionEvent).persisted) resume(); });
}
