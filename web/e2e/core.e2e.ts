/**
 * Обязательные сценарии этапа 3б (план, 11.6): список не скачет при потоке
 * кадров, обрыв и возврат связи, отправка черновика с отменой, телефон 390
 * без горизонтальной прокрутки.
 */
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { api, control, expectNoHorizontalScroll, rowOrder, signIn, stats, threadWithDraft } from './helpers';
import type { ThreadResponse } from '@shared/api-types';

test.beforeEach(async ({ page }) => { await signIn(page); });

test('список не скачет под курсором при потоке кадров', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'наведение — только мышью');
  await page.goto('/next/chats');
  const rows = page.locator('[data-row-id]');
  await expect(rows.first()).toBeVisible();
  // Курсор над списком — список стоит (7.1 правило 2).
  await rows.nth(2).hover();
  const before = await rowOrder(page);
  const box = await rows.nth(2).boundingBox();
  await control(request, '/burst?n=30&ms=40');
  // Кадры пришли: накопилось в пилюле, а строки на месте.
  const pill = page.getByRole('button', { name: /обновлени/ });
  await expect(pill).toBeVisible();
  await page.waitForTimeout(2500);
  expect(await rowOrder(page)).toEqual(before);
  expect((await rows.nth(2).boundingBox())?.y).toBe(box?.y);
  // Курсор ушёл — после 1,5 с спокойствия список применяет новое сам.
  await page.mouse.move(1200, 780);
  await page.locator('main').evaluate(() => undefined);
  await expect(pill).toBeHidden({ timeout: 10_000 });
  expect(await rowOrder(page)).not.toEqual(before);
});

test('обрыв связи и возврат: строка состояния и догон пропущенного', async ({ page, request }) => {
  let blocked = false;
  const open = new Set<WebSocketRoute>();
  await page.routeWebSocket(/\/ws/, (ws) => {
    if (blocked) { void ws.close({ code: 1006 }); return; }
    open.add(ws);
    ws.connectToServer();
    ws.onClose(() => open.delete(ws));
  });
  await page.goto('/next/chats');
  const line = page.locator('[data-connection]');
  await expect(line).toHaveAttribute('data-connection', 'live', { timeout: 15_000 });

  blocked = true;
  for (const ws of open) await ws.close({ code: 1006 });
  await expect(line).not.toHaveAttribute('data-connection', 'live');
  // Пока связи нет, клиенты пишут.
  await control(request, '/burst?n=3&ms=10');
  await page.waitForTimeout(4000);
  await expect(page.getByText('Восстанавливаем связь…')).toBeVisible();

  blocked = false;
  await expect(line).toHaveAttribute('data-connection', 'live', { timeout: 20_000 });
  // Догон по /api/events: пропущенные сообщения видны в превью строк.
  await page.locator('main').hover({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.mouse.move(1, 1);
  await expect(page.getByText(/Сообщение \d+/).first()).toBeVisible({ timeout: 10_000 });
});

test('черновик помощника: «Отправить», затем «Отменить» — ничего не ушло', async ({ page, request }) => {
  const id = await threadWithDraft(request, 'sure');
  const sentBefore = (await stats(request)).sent;
  await page.goto(`/next/chats/${id}`);
  const draft = page.getByRole('region', { name: 'Черновик помощника' });
  await expect(draft).toBeVisible();
  await draft.getByRole('button', { name: 'Отправить' }).click();
  // Окно отмены 5 с: пузырь «отправим через N с» и «Отменить».
  await expect(page.getByText(/отправим через \d с/)).toBeVisible();
  await page.getByRole('button', { name: 'Отменить', exact: true }).first().click();
  await expect(page.getByText(/отправим через \d с/)).toBeHidden();
  // Карточка черновика вернулась, сообщение не ушло.
  await expect(draft).toBeVisible();
  await page.waitForTimeout(6000);
  expect((await stats(request)).sent).toBe(sentBefore);
  const thread = await api<ThreadResponse>(request, `/api/thread/${id}`);
  expect(thread.suggestion?.level).toBe('sure');
});

test('телефон 390: нет горизонтальной прокрутки', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'mobile', 'проверка ширины телефона');
  await page.goto('/next/chats');
  await expect(page.locator('[data-row-id]').first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  const id = await threadWithDraft(request, 'check');
  await page.goto(`/next/chats/${id}`);
  await expect(page.getByRole('log', { name: 'Переписка' })).toBeVisible();
  await expectNoHorizontalScroll(page);
});
