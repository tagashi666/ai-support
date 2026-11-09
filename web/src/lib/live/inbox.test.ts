/**
 * Свойство (7.1 п.10): после любой последовательности кадров, повторов,
 * разрывов и повторных загрузок порядок в панели равен серверному.
 */
import { describe, expect, it } from 'vitest';
import type { InboxItem, LiveFrame } from '@shared/api-types';
import type { Section } from '@shared/attention';
import { rankOf } from '@shared/conversation-order';
import { applyFrames, emptyInbox, mergeSnapshot, ordered, type InboxState } from './inbox';

const SECTIONS: readonly Section[] = ['mine', 'colleagues', 'ai', 'client', 'done'];

/** Детерминированный генератор: падение воспроизводится по номеру прогона. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const makeItem = (id: number, section: Section, key: number, updatedAt: number): InboxItem => ({
  id, section, updated_at: updatedAt,
  rank: rankOf({ id, section, tier: 0, waitingSince: key, activityAt: key, doneAt: key }),
} as InboxItem);

interface Server {
  frames: LiveFrame[];
  /** Состояние сервера после кадра seq (индекс = seq). */
  states: Array<Map<number, InboxItem>>;
}

function simulateServer(next: () => number, steps: number): Server {
  const state = new Map<number, InboxItem>();
  const updated = new Map<number, number>();
  const frames: LiveFrame[] = [];
  const states: Array<Map<number, InboxItem>> = [new Map()];
  for (let seq = 1; seq <= steps; seq += 1) {
    const id = 1 + Math.floor(next() * 8);
    if (next() < 0.15 && state.has(id)) {
      state.delete(id);
      frames.push({ type: 'inbox_remove', seq, epoch: 'e', id });
    } else {
      // Переходы по времени не меняют updated_at — бывает и равная версия.
      const version = (updated.get(id) ?? 0) + (next() < 0.3 ? 0 : 1);
      updated.set(id, version);
      const item = makeItem(id, SECTIONS[Math.floor(next() * SECTIONS.length)]!, Math.floor(next() * 50), version);
      state.set(id, item);
      frames.push({ type: 'inbox_item', seq, epoch: 'e', item });
    }
    states.push(new Map(state));
  }
  return { frames, states };
}

const ids = (state: InboxState): string => ordered(state).map((item) => `${item.id}:${item.rank}`).join(',');
const serverIds = (state: Map<number, InboxItem>): string =>
  [...state.values()].sort((a, b) => (a.rank < b.rank ? -1 : 1)).map((item) => `${item.id}:${item.rank}`).join(',');

describe('живой список: слияние снимка и кадров', () => {
  it('порядок после кадров, повторов, разрывов и перезагрузок равен серверному (300 прогонов)', () => {
    for (let run = 0; run < 300; run += 1) {
      const next = random(run + 1);
      const server = simulateServer(next, 60);
      // Снимок в случайный момент; дальше кадры по порядку seq, как их отдаёт LiveClient.
      let position = Math.floor(next() * 20);
      let client = mergeSnapshot(emptyInbox(), [...server.states[position]!.values()], position, null);
      while (position < server.frames.length) {
        const roll = next();
        if (roll < 0.1) {
          // Разрыв, догнать нельзя: перечитать страницу на текущем seq сервера.
          const at = Math.min(server.frames.length, position + 1 + Math.floor(next() * 10));
          client = mergeSnapshot(client, [...server.states[at]!.values()], at, null);
          position = at;
        } else if (roll < 0.2) {
          // Повтор и старый кадр после нового — не применяются.
          const old = server.frames[Math.max(0, position - 1 - Math.floor(next() * 3))];
          if (old) client = applyFrames(client, [old]);
        } else {
          // Догон пачкой или один кадр.
          const count = roll < 0.4 ? 1 + Math.floor(next() * 5) : 1;
          client = applyFrames(client, server.frames.slice(position, position + count));
          position = Math.min(server.frames.length, position + count);
        }
      }
      expect(ids(client), `прогон ${run}`).toBe(serverIds(server.states[server.frames.length]!));
    }
  });

  it('старая версия строки не затирает новую', () => {
    const fresh = makeItem(1, 'mine', 5, 10);
    const stale = makeItem(1, 'client', 5, 9);
    let state = mergeSnapshot(emptyInbox(), [fresh], 4, null);
    state = applyFrames(state, [{ type: 'inbox_item', seq: 5, epoch: 'e', item: stale }]);
    expect(ordered(state)[0]?.section).toBe('mine');
  });

  it('снимок не удаляет строки, пришедшие кадром после него', () => {
    let state = applyFrames(emptyInbox(), [{ type: 'inbox_item', seq: 8, epoch: 'e', item: makeItem(2, 'mine', 1, 1) }]);
    state = mergeSnapshot(state, [makeItem(3, 'ai', 1, 1)], 6, null);
    expect(ordered(state).map((item) => item.id).sort()).toEqual([2, 3]);
  });

  it('снимок одной области не трогает строки других секций', () => {
    let state = mergeSnapshot(emptyInbox(), [makeItem(1, 'done', 1, 1), makeItem(2, 'mine', 1, 1)], 3, null);
    state = mergeSnapshot(state, [], 4, null, new Set<Section>(['mine', 'colleagues', 'ai', 'client']));
    expect(ordered(state).map((item) => item.id)).toEqual([1]);
  });

  it('кадр без изменений возвращает то же состояние; счётчики берутся из последнего кадра', () => {
    const state = mergeSnapshot(emptyInbox(), [makeItem(1, 'mine', 1, 1)], 5, null);
    expect(applyFrames(state, [{ type: 'inbox_item', seq: 5, epoch: 'e', item: makeItem(1, 'ai', 1, 1) }])).toBe(state);
    const counts = { waiting: 2, open: 3, sections: { mine: 1, colleagues: 1, ai: 1, client: 0 }, byFolder: {} };
    expect(applyFrames(state, [{ type: 'inbox_remove', seq: 6, epoch: 'e', id: 9, counts }]).counts).toEqual(counts);
  });
});
