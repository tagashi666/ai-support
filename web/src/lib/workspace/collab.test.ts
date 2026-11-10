/** Черновик на сервере (7.8) и присутствие (10.6 п.6): сверка без потерь текста. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerDraft } from '@shared/api-types';
import { colleaguesIn, PRESENCE_FRESH_MS } from './collab';
import { DraftStore, type DraftStorage } from './drafts';
import { DraftSync, DRAFT_PUSH_MS, type DraftApi } from './serverDrafts';

const memory = (): DraftStorage => {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
};

function setup(server: ServerDraft | null = null) {
  let clock = 1000;
  const calls: string[] = [];
  let remote = server;
  const api: DraftApi = {
    get: async () => remote,
    put: async (_id, body) => { calls.push(`put:${body.text}`); remote = { ...body, updated_at: clock }; return remote; },
    remove: async () => { calls.push('remove'); remote = null; },
  };
  let sync: DraftSync | null = null;
  const store = new DraftStore(memory(), () => clock, (id) => sync?.saved(id));
  sync = new DraftSync(store, api, 'tab-here', () => true);
  return { store, sync, calls, tick: (ms: number) => { clock += ms; }, setRemote: (next: ServerDraft | null) => { remote = next; } };
}

const serverDraft = (text: string, device = 'tab-phone'): ServerDraft => ({ text, mode: 'reply', quote: null, from_suggestion: null, device, updated_at: 5000 });

describe('черновик на сервере (7.8)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('запись уходит на сервер через 1,5 с после последней, а не на каждую клавишу', async () => {
    const { store, calls } = setup();
    store.set(1, { text: 'Здр' });
    await vi.advanceTimersByTimeAsync(400);
    store.set(1, { text: 'Здравствуйте' });
    await vi.advanceTimersByTimeAsync(400 + DRAFT_PUSH_MS);
    expect(calls).toEqual(['put:Здравствуйте']);
    const saved = store.get(1);
    expect(saved.synced).toBe(saved.at);
  });

  it('после отправки черновик удаляется и на сервере', async () => {
    const { store, calls } = setup();
    store.set(1, { text: 'Текст' });
    await vi.advanceTimersByTimeAsync(2000);
    store.clear(1);
    await vi.advanceTimersByTimeAsync(DRAFT_PUSH_MS + 10);
    expect(calls).toEqual(['put:Текст', 'remove']);
  });

  it('здесь пусто — текст с другого устройства берётся молча', async () => {
    const { store, sync } = setup(serverDraft('Начал на телефоне'));
    await sync.open(1);
    expect(store.get(1).text).toBe('Начал на телефоне');
    expect(sync.conflicts.value.size).toBe(0);
    expect(sync.tick.value).toBe(1);
  });

  it('здесь несохранённый другой текст — спрашиваем, ничего не затираем', async () => {
    const { store, sync, tick } = setup(serverDraft('С телефона'));
    store.set(1, { text: 'С компьютера' });
    tick(10);
    await sync.open(1);
    expect(store.get(1).text).toBe('С компьютера');
    expect(sync.conflicts.value.get(1)?.text).toBe('С телефона');
    sync.take(1);
    expect(store.get(1).text).toBe('С телефона');
    expect(sync.conflicts.value.size).toBe(0);
  });

  it('«Оставить этот» отправляет здешний текст', async () => {
    const { store, sync, calls } = setup(serverDraft('С телефона'));
    store.set(1, { text: 'С компьютера' });
    await sync.open(1);
    sync.keep(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.at(-1)).toBe('put:С компьютера');
  });

  it('свой кадр с этой вкладки не считается чужим текстом', () => {
    const { store, sync } = setup();
    store.set(1, { text: 'Пишу' });
    sync.frame(1, serverDraft('Пишу старое', 'tab-here'));
    expect(sync.conflicts.value.size).toBe(0);
    expect(store.get(1).text).toBe('Пишу');
  });

  it('сверенный текст, а на сервере пусто — отправили на другом устройстве: поле очищается', async () => {
    const { store, sync, setRemote } = setup(serverDraft('Готово'));
    await sync.open(1);
    setRemote(null);
    sync.frame(1, null);
    expect(store.get(1).text).toBe('');
  });

  it('несверенный текст при пустом сервере не теряется, а уходит на сервер', async () => {
    const { store, sync, calls } = setup();
    store.set(1, { text: 'Без связи' });
    await vi.advanceTimersByTimeAsync(300);
    sync.reconcile(1, null);
    await vi.advanceTimersByTimeAsync(DRAFT_PUSH_MS + 10);
    expect(store.get(1).text).toBe('Без связи');
    expect(calls).toContain('put:Без связи');
  });

  it('сбой сети: черновик остаётся несверенным', async () => {
    const store = new DraftStore(memory(), () => 1000);
    const sync = new DraftSync(store, { get: async () => null, put: async () => { throw new Error('offline'); }, remove: async () => undefined }, 'tab', () => true);
    store.set(1, { text: 'Текст' });
    await sync.push(1);
    expect(store.get(1).synced).toBeUndefined();
  });
});

describe('присутствие (10.6 п.6)', () => {
  it('без себя и без устаревших отметок, печатающие первыми', () => {
    const at = 1_000_000;
    const list = [
      { id: 'op:1', name: 'Мария', state: 'viewing' as const, at: at - 1000 },
      { id: 'op:2', name: 'Пётр', state: 'typing' as const, at: at - 2000 },
      { id: 'me', name: 'Я', state: 'typing' as const, at },
      { id: 'op:3', name: 'Ушёл', state: 'viewing' as const, at: at - PRESENCE_FRESH_MS - 1 },
    ];
    expect(colleaguesIn(list, 'me', at).map((entry) => entry.name)).toEqual(['Пётр', 'Мария']);
    expect(colleaguesIn(undefined, 'me', at)).toEqual([]);
  });
});
