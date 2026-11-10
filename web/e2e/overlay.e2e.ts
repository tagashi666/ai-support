/**
 * Окна и тосты (полировка, шаг 1): W-1 — тост виден и нажимается поверх
 * модального листа; M-2 — «Отменить» работает после паузы тоста (курсор или
 * фокус держат и отсчёт, и запрос за ним).
 */
import { expect, test } from '@playwright/test';
import { desktopLike, openItems, signIn } from './helpers';

test.beforeEach(async ({ page }) => { await signIn(page); });

test('W-1: тост поверх листа «Клиент» виден и нажимается', async ({ page, request }) => {
  const item = (await openItems(request)).find((entry) => entry.channel === 'bedolaga' && !entry.owner && !entry.flags.not_found);
  test.skip(!item, 'нет заявки Bedolaga');
  await page.goto(`/next/chats/${item!.id}/client`);
  const pane = page.getByRole('dialog', { name: 'Клиент' });
  await expect(pane.getByText('Подписка', { exact: true })).toBeVisible();
  await pane.getByRole('button', { name: /Обновить/ }).first().click();
  const toast = page.getByRole('status').filter({ hasText: 'Карточка обновлена' });
  await expect(toast).toBeVisible();
  // Верхний элемент в середине тоста — сам тост, а не содержимое листа.
  const onTop = await toast.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
  expect(onTop).toBe(true);
  await toast.getByRole('button', { name: 'Закрыть уведомление' }).click();
  await expect(toast).toHaveCount(0);
  await expect(pane).toBeVisible();
  // Лист закрылся — стопка тостов вернулась из листа в документ.
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  await expect(page.locator('section[popover]')).toHaveCount(1);
  expect(await page.locator('section[popover]').evaluate((el) => el.closest('dialog') === null)).toBe(true);
});

test('M-2: «Решено» — пауза тоста держит запрос, «Отменить» после паузы работает', async ({ page, request }, info) => {
  const item = (await openItems(request)).find((entry) => entry.channel === 'telegram' && !entry.owner && entry.state !== 'done');
  test.skip(!item, 'нет открытого диалога Telegram');
  await page.goto(`/next/chats/${item!.id}`);
  await page.getByRole('button', { name: /^Решено/ }).first().click();
  const toast = page.getByRole('status').filter({ has: page.getByRole('button', { name: 'Отменить' }) });
  await expect(toast).toBeVisible();
  // Мышь — наведение, касание и клавиатура — фокус: оба ставят паузу.
  if (desktopLike(info.project.name)) await toast.hover();
  else await toast.getByRole('button', { name: 'Отменить' }).focus();
  await expect(toast).toHaveAttribute('data-held', 'true');
  await page.waitForTimeout(8_000); // окно отмены — 6 с
  expect((await openItems(request)).some((entry) => entry.id === item!.id), 'запрос ушёл во время паузы').toBe(true);
  await toast.getByRole('button', { name: 'Отменить' }).click();
  await expect(toast).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(7_000);
  expect((await openItems(request)).some((entry) => entry.id === item!.id), 'после «Отменить» диалог решён').toBe(true);
});
