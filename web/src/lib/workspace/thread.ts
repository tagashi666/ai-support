/**
 * Открытые диалоги на сигналах (план, 6.3 и 11.3): шапка, лента, черновик
 * помощника, события. Загрузка — GET /api/thread/:id; живые изменения —
 * кадры ленты сокета (без seq); после разрыва связи — догон `?after=`.
 * Слияние по id сообщения: повторный кадр или ответ отправки дубль не дают.
 */
import { signal } from '@preact/signals';
import type {
  InboxItem, ThreadEvent, ThreadFrame, ThreadHead, ThreadMessage, ThreadResponse, ThreadSuggestion,
} from '@shared/api-types';
import { ApiError, getJson, readToken } from '@/lib/live/api';
import type { ErrorView } from './errors';
import type { Quote } from './drafts';

/** Своё сообщение в пути: окно отмены, отправка, ошибка (6.3.5). */
export interface Outgoing {
  localId: string;
  clientMsgId: string;
  kind: 'text' | 'file';
  text: string;
  fileName?: string;
  state: 'waiting' | 'sending' | 'failed';
  /** Когда уйдёт (окно отмены); null — уже уходит. */
  sendAt: number | null;
  error: ErrorView | null;
  code: string | null;
  suggestionId: number | null;
  edited: boolean;
  quote: Quote | null;
  at: number;
  /** Черновик помощника, отправленный как есть: «Отменить» возвращает карточку, а не текст в поле. */
  restore?: ThreadSuggestion;
}

export interface ThreadState {
  id: number;
  status: 'loading' | 'ready' | 'error' | 'gone';
  error: string | null;
  head: ThreadHead | null;
  messages: ThreadMessage[];
  hasMore: boolean;
  loadingEarlier: boolean;
  suggestion: ThreadSuggestion | null;
  /** Черновик устарел: клиент написал после него (6.3.4). */
  suggestionStale: boolean;
  events: ThreadEvent[];
  outgoing: Outgoing[];
}

export const threads = signal<ReadonlyMap<number, ThreadState>>(new Map());
/** Открытый сейчас диалог (для кадров и догона). */
export const openThreadId = signal<number | null>(null);

const empty = (id: number): ThreadState => ({
  id, status: 'loading', error: null, head: null, messages: [], hasMore: false, loadingEarlier: false,
  suggestion: null, suggestionStale: false, events: [], outgoing: [],
});

export function threadOf(id: number): ThreadState | undefined {
  return threads.value.get(id);
}

export function updateThread(id: number, change: (state: ThreadState) => ThreadState): void {
  const current = threads.peek().get(id) ?? empty(id);
  const next = change(current);
  if (next === current) return;
  const map = new Map(threads.peek());
  map.set(id, next);
  threads.value = map;
}

