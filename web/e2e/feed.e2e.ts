/**
 * Диалог и список без потерь и скачков (audit/ui-polish, шаг 2): L-1 и CLS.
 */
import { expect, test } from '@playwright/test';
import { control, openItems, signIn } from './helpers';

const UNDO_MS = 6000;

test.beforeEach(async ({ page }) => { await signIn(page); });

const inbound = (request: Parameters<typeof control>[0], i: number, text: string) =>
  control<{ id: number }>(request, `/inbound?i=${i}&text=${encodeURIComponent(text)}`);

test('L-1: клиент написал в окне отмены «Решено» — диалог не закрывается и остаётся в «Ждут вас»', async ({ page, request }) => {
  const { id } = await inbound(request, 1, 'Первый вопрос');
  await page.goto(`/next/chats/${id}`);
  const head = page.locator('header').filter({ has: page.getByRole('heading', { level: 2 }) });
  await head.getByRole('button', { name: /^Решено/ }).click();
  await expect(page.getByText(/Диалог решён/)).toBeVisible();
  await inbound(request, 1, 'Ещё вопрос, не закрывайте');
  await expect(page.getByText(/Клиент написал/)).toBeVisible();
  // Окно отмены прошло: запрос «Решено» не должен был уйти.
  await page.waitForTimeout(UNDO_MS + 1000);
  const item = (await openItems(request)).find((entry) => entry.id === id);
  expect(item, 'диалог остался открытым').toBeDefined();
  expect(item!.section).toBe('mine');
  await expect(head.getByRole('button', { name: /^Решено/ })).toBeVisible();
});
