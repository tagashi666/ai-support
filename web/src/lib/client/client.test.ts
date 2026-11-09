/**
 * Перенос проверок №38 классики (scripts/uitest.ts) в новую панель:
 * продление только по серверному признаку, защита от двойного продления,
 * честная причина у недоступных подарков.
 */
import { describe, expect, it } from 'vitest';
import { ExtensionGuard } from './extend';
import { giftsView, statusWords, tabsOf } from './view';
import type { BedolagaCard } from './types';

const uuid = (): string => '11111111-1111-4111-8111-111111111111';

describe('продление Bedolaga', () => {
  it('второй клик во время операции не отправляет второй запрос', async () => {
    const guard = new ExtensionGuard();
    let calls = 0;
    let release: () => void = () => undefined;
    const post = () => { calls += 1; return new Promise<{ status: number; body: { ok: boolean } }>((resolve) => { release = () => resolve({ status: 200, body: { ok: true } }); }); };
    const first = guard.run(1, 900, 30, { post, uuid });
    expect(guard.state(900)).toBe('pending');
    expect(await guard.run(1, 900, 30, { post, uuid })).toEqual({ kind: 'blocked' });
    release();
    expect((await first).kind).toBe('done');
    expect(calls).toBe(1);
    expect(guard.state(900)).toBe('idle');
  });

  it('обрыв связи после отправки — исход неясен, повтор заблокирован', async () => {
    const guard = new ExtensionGuard();
    const outcome = await guard.run(1, 900, 7, { post: () => Promise.reject(new Error('reset')), uuid });
    expect(outcome.kind).toBe('unknown');
    expect(guard.state(900)).toBe('uncertain');
    expect(await guard.run(1, 900, 7, { post: () => Promise.resolve({ status: 200, body: { ok: true } }), uuid })).toEqual({ kind: 'blocked' });
    guard.clearUncertain(900);
    expect(guard.state(900)).toBe('idle');
  });

  it('202 «исход неизвестен» блокирует так же; отказ сервера — можно повторить', async () => {
    const guard = new ExtensionGuard();
    expect((await guard.run(1, 5, 7, { post: () => Promise.resolve({ status: 202, body: { ok: false, outcome: 'unknown', warning: 'проверьте' } }), uuid })).kind).toBe('unknown');
    expect(guard.state(5)).toBe('uncertain');
    expect((await guard.run(1, 6, 7, { post: () => Promise.resolve({ status: 502, body: { ok: false, error: 'нет' } }), uuid }))).toEqual({ kind: 'error', message: 'нет' });
    expect(guard.state(6)).toBe('idle');
  });

  it('каждая операция — новый ключ, дни проверяются до запроса', async () => {
    const guard = new ExtensionGuard();
    const keys: string[] = [];
    let n = 0;
    const post = (_path: string, body: unknown) => { keys.push((body as { operationId: string }).operationId); return Promise.resolve({ status: 200, body: { ok: true } }); };
    const next = (): string => `00000000-0000-4000-8000-00000000000${n++}`;
    await guard.run(1, 7, 1, { post, uuid: next });
    await guard.run(1, 7, 2, { post, uuid: next });
    expect(new Set(keys).size).toBe(2);
    expect((await guard.run(1, 7, 0, { post, uuid: next })).kind).toBe('error');
    expect((await guard.run(1, 7, 36_501, { post, uuid: next })).kind).toBe('error');
    expect(keys.length).toBe(2);
  });
});

describe('карточка Bedolaga', () => {
  const card = {
    loadedAt: 0, identityVerified: true, user: { id: 1, hasHadPaidSubscription: false, hasMadeFirstTopup: false },
    subscriptions: { items: [], total: 2, truncated: false }, transactions: { items: [], total: 120, truncated: true },
    tickets: { items: [], total: 1, truncated: false }, referrals: { items: [], total: 0, truncated: false },
    activity: { items: [], total: 4, truncated: false }, gifts: { items: [], total: 0, truncated: false, available: false },
  } as unknown as BedolagaCard;

  it('семь вкладок поимённо, как в классике', () => {
    expect(tabsOf(card).map((tab) => tab.value)).toEqual(['overview', 'subscriptions', 'transactions', 'tickets', 'referrals', 'activity', 'gifts']);
    expect(tabsOf(card).find((tab) => tab.value === 'transactions')?.label).toContain('0 из 120');
  });

  it('«Подарки» без истории — причина сервера или честная фраза', () => {
    expect(giftsView({ ...card.gifts, available: false, reason: 'Нужна авторизация кабинета' })).toEqual({ unavailable: 'Нужна авторизация кабинета' });
    expect(giftsView({ ...card.gifts, available: false })).toEqual({ unavailable: null });
    expect(giftsView({ ...card.gifts, available: true })).toEqual({ unavailable: undefined });
  });

  it('статус подписки словами', () => {
    expect(statusWords('ACTIVE')).toBe('active');
    expect(statusWords('expired')).toBe('expired');
    expect(statusWords('что-то')).toBe(null);
  });
});
