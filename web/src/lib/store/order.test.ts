/** Порядок и заморозка списка (7.1): ранг, пилюля, открытый диалог не уезжает, отмена на то же место. */
import { describe, expect, it } from 'vitest';
import { seedChats } from '@/demo/seed';
import type { Chat } from '@/lib/types';
import { applyServer, pendingChanges, rankOf, removeShown, restoreShown, serverOrder, type Placed } from './order';

const now = new Date(2026, 10, 9, 18, 30).getTime();
const placed = (chats: Chat[]): Placed[] => serverOrder(chats).map((chat) => ({ id: chat.id, section: chat.section }));

describe('ранг', () => {
  it('секции идут в порядке показа, «Ждут вас» — сначала срочные, потом кто дольше ждёт', () => {
    const order = serverOrder(seedChats(now));
    const sections = order.map((chat) => chat.section);
    expect(sections.indexOf('colleagues')).toBeGreaterThan(sections.lastIndexOf('mine'));
    expect(sections.indexOf('done')).toBeGreaterThan(sections.lastIndexOf('client'));
    expect(order[0]?.id).toBe('c101');
  });

  it('новое сообщение того же клиента не двигает строку в «Ждут вас»', () => {
    const chats = seedChats(now);
    const before = placed(chats).map((entry) => entry.id);
    const after = placed(chats.map((chat) => (chat.id === 'c102' ? { ...chat, lastAt: now } : chat))).map((entry) => entry.id);
    expect(after).toEqual(before);
  });

  it('ранг — сравнимая строка, одинаковые времена различает id', () => {
    const [a, b] = seedChats(now).filter((chat) => chat.section === 'ai');
    expect(a && b && rankOf({ ...a, lastAt: 1 }) !== rankOf({ ...b, lastAt: 1 })).toBe(true);
  });
});

describe('заморозка и пилюля', () => {
  const shown: Placed[] = [
    { id: 'a', section: 'mine' }, { id: 'b', section: 'mine' }, { id: 'c', section: 'ai' }, { id: 'd', section: 'ai' },
  ];

  it('без изменений пилюли нет', () => {
    expect(pendingChanges(shown, shown)).toEqual([]);
  });

  it('новая строка, переезд в другую секцию и перестановка считаются по одной', () => {
    const server: Placed[] = [
      { id: 'n', section: 'mine' }, { id: 'a', section: 'mine' }, { id: 'd', section: 'ai' }, { id: 'c', section: 'ai' },
      { id: 'b', section: 'client' },
    ];
    const changed = pendingChanges(shown, server);
    expect(changed).toHaveLength(3);
    expect(changed).toEqual(expect.arrayContaining(['n', 'b']));
  });

  it('минимум переездов: одна строка наверх — одно обновление', () => {
    const server: Placed[] = [shown[3]!, shown[0]!, shown[1]!, shown[2]!].map((entry) => ({ ...entry, section: 'mine' as const }));
    const before = shown.map((entry) => ({ ...entry, section: 'mine' as const }));
    expect(pendingChanges(before, server)).toEqual(['d']);
  });

  it('открытый диалог остаётся под прежним заголовком', () => {
    const server: Placed[] = [{ id: 'b', section: 'mine' }, { id: 'c', section: 'ai' }, { id: 'd', section: 'ai' }, { id: 'a', section: 'client' }];
    const next = applyServer(shown, server, 'a');
    expect(next.find((entry) => entry.id === 'a')?.section).toBe('mine');
    expect(next.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(pendingChanges(shown, next)).toEqual([]);
  });

  it('«Отменить» возвращает строку на то же место', () => {
    const { list, index, entry } = removeShown(shown, 'b');
    expect(list.map((e) => e.id)).toEqual(['a', 'c', 'd']);
    expect(restoreShown(list, entry!, index).map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
