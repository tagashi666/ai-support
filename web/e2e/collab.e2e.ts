/**
 * Совместная работа на кадрах (10.6 п.5, 6, 8): присутствие в списке и в шапке
 * без ожидания heartbeat, «Попросить передать» → тост «Передать» у того, кто
 * ведёт, черновик переезжает на другое устройство. Два браузера — два контекста.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { openItems, signIn, TOKEN } from './helpers';

const auth = { authorization: `Bearer ${TOKEN}` };

async function operator(page: Page, name: string): Promise<string> {
  const created = await page.request.post('/api/operators', { headers: auth, data: { name, role: 'agent' } });
  return (await created.json() as { token: string }).token;
}

async function open(browser: Browser, token?: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  const page = await context.newPage();
  await signIn(page, token ? { token } : {});
  return page;
}

test.describe('совместная работа', () => {
  test.beforeEach(({}, info) => { test.skip(info.project.name !== 'desktop', 'два браузера — на компьютере'); });

  test('присутствие: коллега открыл диалог — мини-аватар в строке и «смотрит» в шапке', async ({ browser, request }) => {
    const owner = await open(browser);
    const ivanToken = await operator(owner, `Иван ${Date.now() % 100000}`);
    const ivan = await open(browser, ivanToken);
    const target = (await openItems(request)).find((item) => !item.owner && item.state !== 'done' && item.section === 'mine')!;
    await owner.goto('/next/chats');
    await expect(owner.locator(`[data-row-id="${target.id}"]`)).toBeVisible();
    await ivan.goto(`/next/chats/${target.id}`);
    await expect(owner.locator(`[data-row-id="${target.id}"] [aria-label$="в диалоге"]`)).toBeVisible({ timeout: 10_000 });
    await owner.locator(`[data-row-id="${target.id}"] button`).first().click();
    await expect(owner.getByText(/ смотрит/)).toBeVisible();
    await owner.context().close();
    await ivan.context().close();
  });

  test('«Попросить передать» → тост у того, кто ведёт, «Передать» освобождает диалог', async ({ browser, request }) => {
    const owner = await open(browser);
    const ivanToken = await operator(owner, `Борис ${Date.now() % 100000}`);
    const ivan = await open(browser, ivanToken);
    const target = (await openItems(request)).find((item) => !item.owner && item.state !== 'done' && item.channel === 'telegram' && item.section === 'mine')!;
    await owner.goto(`/next/chats/${target.id}`);
    // Закрепить за владельцем: чип «Взять себе» есть не у каждого диалога (у «Подсказывает» главной кнопки нет).
    const engaged = await request.post(`/api/conversations/${target.id}/engage`, { headers: auth, data: {} });
    expect(engaged.ok()).toBeTruthy();
    await ivan.goto(`/next/chats/${target.id}`);
    await ivan.getByRole('button', { name: 'Попросить передать' }).click();
    const toast = owner.getByRole('status').filter({ hasText: 'просит передать диалог' });
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await toast.getByRole('button', { name: 'Передать', exact: true }).click();
    await expect.poll(async () => (await openItems(request)).find((item) => item.id === target.id)?.owner ?? null, { timeout: 10_000 }).toBeNull();
    // У просящего чип сменился сам — кадром списка, без перезагрузки.
    await expect(ivan.getByRole('button', { name: 'Попросить передать' })).toHaveCount(0, { timeout: 10_000 });
    await owner.context().close();
    await ivan.context().close();
  });

  test('черновик переезжает на другое устройство', async ({ browser, request }) => {
    const phone = await open(browser);
    const laptop = await open(browser);
    const target = (await openItems(request)).find((item) => !item.owner && item.state !== 'done' && item.channel === 'telegram')!;
    await phone.goto(`/next/chats/${target.id}`);
    const field = phone.getByRole('textbox').last();
    await field.fill('Начал на телефоне: проверьте подписку');
    // Устройство — сразу, сервер — через 1,5 с после последней записи.
    await expect.poll(async () => (await (await request.get(`/api/conversations/${target.id}/draft`, { headers: auth })).json() as { draft: { text: string } | null }).draft?.text ?? '', { timeout: 10_000 })
      .toBe('Начал на телефоне: проверьте подписку');
    await laptop.goto(`/next/chats/${target.id}`);
    await expect(laptop.getByRole('textbox').last()).toHaveValue('Начал на телефоне: проверьте подписку');
    await phone.context().close();
    await laptop.context().close();
    await request.delete(`/api/conversations/${target.id}/draft`, { headers: auth });
  });
});
