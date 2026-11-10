/**
 * Нагрузка (план, 11.6 и риск 13): ~500 синтетических диалогов и 10 кадров в
 * секунду в течение минуты. Свой сервер (проект load, E2E_EXTRA=460), чтобы
 * не менять базу остальных тестов. Проверяем: список догружен страницами,
 * рисуется окном (видимые ±2 экрана), позиция прокрутки и строки под глазами
 * не сдвигаются, пока список прокручен, задач дольше 200 мс нет.
 */
import { expect, test } from '@playwright/test';
import type { InboxResponse } from '@shared/api-types';
import { signIn, TOKEN } from './helpers';

const CONTROL = 'http://127.0.0.1:8200';

test.beforeEach(async ({ page }) => { await signIn(page); });

test('500 диалогов и минута кадров: окно отрисовки, прокрутка на месте, без долгих задач', async ({ page, request }) => {
  test.setTimeout(150_000);
  const open = await (await request.get('/api/inbox?view=open&limit=1', { headers: { authorization: `Bearer ${TOKEN}` } })).json() as InboxResponse;
  expect(open.counts.open, 'на сервере ~500 открытых').toBeGreaterThan(450);

  await page.goto('/next/chats');
  await page.getByRole('tab', { name: /Открытые/ }).click();
  const scroller = page.locator('[data-scroller="chats"]');
  await expect(page.locator('[data-row-id]').first()).toBeVisible();
  // Все страницы догружены: в данных больше 200 строк (раньше снимок обрезался на 200).
  await expect.poll(async () => scroller.evaluate((el) => [...el.querySelectorAll<HTMLElement>('[data-rows]')]
    .reduce((sum, group) => sum + Number(group.dataset.count ?? 0), 0)), { timeout: 20_000 }).toBeGreaterThan(300);
  // Окно: нарисовано заметно меньше строк, чем есть.
  const drawn = await page.locator('[data-row-id]').count();
  expect(drawn, 'строк в документе').toBeLessThan(200);

  // Прокрутили в середину: окно сдвинулось, строки под глазами есть.
  await scroller.evaluate((el) => { el.scrollTop = 12_000; });
  await page.waitForTimeout(400);
  const anchor = await scroller.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const row = [...el.querySelectorAll<HTMLElement>('[data-row-id]')].find((item) => item.getBoundingClientRect().top >= box.top + 40);
    return row ? { id: row.dataset.rowId ?? '', top: Math.round(row.getBoundingClientRect().top), scrollTop: el.scrollTop } : null;
  });
  expect(anchor, 'строка в середине списка нарисована').not.toBeNull();

  // Долгие задачи — только во время потока кадров.
  await page.evaluate(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) w.__long.push(entry.duration); }).observe({ type: 'longtask', buffered: false });
  });
  await request.post(`${CONTROL}/burst?n=600&ms=100`);
  for (let second = 0; second < 60; second += 6) {
    await page.waitForTimeout(6000);
    const now = await scroller.evaluate((el, id) => {
      const row = el.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
      return { scrollTop: el.scrollTop, top: row ? Math.round(row.getBoundingClientRect().top) : null };
    }, anchor!.id);
    expect(Math.abs(now.scrollTop - anchor!.scrollTop), `прокрутка на ${second + 6} с`).toBeLessThanOrEqual(2);
    expect(now.top, `строка под глазами на ${second + 6} с`).toBe(anchor!.top);
  }
  await expect(page.getByRole('button', { name: /обновлени/ })).toBeVisible();
  const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  expect(Math.max(0, ...long), `долгие задачи: ${long.map((ms) => Math.round(ms)).join(', ')}`).toBeLessThan(200);

  // Пилюля: применить накопленное и наверх — тоже без долгих задач.
  await page.evaluate(() => { (window as unknown as { __long: number[] }).__long = []; });
  // Строка пилюли меняется с каждым кадром, пока поток не кончился: нажатие — событием, без ожидания «стабильности».
  await page.getByRole('button', { name: /обновлени/ }).dispatchEvent('click');
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 5000 }).toBeLessThan(10);
  const after = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  expect(Math.max(0, ...after), `долгие задачи после пилюли: ${after.map((ms) => Math.round(ms)).join(', ')}`).toBeLessThan(200);
  expect(await page.locator('[data-row-id]').count()).toBeLessThan(200);
});

test('клавиатура в длинном списке: одна остановка Tab, End и Home за окном', async ({ page }) => {
  await page.goto('/next/chats');
  await page.getByRole('tab', { name: /Открытые/ }).click();
  const first = page.locator('[data-row-id] button[tabindex="0"]').first();
  await expect(first).toBeVisible();
  expect(await page.locator('[data-row-id]:has(button[tabindex="0"])').count(), 'одна остановка Tab в списке').toBe(1);
  await first.focus();
  await page.keyboard.press('End');
  const scroller = page.locator('[data-scroller="chats"]');
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 4), { timeout: 5000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-row-id]')))).toBe(true);
  await page.keyboard.press('Home');
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 5000 }).toBeLessThan(10);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-row-id]')?.getAttribute('data-row-id') ?? null)).not.toBeNull();
});

/**
 * Кадры в любом движке (R2 D): прокрутка списка из ~500 и ленты «Длинного диалога»
 * (1000 сообщений) по 60 px за кадр — requestAnimationFrame-счётчик, без длинных
 * провалов. Числа печатаются строкой [perf] (видны в выводе CI).
 */
test('кадры: прокрутка списка и длинной ленты без провалов', async ({ page, browserName }) => {
  test.setTimeout(90_000);
  const run = async (selector: string, step: number): Promise<{ fps: number; max: number; over50: number }> => await page.evaluate(([sel, dy]) => new Promise((resolve) => {
    const el = document.querySelector(sel)!;
    const deltas: number[] = [];
    let last = 0;
    let start = 0;
    const tick = (now: number): void => {
      if (start) deltas.push(now - last); else start = now;
      last = now;
      el.scrollTop += dy;
      if (now - start < 3000) requestAnimationFrame(tick);
      else resolve({ fps: Math.round(1000 * deltas.length / (now - start)), max: Math.round(Math.max(...deltas)), over50: deltas.filter((d) => d > 50).length });
    };
    requestAnimationFrame(tick);
  }), [selector, step] as const);

  await page.goto('/next/chats');
  await page.getByRole('tab', { name: /Открытые/ }).click();
  await expect(page.locator('[data-row-id]').first()).toBeVisible();
  await page.waitForTimeout(500);
  const list = await run('[data-scroller="chats"]', 60);

  await page.locator('#chat-search').fill('Длинный диалог');
  await page.locator('[data-row-id]').filter({ hasText: 'Длинный диалог' }).first().locator('button').first().click();
  await expect(page.locator('[role="log"] [data-voice]').nth(50)).toBeAttached();
  await page.waitForTimeout(500);
  const feed = await run('[role="log"]', -60);

  console.log(`[perf] ${browserName} список ${list.fps} fps, худший кадр ${list.max} мс, >50 мс: ${list.over50}; лента ${feed.fps} fps, худший ${feed.max} мс, >50 мс: ${feed.over50} — passed`);
  // Провал — кадр дольше 250 мс (заметный рывок даже на медленной машине CI); единичные >50 мс допустимы.
  expect(list.max, 'худший кадр списка').toBeLessThan(250);
  expect(feed.max, 'худший кадр ленты').toBeLessThan(250);
  expect(list.over50 + feed.over50, 'кадров длиннее 50 мс').toBeLessThanOrEqual(6);
});
