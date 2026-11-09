/**
 * Жесты на телефоне (7.5) и пакетные действия (6.2, 7.6).
 */
import { expect, test, type Locator } from '@playwright/test';
import { openItems, signIn } from './helpers';

test.beforeEach(async ({ page }) => { await signIn(page); });

/** Касание пальцем: pointer-события с pointerType=touch. */
async function swipe(row: Locator, fromX: number, dx: number): Promise<void> {
  const box = (await row.boundingBox())!;
  const y = box.y + box.height / 2;
  const front = row.locator(':scope > div').last();
  const fire = (type: string, x: number) => front.dispatchEvent(type, { pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: x, clientY: y, bubbles: true });
  await fire('pointerdown', fromX);
  for (let i = 1; i <= 6; i += 1) await fire('pointermove', fromX + (dx * i) / 6);
  await fire('pointerup', fromX + dx);
}

test('свайп: вправо и от края — ничего, влево — кнопки «Решено · Важно · Убрать»', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'жесты — на телефоне');
  await page.goto('/next/chats');
  const row = page.locator('[data-row-id]').nth(1);
  await expect(row).toBeVisible();
  await swipe(row, 200, 150);
  await expect(row).toHaveAttribute('data-swiped', 'false');
  await swipe(row, 10, -180);
  await expect(row).toHaveAttribute('data-swiped', 'false');
  await swipe(row, 300, -180);
  await expect(row).toHaveAttribute('data-swiped', 'true');
  await expect(row.getByRole('button', { name: 'Решено' })).toBeVisible();
  const id = await row.getAttribute('data-row-id');
  await row.getByRole('button', { name: 'Убрать' }).click();
  await expect(page.locator(`[data-row-id="${id}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: 'Отменить' }).click();
  await expect(page.locator(`[data-row-id="${id}"]`)).toHaveCount(1);
});

test('пакет: заявки — лист второго яруса, обычные — «Решено: N» с отменой', async ({ page, request }) => {
  const items = await openItems(request);
  const tickets = items.filter((item) => item.channel === 'bedolaga' && item.state !== 'done').slice(0, 2);
  const plain = items.filter((item) => item.channel === 'telegram' && item.state !== 'done').slice(0, 2);
  await page.goto('/next/chats');
  await expect(page.locator('[data-row-id]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Выбрать' }).click();
  const bar = page.getByRole('toolbar', { name: 'Действия с выбранными' });
  for (const item of tickets) await page.locator(`[data-row-id="${item.id}"] button[aria-pressed]`).click();
  await expect(bar.getByText('Выбрано: 2')).toBeVisible();
  await bar.getByRole('button', { name: 'Решено' }).click();
  const confirm = page.getByRole('dialog', { name: /Закрыть 2 заявки/ });
  await expect(confirm.getByRole('button', { name: 'Не надо' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Не надо' }).click();

  for (const item of tickets) await page.locator(`[data-row-id="${item.id}"] button[aria-pressed]`).click();
  for (const item of plain) await page.locator(`[data-row-id="${item.id}"] button[aria-pressed]`).click();
  await bar.getByRole('button', { name: 'Решено' }).click();
  await expect(page.getByText(`Решено: ${plain.length}`)).toBeVisible();
  for (const item of plain) await expect(page.locator(`[data-row-id="${item.id}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: 'Отменить' }).click();
  for (const item of plain) await expect(page.locator(`[data-row-id="${item.id}"]`)).toHaveCount(1);
});
