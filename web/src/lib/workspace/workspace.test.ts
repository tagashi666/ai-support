/** Логика рабочего места (этап 3а): реестр, отложенная фиксация, черновики, печать, чип, ошибки, лента, фильтр, заморозка. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem, ThreadMessage, ThreadSuggestion } from '@shared/api-types';
import { isFrozen } from '@/lib/hooks/useFrozenList';
import { DeferredQueue } from './deferred';
import { DRAFT_MAX_AGE_MS, DraftStore, type DraftStorage } from './drafts';
import { sendErrorView } from './errors';
import { filterItems, filterSize } from './filter';
import { patched } from './local';
import { ACTIONS, actionsAt, availability } from './registry';
import { applyThreadFrame, isStale, mergeMessages, type ThreadState } from './thread';
import { TYPING_REPEAT_MS, TypingSignal } from './typing';
import { isBolder, whoView, type WhoInput } from './who';

const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ['conversation:read', 'conversation:reply', 'conversation:notes', 'conversation:status', 'conversation:assign', 'conversation:attachments', 'templates:read'],
  agent: ['conversation:read', 'conversation:reply', 'conversation:notes', 'conversation:status', 'conversation:attachments', 'templates:read'],
  viewer: ['conversation:read'],
};

describe('реестр действий (7.4)', () => {
  it('всё, что есть на компьютере, достижимо на телефоне', () => {
    for (const def of Object.values(ACTIONS)) {
      expect(def.phone.length, def.id).toBeGreaterThan(0);
      // «Скрыть по ширине» запрещено: место на телефоне есть для каждого места компьютера, кроме наведения.
      expect(def.desktop.every((place) => def.phone.includes(place) || place === 'row'), def.id).toBe(true);
    }
  });
  it('по ролям: показать, скрыть или объяснить, как записано', () => {
    expect(availability('reply.send', ROLE_PERMISSIONS.agent!)).toBe('show');
    expect(availability('reply.send', ROLE_PERMISSIONS.viewer!)).toBe('explain');
    expect(availability('conv.takeover', ROLE_PERMISSIONS.agent!)).toBe('hide');
    expect(availability('conv.takeover', ROLE_PERMISSIONS.admin!)).toBe('show');
    expect(availability('conv.hide', ROLE_PERMISSIONS.viewer!)).toBe('hide');
    expect(availability('msg.copy', ROLE_PERMISSIONS.viewer!)).toBe('show');
  });
  it('у отложенных действий ярус 0, у отправки — 1, у перехвата — 2', () => {
    expect(['conv.resolve', 'conv.important', 'conv.hide', 'draft.reject'].every((id) => ACTIONS[id as keyof typeof ACTIONS].deferred)).toBe(true);
    expect(ACTIONS['reply.send'].tier).toBe(1);
    expect(ACTIONS['conv.takeover'].tier).toBe(2);
    expect(actionsAt('rowMenu', true).map((def) => def.id)).toContain('conv.resolve');
  });
});

describe('отложенная фиксация (7.6)', () => {
  let timers: Map<number, () => void>;
  let queue: DeferredQueue;
  let seq = 0;
  beforeEach(() => {
    timers = new Map();
    queue = new DeferredQueue({ set: (fn) => { seq += 1; timers.set(seq, fn); return seq; }, clear: (handle) => { timers.delete(handle as number); } });
  });
  const fire = async (): Promise<void> => { for (const fn of [...timers.values()]) fn(); timers.clear(); await Promise.resolve(); await Promise.resolve(); };

  it('запрос уходит только после окна', async () => {
    const commit = vi.fn(async () => undefined);
    queue.schedule({ key: 'a', commit, revert: vi.fn() }, 6000);
    expect(commit).not.toHaveBeenCalled();
    await fire();
    expect(commit).toHaveBeenCalledWith(false);
  });
  it('«Отменить» — запроса нет, показ возвращается', async () => {
    const commit = vi.fn(async () => undefined);
    const revert = vi.fn();
    queue.schedule({ key: 'a', commit, revert }, 6000);
    expect(queue.cancel('a')).toBe(true);
    await fire();
    expect(commit).not.toHaveBeenCalled();
    expect(revert).toHaveBeenCalledOnce();
    expect(queue.cancel('a')).toBe(false);
  });
  it('скрытие вкладки — всё уходит сразу с keepalive', async () => {
    const commit = vi.fn(async () => undefined);
    queue.schedule({ key: 'a', commit, revert: vi.fn() }, 6000);
    queue.schedule({ key: 'b', commit, revert: vi.fn() }, 6000);
    queue.flush(true);
    await Promise.resolve();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledWith(true);
    expect(queue.size).toBe(0);
  });
  it('ошибка запроса возвращает показ и сообщает', async () => {
    const revert = vi.fn();
    const failed = vi.fn();
    queue.schedule({ key: 'a', commit: async () => { throw new Error('x'); }, revert, failed }, 0);
    await Promise.resolve(); await Promise.resolve();
    expect(revert).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
  });
  it('то же действие повторно заменяет прежнее', async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    queue.schedule({ key: 'a', commit: first, revert: vi.fn() }, 6000);
    queue.schedule({ key: 'a', commit: second, revert: vi.fn() }, 6000);
    await fire();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});

describe('черновики на устройстве (7.8)', () => {
  const memory = (): DraftStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
  };
  afterEach(() => { vi.useRealTimers(); });
  it('сохраняются с задержкой и переживают перезагрузку', () => {
    vi.useFakeTimers();
    const storage = memory();
    const store = new DraftStore(storage);
    store.set(7, { text: 'Здравствуйте', quote: { id: 1, quoteId: 'x-1', excerpt: 'вопрос' } });
    expect(storage.data.size).toBe(0);
    vi.advanceTimersByTime(300);
    const again = new DraftStore(storage);
    expect(again.get(7).text).toBe('Здравствуйте');
    expect(again.get(7).quote?.quoteId).toBe('x-1');
  });
  it('после отправки — пусто; старые не восстанавливаются', () => {
    const storage = memory();
    const store = new DraftStore(storage, () => 1000);
    store.set(1, { text: 'a' });
    store.flush();
    store.clear(1);
    expect(new DraftStore(storage).get(1).text).toBe('');
    storage.setItem('next.draft.2', JSON.stringify({ text: 'старый', mode: 'reply', quote: null, fromSuggestion: null, at: 0 }));
    expect(new DraftStore(storage, () => DRAFT_MAX_AGE_MS + 1).get(2).text).toBe('');
  });
});

describe('печать без закрепления (6.3.1)', () => {
  it('сигнал с первой клавиши и раз в 15 с', () => {
    const typing = new TypingSignal();
    expect(typing.keystroke(1000)).toBe(true);
    expect(typing.keystroke(2000)).toBe(false);
    expect(typing.keystroke(1000 + TYPING_REPEAT_MS)).toBe(true);
    typing.reset();
    expect(typing.keystroke(1000 + TYPING_REPEAT_MS + 1)).toBe(true);
  });
});

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 1, state: 'needs_human', tier: 1, reason: { code: 'waiting', since: null }, waiting_since: 0, sla: null, last: null, unread: 0,
  owner: null, assignee: null, ai: { configured: 'inherit', effective: 'suggest', paused_reason: null, resume_at: null }, window: null,
  flags: { important: false, not_found: false, handoff: false }, priority: 'normal', status: 'open', source: null, channel: 'telegram',
  folder_ids: [], customer: { name: 'Анна', username: null, avatar_version: null }, activity_at: 0, updated_at: 1, section: 'mine', rank: '0|1|0|0',
  ...over,
});

describe('чип «кто отвечает» (6.3.1)', () => {
  const input = (over: Partial<WhoInput> = {}, itemOver: Partial<InboxItem> = {}): WhoInput => ({
    item: item(itemOver), me: 'op:1', permissions: new Set(ROLE_PERMISSIONS.agent), assistant: { mode: 'suggest', keys: true }, typing: false, ...over,
  });
  it('по состояниям — своя главная кнопка', () => {
    expect(whoView(input({}, { ai: { configured: 'inherit', effective: 'auto', paused_reason: null, resume_at: null } })).primary).toBe('take');
    expect(whoView(input()).kind).toBe('aiSuggest');
    expect(whoView(input({}, { flags: { important: false, not_found: false, handoff: true } })).kind).toBe('handed');
    expect(whoView(input({}, { owner: { id: 'op:1', name: 'Я', until: 1 } })).primary).toBe('return');
    expect(whoView(input({}, { status: 'resolved' })).primary).toBe('reopen');
    expect(whoView(input({ typing: true })).kind).toBe('typing');
    expect(whoView(input({ assistant: { mode: 'off', keys: true } })).kind).toBe('offEverywhere');
    expect(whoView(input({ assistant: { mode: 'suggest', keys: false } })).kind).toBe('notConfigured');
  });
  it('коллега ведёт: перехват только с правом, без права — «Попросить передать»', () => {
    const owner = { owner: { id: 'op:2', name: 'Мария', until: 1 } };
    expect(whoView(input({}, owner)).primary).toBe('askHandover');
    expect(whoView(input({ permissions: new Set(ROLE_PERMISSIONS.admin) }, owner)).primary).toBe('takeover');
    expect(whoView(input({ permissions: new Set(ROLE_PERMISSIONS.viewer) }, owner)).primary).toBeNull();
  });
  it('«Вёл: Мария» после конца закрепления; наблюдатель без листа', () => {
    expect(whoView(input({}, { assignee: { id: 'op:2', name: 'Мария' } })).ledBy).toBe('Мария');
    expect(whoView(input({ permissions: new Set(ROLE_PERMISSIONS.viewer) })).menu).toBe(false);
  });
  it('смелее — включение «Отвечает сам»', () => {
    expect(isBolder('auto', 'suggest', 'suggest')).toBe(true);
    expect(isBolder('inherit', 'suggest', 'auto')).toBe(true);
    expect(isBolder('off', 'auto', 'auto')).toBe(false);
  });
});

describe('ошибки отправки (6.3.5)', () => {
  it('код → слова и кнопки', () => {
    expect(sendErrorView('window_closed', true).actions).toEqual(['note', 'waitClient']);
    expect(sendErrorView('upstream', true).retry).toBe(true);
    expect(sendErrorView('network', false).actions).toContain('checkFeed');
    expect(sendErrorView('что-то', true).text).toBe('error.unknown');
  });
});

const msg = (id: number, over: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id, voice: 'client', text: `m${id}`, at: id * 1000, kind: 'text', author: null, quote: null, quote_id: null, suggestion_id: null, attachments: [], ...over,
});
const suggestion = (over: Partial<ThreadSuggestion> = {}): ThreadSuggestion => ({
  id: 9, text: 'черновик', confidence: 0.9, level: 'sure', needs_human: false, reason: null, operator_note: null, sources: [], model: null,
  status: 'pending', created_at: 5000, message_id: 5, ...over,
});
const ready = (over: Partial<ThreadState> = {}): ThreadState => ({
  id: 1, status: 'ready', error: null, head: null, messages: [msg(1), msg(5)], hasMore: false, loadingEarlier: false,
  suggestion: suggestion(), suggestionStale: false, events: [], outgoing: [], ...over,
});

describe('лента: слияние и кадры', () => {
  it('по id без повторов, по порядку', () => {
    expect(mergeMessages([msg(1), msg(3)], [msg(2), msg(3, { text: 'новый' })]).map((m) => `${m.id}${m.text}`)).toEqual(['1m1', '2m2', '3новый']);
  });
  it('кадр сообщения клиента после черновика делает его устаревшим', () => {
    const next = applyThreadFrame(ready(), { type: 'thread', kind: 'message', conversation_id: 1, message: msg(6) });
    expect(next.messages.length).toBe(3);
    expect(next.suggestionStale).toBe(true);
    expect(isStale(suggestion(), [msg(4)])).toBe(false);
  });
  it('удаление, новый черновик, диалог убран', () => {
    const state = ready();
    expect(applyThreadFrame(state, { type: 'thread', kind: 'message_deleted', conversation_id: 1, message_id: 5 }).messages.map((m) => m.id)).toEqual([1]);
    expect(applyThreadFrame({ ...state, suggestionStale: true }, { type: 'thread', kind: 'suggestion', conversation_id: 1, suggestion: null }).suggestionStale).toBe(false);
    expect(applyThreadFrame(state, { type: 'thread', kind: 'deleted', conversation_id: 1 }).status).toBe('gone');
  });
});

describe('фильтр и свои заплатки', () => {
  it('фильтр по полям строки', () => {
    const rows = [
      item({ id: 1, assignee: { id: 'op:1', name: 'Я' }, flags: { important: true, not_found: false, handoff: false } }),
      item({ id: 2, folder_ids: [3], source: { id: 's', kind: 'bedolaga', name: 'B' } }),
    ];
    expect(filterItems(rows, { assignee: 'me' }, 'op:1').map((row) => row.id)).toEqual([1]);
    expect(filterItems(rows, { assignee: 'none' }, 'op:1').map((row) => row.id)).toEqual([2]);
    // «Ответственный: Мария» по ключу из /api/team/names (10.6 п.4).
    expect(filterItems(rows, { assignee: 'op:1' }, 'op:9').map((row) => row.id)).toEqual([1]);
    expect(filterItems(rows, { assignee: 'op:7' }, 'op:1').map((row) => row.id)).toEqual([]);
    expect(filterItems(rows, { folder: 3, source: 's' }, 'op:1').map((row) => row.id)).toEqual([2]);
    expect(filterItems(rows, { important: true }, 'op:1').map((row) => row.id)).toEqual([1]);
    expect(filterSize({ important: true, folder: 1 })).toBe(2);
  });
  it('заплатка живёт до более новой версии с сервера', () => {
    const map = new Map([[1, { base: 5, patch: { status: 'resolved' } }], [2, { base: 5, patch: {}, removed: true }]]);
    expect(patched(item({ id: 1, updated_at: 5 }), map)?.status).toBe('resolved');
    expect(patched(item({ id: 1, updated_at: 6 }), map)?.status).toBe('open');
    expect(patched(item({ id: 2, updated_at: 5 }), map)).toBeNull();
  });
});

describe('заморозка списка (7.1 п.2)', () => {
  const calm = { hover: false, focus: false, touch: false, hold: false, scrollAt: 0, scrollTop: 0 };
  it('любое условие держит порядок', () => {
    expect(isFrozen(calm, 10_000)).toBe(false);
    expect(isFrozen({ ...calm, hover: true }, 10_000)).toBe(true);
    expect(isFrozen({ ...calm, hold: true }, 10_000)).toBe(true);
    expect(isFrozen({ ...calm, scrollAt: 9_500 }, 10_000)).toBe(true);
    expect(isFrozen({ ...calm, scrollTop: 9 }, 10_000)).toBe(true);
  });
});
