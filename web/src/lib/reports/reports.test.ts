/** «Отчёты» (6.8): подписи медиан, проценты, «мало данных», срок, фильтры очереди, период. */
import { describe, expect, it } from 'vitest';
import {
  assistantOwnShare, barHeights, channelName, dialogName, draftsUnchanged, dueText, eventRows, fewData, filterQueue, firstResponseLines,
  localHours, minutesText, noData, overdueCount, ownerText, parseMinutes, parsePeriod, percent, resolutionLine, resolvedLine, tokensText,
  type QueueRow,
} from './model';

const MIN = 60_000;
const row = (id: number, patch: Partial<QueueRow> = {}): QueueRow => ({
  id, channel: 'tg_bot', username: null, display_name: `Клиент ${id}`, status: 'open', priority: 'normal', due_at: 0, overdue: false,
  owner_name: null, owner_live: false, ...patch,
});

describe('период', () => {
  it('принимает только 7, 14, 30, 90', () => {
    expect([parsePeriod('30'), parsePeriod(14), parsePeriod(' 90 ')]).toEqual([30, 14, 90]);
    expect([parsePeriod('5'), parsePeriod(null), parsePeriod('abc'), parsePeriod(365)]).toEqual([7, 7, 7, 7]);
  });
});

describe('числа словами', () => {
  it('медиана и «9 из 10 быстрее»', () => {
    expect(firstResponseLines({ medianFirstResponseMs: 6 * MIN, p90FirstResponseMs: 40 * MIN })).toEqual({ median: 'медиана 6 мин', slowest: '9 из 10 быстрее 40 мин' });
    expect(firstResponseLines({ medianFirstResponseMs: 90 * MIN, p90FirstResponseMs: null })?.slowest).toBe('');
    expect(firstResponseLines({ medianFirstResponseMs: null, p90FirstResponseMs: null })).toBeNull();
  });
  it('решено X из Y и медиана решения', () => {
    expect(resolvedLine({ period: { conversations: 26, resolved: 23 } })).toBe('23 из 26 диалогов');
    expect(resolutionLine({ medianResolutionMs: 180 * MIN })).toBe('медиана решения 3 ч');
    expect(resolutionLine({ medianResolutionMs: null })).toBeNull();
  });
  it('проценты', () => {
    expect(percent(0.314)).toBe('31%');
    expect(percent(null)).toBeNull();
    expect(assistantOwnShare({ aiShare: 0.5 })).toBe('50%');
  });
  it('черновики без правок — из решённых, «ждёт» и «заменён» не считаем', () => {
    expect(draftsUnchanged([{ status: 'sent', n: 6 }, { status: 'edited', n: 3 }, { status: 'rejected', n: 1 }, { status: 'pending', n: 9 }, { status: 'superseded', n: 4 }]))
      .toEqual({ share: '60%', of: 10 });
    expect(draftsUnchanged([{ status: 'pending', n: 2 }])).toBeNull();
  });
  it('мало данных — меньше 5 диалогов, но не ноль', () => {
    expect([0, 1, 4, 5].map((conversations) => fewData({ period: { conversations, resolved: 0 } }))).toEqual([false, true, true, false]);
    expect(noData({ period: { conversations: 0, resolved: 0 } })).toBe(true);
  });
  it('токены', () => {
    expect([850, 12_400, 410_000, 1_250_000].map(tokensText)).toEqual(['850', '12 тыс.', '410 тыс.', '1,3 млн']);
  });
});

describe('словарь значений', () => {
  it('каналы и события словами, неизвестное — «Другое»', () => {
    expect(channelName('tg_dm')).toBe('Telegram Business');
    expect(channelName('wat')).toBe('Другое');
    expect(eventRows([{ kind: 'ai_handoff', n: 5 }, { kind: 'zzz', n: 2 }, { kind: 'zzz2', n: 1 }, { kind: 'ai_error', n: 1 }]))
      .toEqual([{ label: 'передачи человеку', n: 5 }, { label: 'сбои помощника', n: 1 }, { label: 'Другое', n: 3 }]);
  });
});

describe('графики', () => {
  it('часы переводим из UTC в местные, всегда 24 столбика', () => {
    const hours = localHours([{ hour: '22', n: 3 }, { hour: '05', n: 2 }], 180);
    expect(hours).toHaveLength(24);
    expect(hours[1]!.n).toBe(3);
    expect(hours[8]!.n).toBe(2);
    expect(localHours([{ hour: '23', n: 1 }], -300)[18]!.n).toBe(1);
  });
  it('высота столбиков', () => {
    expect(barHeights([0, 1, 50, 100])).toEqual([0, 4, 50, 100]);
    expect(barHeights([0, 0])).toEqual([0, 0]);
  });
});

describe('сроки ответа', () => {
  it('ввод цели — целые минуты 1..10080', () => {
    expect([parseMinutes('30'), parseMinutes(' 240 '), parseMinutes('10080')]).toEqual([30, 240, 10_080]);
    expect([parseMinutes('0'), parseMinutes('10081'), parseMinutes('1.5'), parseMinutes('4 ч'), parseMinutes('')]).toEqual([null, null, null, null, null]);
    expect(minutesText(240)).toBe('4 ч');
  });
  it('срок вышел / осталось', () => {
    const now = 1_000_000_000;
    expect(dueText({ due_at: now - 40 * MIN, overdue: true }, now)).toBe('срок вышел 40 мин назад');
    expect(dueText({ due_at: now + 12 * MIN, overdue: false }, now)).toBe('осталось 12 мин');
    expect(dueText({ due_at: now + 90 * MIN, overdue: false }, now)).toBe('осталось 1 ч 30 мин');
  });
  it('кто ведёт', () => {
    expect(ownerText({ owner_name: 'Мария', owner_live: true })).toBe('ведёт Мария');
    expect(ownerText({ owner_name: 'Мария', owner_live: false })).toBe('вёл Мария');
    expect(ownerText({ owner_name: null, owner_live: false })).toBe('никто не ведёт');
  });
  it('фильтры очереди: просроченные первыми, «никто не ведёт», срочность', () => {
    const rows = [
      row(1, { due_at: 300 }),
      row(2, { due_at: 100, overdue: true, owner_name: 'Мария', owner_live: true, priority: 'high' }),
      row(3, { due_at: 200, overdue: true, owner_name: 'Пётр', owner_live: false }),
    ];
    expect(filterQueue(rows, { mode: 'all', priority: 'any' }).map((r) => r.id)).toEqual([2, 3, 1]);
    expect(filterQueue(rows, { mode: 'overdue', priority: 'any' }).map((r) => r.id)).toEqual([2, 3]);
    expect(filterQueue(rows, { mode: 'free', priority: 'any' }).map((r) => r.id)).toEqual([3, 1]);
    expect(filterQueue(rows, { mode: 'all', priority: 'high' }).map((r) => r.id)).toEqual([2]);
    expect(overdueCount(rows)).toBe(2);
  });
  it('имя диалога', () => {
    expect(dialogName(row(5))).toBe('Клиент 5');
    expect(dialogName({ id: 7, display_name: null, username: 'ivan' })).toBe('@ivan');
    expect(dialogName({ id: 7, display_name: ' ', username: null })).toBe('Диалог 7');
  });
});
