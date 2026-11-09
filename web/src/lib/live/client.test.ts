/** LiveClient с поддельным WebSocket и таймерами: связь, seq, пропуски, догон, эпоха. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsResponse, InboxCounts, InboxItem, LiveFrame } from '@shared/api-types';
import { LiveClient, type ConnectionState } from './client';

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed: number | null = null;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  open(): void { this.readyState = 1; this.onopen?.({}); }
  send(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  close(code = 1000): void { this.closed = code; this.readyState = 3; }
  drop(code = 1006, reason = ''): void { this.readyState = 3; this.onclose?.({ code, reason }); }
}

const counts: InboxCounts = { waiting: 1, open: 1, sections: { mine: 1, colleagues: 0, ai: 0, client: 0 }, byFolder: {} };
const item = (id: number): InboxItem => ({ id } as InboxItem);
const frame = (seq: number, epoch = 'e1', id = seq): LiveFrame => ({ type: 'inbox_item', seq, epoch, item: item(id) });

function setup(events: (since: number, epoch: string) => EventsResponse = (since) => ({ epoch: 'e1', seq: since, events: [], counts })) {
  const delivered: LiveFrame[] = [];
  const states: ConnectionState[] = [];
  const eventCalls: Array<[number, string]> = [];
  const reload = vi.fn(async () => ({ seq: 100, epoch: 'e2' }));
  const onPermission = vi.fn();
  let tickets = 0;
  const client = new LiveClient({
    socketUrl: (ticket) => `ws://test/ws?v=2&token=${ticket}`,
    ticket: async () => `t${++tickets}`,
    events: async (since, epoch) => { eventCalls.push([since, epoch]); return events(since, epoch); },
    reload,
    onFrames: (frames) => { delivered.push(...frames); },
    onState: (state) => { states.push(state); },
    onPermission,
    createSocket: (url) => new FakeSocket(url),
  });
  return { client, delivered, states, eventCalls, reload, onPermission, tickets: () => tickets };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
const last = (): FakeSocket => FakeSocket.all[FakeSocket.all.length - 1]!;

beforeEach(() => { vi.useFakeTimers(); FakeSocket.all = []; });
afterEach(() => { vi.useRealTimers(); });

describe('LiveClient', () => {
  it('подключается к ?v=2 и применяет кадры по порядку', async () => {
    const t = setup();
    t.client.start({ seq: 5, epoch: 'e1' });
    await settle();
    expect(last().url).toContain('/ws?v=2&token=t1');
    last().open();
    expect(t.states).toEqual(['live']);
    last().send({ type: 'hello', seq: 5, epoch: 'e1' });
    last().send(frame(6));
    last().send(frame(7));
    expect(t.delivered.map((f) => f.seq)).toEqual([6, 7]);
    expect(t.eventCalls).toEqual([]);
    t.client.stop();
  });

  it('повтор кадра не применяется дважды', async () => {
    const t = setup();
    t.client.start({ seq: 5, epoch: 'e1' });
    await settle();
    last().open();
    last().send(frame(6));
    last().send(frame(6));
    last().send(frame(4));
    expect(t.delivered.map((f) => f.seq)).toEqual([6]);
    t.client.stop();
  });

  it('пропуск seq — догон одним запросом, без потерь', async () => {
    const t = setup((since) => ({ epoch: 'e1', seq: 9, events: [frame(since + 1), frame(since + 2), frame(9)], counts }));
    t.client.start({ seq: 6, epoch: 'e1' });
    await settle();
    last().open();
    last().send(frame(9));
    await settle();
    expect(t.eventCalls).toEqual([[6, 'e1']]);
    expect(t.delivered.map((f) => f.seq)).toEqual([7, 8, 9]);
    expect(t.client.position.seq).toBe(9);
    last().send(frame(10));
    expect(t.delivered.map((f) => f.seq)).toEqual([7, 8, 9, 10]);
    t.client.stop();
  });

  it('hello с большим seq — догон после переподключения', async () => {
    const t = setup((since) => ({ epoch: 'e1', seq: since + 1, events: [frame(since + 1)], counts }));
    t.client.start({ seq: 3, epoch: 'e1' });
    await settle();
    last().open();
    last().send({ type: 'hello', seq: 4, epoch: 'e1' });
    await settle();
    expect(t.delivered.map((f) => f.seq)).toEqual([4]);
    t.client.stop();
  });

  it('другая эпоха (сервер перезапущен) — перечитать страницу', async () => {
    const t = setup(() => ({ reset: true, epoch: 'e2', seq: 100 }));
    t.client.start({ seq: 3, epoch: 'e1' });
    await settle();
    last().open();
    last().send({ type: 'tick', at: 0, seq: 0, epoch: 'e2' });
    await settle();
    expect(t.reload).toHaveBeenCalledTimes(1);
    expect(t.client.position).toEqual({ seq: 100, epoch: 'e2' });
    last().send(frame(101, 'e2'));
    expect(t.delivered.map((f) => f.seq)).toEqual([101]);
    t.client.stop();
  });

  it('обрыв: восстанавливаем → нет связи и опрос раз в 20 с → связь есть, обновляем → норма', async () => {
    const t = setup((since) => ({ epoch: 'e1', seq: since, events: [], counts }));
    t.client.start({ seq: 1, epoch: 'e1' });
    await settle();
    last().open();
    last().drop(1006);
    expect(t.states.at(-1)).toBe('restoring');
    // Переподключение не удаётся: новые сокеты не открываются.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.states.at(-1)).toBe('offline');
    const before = t.eventCalls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.eventCalls.length).toBeGreaterThan(before);
    const socket = last();
    socket.open();
    expect(t.states.at(-1)).toBe('syncing');
    socket.send({ type: 'hello', seq: 1, epoch: 'e1' });
    await settle();
    expect(t.states.at(-1)).toBe('live');
    t.client.stop();
  });

  it('мёртвый сокет (нет кадров 50 с) закрывается и переоткрывается', async () => {
    const t = setup();
    t.client.start({ seq: 0, epoch: 'e1' });
    await settle();
    const first = last();
    first.open();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(first.closed).not.toBeNull();
    expect(FakeSocket.all.length).toBeGreaterThan(1);
    t.client.stop();
  });

  it('билет обновляется без окна: новый сокет открывается раньше, чем закрывается старый', async () => {
    const t = setup();
    t.client.start({ seq: 0, epoch: 'e1' });
    await settle();
    const first = last();
    first.open();
    // Кадры идут, сокет живой.
    for (let i = 0; i < 24; i += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      first.send({ type: 'tick', at: 0, seq: 0, epoch: 'e1' });
      if (FakeSocket.all.length > 1) break;
    }
    const second = last();
    expect(second).not.toBe(first);
    expect(second.url).toContain('token=t2');
    expect(first.closed).toBeNull();
    second.open();
    expect(first.closed).toBe(1000);
    expect(t.states).toEqual(['live']);
    t.client.stop();
  });

  it('закрытие сокета из-за прав — повод перечитать bootstrap', async () => {
    const t = setup();
    t.client.start({ seq: 0, epoch: 'e1' });
    await settle();
    last().open();
    last().drop(1008, 'Permission revoked');
    expect(t.onPermission).toHaveBeenCalledTimes(1);
    t.client.stop();
  });
});