/** Сообщения по id без повторов; новое с тем же id заменяет старое. */
export function mergeMessages(known: readonly ThreadMessage[], incoming: readonly ThreadMessage[]): ThreadMessage[] {
  if (incoming.length === 0) return known as ThreadMessage[];
  const byId = new Map(known.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function mergeEvents(known: readonly ThreadEvent[], incoming: readonly ThreadEvent[]): ThreadEvent[] {
  if (incoming.length === 0) return known as ThreadEvent[];
  const byId = new Map(known.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

/** Черновик устарел, если клиент написал после него. */
export function isStale(suggestion: ThreadSuggestion | null, messages: readonly ThreadMessage[]): boolean {
  if (!suggestion) return false;
  return messages.some((message) => message.voice === 'client' && message.at > suggestion.created_at
    && (suggestion.message_id === null || message.id > suggestion.message_id));
}

/** Кадр ленты применяется к открытому или закэшированному диалогу. Чистая функция — тест в thread.test.ts. */
export function applyThreadFrame(state: ThreadState, frame: ThreadFrame): ThreadState {
  switch (frame.kind) {
    case 'message':
    case 'message_updated': {
      if (state.status !== 'ready') return state;
      // Своё отправленное уже стоит по ответу сервера — кадр только обновит его на месте.
      const messages = mergeMessages(state.messages, [frame.message]);
      return { ...state, messages, suggestionStale: state.suggestionStale || isStale(state.suggestion, [frame.message]) };
    }
    case 'message_deleted':
      return { ...state, messages: state.messages.filter((message) => message.id !== frame.message_id) };
    case 'suggestion':
      return { ...state, suggestion: frame.suggestion, suggestionStale: false };
    case 'deleted':
      return { ...state, status: state.status === 'ready' ? 'gone' : state.status };
  }
}

const token = (): string => readToken() ?? '';
const lastEventAt = (state: ThreadState): number => state.events.at(-1)?.at ?? 0;

/** Открыть: первый раз — загрузка; уже загружен — догон новых. */
export async function loadThread(id: number): Promise<void> {
  const known = threads.peek().get(id);
  if (known?.status === 'ready') { await syncThread(id); return; }
  updateThread(id, () => ({ ...empty(id), outgoing: known?.outgoing ?? [] }));
  try {
    const data = await getJson<ThreadResponse>(`/api/thread/${id}`, token());
    updateThread(id, (state) => ({
      ...state,
      status: 'ready',
      error: null,
      head: data.head,
      messages: data.messages,
      hasMore: data.has_more,
      suggestion: data.suggestion,
      suggestionStale: false,
      events: data.events,
    }));
  } catch (err) {
    const code = err instanceof ApiError ? err.code : 'unknown';
    updateThread(id, (state) => ({ ...state, status: 'error', error: code }));
  }
}

/** Догон после разрыва, возврата во вкладку, своего действия: новые сообщения, события, шапка, черновик. */
export async function syncThread(id: number): Promise<void> {
  const state = threads.peek().get(id);
  if (!state || state.status !== 'ready') return;
  const after = state.messages.at(-1)?.id ?? 0;
  try {
    const data = await getJson<ThreadResponse>(`/api/thread/${id}?after=${after}&since=${lastEventAt(state)}`, token());
    updateThread(id, (current) => {
      const messages = mergeMessages(current.messages, data.messages);
      return {
        ...current,
        head: data.head,
        messages,
        suggestion: data.suggestion,
        suggestionStale: isStale(data.suggestion, messages),
        events: mergeEvents(current.events, data.events),
        status: current.status === 'gone' && !data.head.hidden ? 'ready' : current.status,
      };
    });
  } catch {
    // Связи нет: лента из памяти, следующий повод (сокет, возврат во вкладку) повторит.
  }
}

/** Ранняя история при прокрутке вверх (`?before=`). */
export async function loadEarlier(id: number): Promise<void> {
  const state = threads.peek().get(id);
  if (!state || !state.hasMore || state.loadingEarlier) return;
  const first = state.messages[0]?.id;
  if (first === undefined) return;
  updateThread(id, (current) => ({ ...current, loadingEarlier: true }));
  try {
    const data = await getJson<ThreadResponse>(`/api/thread/${id}?before=${first}`, token());
    updateThread(id, (current) => ({
      ...current,
      loadingEarlier: false,
      hasMore: data.has_more,
      messages: mergeMessages(current.messages, data.messages),
      events: mergeEvents(current.events, data.events),
    }));
  } catch {
    updateThread(id, (current) => ({ ...current, loadingEarlier: false }));
  }
}

export function onThreadFrame(frame: ThreadFrame): void {
  if (!threads.peek().has(frame.conversation_id)) return;
  updateThread(frame.conversation_id, (state) => applyThreadFrame(state, frame));
}

/** Строка шапки: свежее из списка, если оно новее загруженного с диалогом. */
export function freshItem(head: ThreadHead | null, listed: InboxItem | undefined): InboxItem | null {
  if (!head) return listed ?? null;
  if (listed && listed.updated_at >= head.item.updated_at) return listed;
  return head.item;
}
