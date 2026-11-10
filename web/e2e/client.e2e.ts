/**
 * «Клиент» (6.4): панель открывается из шапки, Bedolaga с семью вкладками,
 * продление второго яруса без двойного начисления, опасное — с «Отмена».
 */
import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, openItems, signIn, stats } from './helpers';

test.beforeEach(async ({ page }) => { await signIn(page); });

async function bedolagaThread(request: Parameters<typeof openItems>[0]): Promise<number> {
  const item = (await openItems(request)).find((entry) => entry.channel === 'bedolaga' && !entry.owner && !entry.flags.not_found);
  if (!item) throw new Error('нет заявки Bedolaga');
  return item.id;
}

test('«Клиент» из шапки: пять строк, Bedolaga, продление без дубля', async ({ page, request }) => {
  const id = await bedolagaThread(request);
  await page.goto(`/next/chats/${id}`);
  await page.getByRole('button', { name: 'Клиент', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/next/chats/${id}/client$`));
  const pane = page.getByRole('dialog', { name: 'Клиент' });
  await expect(pane.getByText('Подписка', { exact: true })).toBeVisible();
  await expect(pane.getByText('для вас, называть не нужно').first()).toBeVisible();

  // Подробно в Bedolaga: семь вкладок, у «Подарков» — причина.
  await pane.getByText('Подробно в Bedolaga').click();
  await pane.getByRole('button', { name: 'Открыть карточку Bedolaga' }).click();
  const bed = page.getByRole('dialog', { name: 'Подробно в Bedolaga' });
  await expect(bed.getByRole('tab')).toHaveCount(7);
  await bed.getByRole('tab', { name: /Подарки/ }).click();
  await expect(bed.getByRole('tabpanel')).toContainText(/авторизац|недоступна/);
  await bed.getByRole('button', { name: 'Закрыть' }).click();

  // Продление: лист второго яруса, фокус на «Отмена», двойной клик — одно начисление.
  const before = (await stats(request)).extensions;
  await pane.getByRole('button', { name: 'Продлить…' }).first().click();
  const sheet = page.getByRole('dialog', { name: /Продлить подписку/ });
  await expect(sheet.getByRole('button', { name: 'Отмена' })).toBeFocused();
  await sheet.getByRole('button', { name: /Продлить на 30/ }).dblclick();
  await expect(page.getByText(/Добавлено 30 дней/)).toBeVisible();
  expect((await stats(request)).extensions).toBe(before + 1);
  await expectNoHorizontalScroll(page);
});

test('отвязать устройство — второй ярус с «Отмена» по умолчанию', async ({ page, request }) => {
  const id = await bedolagaThread(request);
  await page.goto(`/next/chats/${id}/client`);
  const pane = page.getByRole('dialog', { name: 'Клиент' });
  await pane.getByText('Подписка и устройства').click();
  await pane.getByRole('button', { name: 'Отвязать…' }).first().click();
  const confirm = page.getByRole('dialog', { name: /Отвязать «/ });
  await expect(confirm.getByRole('button', { name: 'Отмена' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Отвязать устройство' }).click();
  await expect(page.getByText('Устройство отвязано')).toBeVisible();
});
