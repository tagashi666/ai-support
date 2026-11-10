/**
 * Мгновенность для второго человека (live.md, L-2, L-4, L-5): коллега видит
 * чужое «Решено», правку знаний и смену своих прав за ~1 с — кадрами сервера
 * (intent, invalidate, me), без опроса и перезагрузки. Два браузера — два контекста.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { control, signIn, TOKEN } from './helpers';

const auth = { authorization: `Bearer ${TOKEN}` };
/** «~1 с»: кадр + отрисовка; до шага 3 было 7,5 с («Решено»), ∞ (знания, права). */
const INSTANT_MS = 1500;

async function open(browser: Browser, token?: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  const page = await context.newPage();
  await signIn(page, token ? { token } : {});
  return page;
}

/** Перейти и дождаться живого сокета (первый кадр hello): снимок списка приходит раньше. */
async function goLive(page: Page, path: string): Promise<void> {
  const hello = new Promise<void>((resolve) => { page.on('websocket', (ws) => ws.on('framereceived', () => resolve())); });
  await page.goto(path);
  await hello;
}

async function agent(page: Page, name: string): Promise<{ token: string; id: number }> {
  const created = await page.request.post('/api/operators', { headers: auth, data: { name, role: 'agent' } });
  const body = await created.json() as { token: string; operator: { id: number } };
  return { token: body.token, id: body.operator.id };
}

test.describe('мгновенно у коллеги', () => {
  test.beforeEach(({}, info) => { test.skip(info.project.name !== 'desktop', 'два браузера — на компьютере'); });

  test('L-2: чужое «Решено» видно сразу, строка уходит анимацией выхода', async ({ browser, request }) => {
    const { id } = await control<{ id: number }>(request, `/inbound?i=33&text=${encodeURIComponent('Вопрос для двоих')}`);
    const owner = await open(browser);
    const ivan = await open(browser, (await agent(owner, `Иван ${Date.now() % 100000}`)).token);
    await goLive(ivan, '/next/chats');
    const row = ivan.locator(`[data-row-id="${id}"]`);
    await expect(row).toBeVisible();
    await ivan.mouse.move(1270, 790);
    await owner.goto(`/next/chats/${id}`);
    const head = owner.locator('header').filter({ has: owner.getByRole('heading', { level: 2 }) });
    // Ловим и пометку на месте, и выход строки: наблюдатель стоит до нажатия.
    await ivan.evaluate((rowId) => {
      const w = window as unknown as { seen: { moved?: number; closing?: number } };
      w.seen = {};
      new MutationObserver(() => {
        const el = document.querySelector(`[data-row-id="${rowId}"]`);
        if (el?.getAttribute('data-moved') === 'true') w.seen.moved ??= performance.now();
        if (el?.closest('[data-state="closing"]') || el?.getAttribute('data-state') === 'closing') w.seen.closing ??= performance.now();
      }).observe(document.body, { subtree: true, attributes: true, childList: true });
    }, String(id));
    await head.getByRole('button', { name: /^Решено/ }).click();
    const started = Date.now();
    await ivan.waitForFunction(() => (window as unknown as { seen: { moved?: number } }).seen.moved !== undefined, null, { timeout: INSTANT_MS });
    console.log(`L-2: «Решено» у коллеги через ${Date.now() - started} мс`);
    // В покое строка уходит из «Ждут вас» той же анимацией выхода, что и своя (M-1).
    await expect.poll(() => ivan.evaluate(() => (window as unknown as { seen: { closing?: number } }).seen.closing !== undefined), { timeout: 4000 }).toBeTruthy();
    await expect(row).toHaveCount(0);
    await owner.context().close();
    await ivan.context().close();
  });

  test('L-2: чужое «Убрать» — строка уходит той же анимацией выхода, отмена возвращает', async ({ browser, request }) => {
    const { id } = await control<{ id: number }>(request, `/inbound?i=34&text=${encodeURIComponent('Уберут при вас')}`);
    const ivan = await open(browser);
    await goLive(ivan, '/next/chats');
    const row = ivan.locator(`[data-row-id="${id}"]`);
    await expect(row).toBeVisible();
    await ivan.mouse.move(1270, 790);
    await ivan.evaluate((rowId) => {
      const w = window as unknown as { closing: boolean };
      w.closing = false;
      new MutationObserver(() => {
        const el = document.querySelector(`[data-row-id="${rowId}"]`);
        if (el?.closest('[data-state="closing"]') || el?.querySelector('[data-state="closing"]')) w.closing = true;
      }).observe(document.body, { subtree: true, attributes: true, childList: true });
    }, String(id));
    // Намерение коллеги — как его шлёт панель автора в окне отмены.
    expect((await request.post(`/api/conversations/${id}/intent`, { headers: auth, data: { action: 'hide' } })).ok()).toBeTruthy();
    await expect.poll(() => ivan.evaluate(() => (window as unknown as { closing: boolean }).closing), { timeout: 4000 }).toBeTruthy();
    await expect(row).toHaveCount(0);
    expect((await request.post(`/api/conversations/${id}/intent`, { headers: auth, data: { action: null } })).ok()).toBeTruthy();
    await expect(row).toBeVisible({ timeout: 4000 });
    await ivan.context().close();
  });

  test('L-4: новая статья коллеги появляется в открытых «Знаниях»', async ({ browser, request }) => {
    const ivan = await open(browser);
    await goLive(ivan, '/next/knowledge');
    await expect(ivan.getByRole('list', { name: 'Статьи' })).toBeVisible();
    const title = `Мгновенно ${Date.now() % 100000}`;
    const started = Date.now();
    const created = await request.post('/api/kb', { headers: auth, data: { title, text: 'Проверка кадра invalidate.', draft: true } });
    expect(created.ok()).toBeTruthy();
    await expect(ivan.getByText(title)).toBeVisible({ timeout: INSTANT_MS });
    console.log(`L-4: статья у коллеги через ${Date.now() - started} мс`);
    const { name } = await created.json() as { name: string };
    await request.delete(`/api/kb/draft/${encodeURIComponent(name)}`, { headers: auth, data: {} });
    await ivan.context().close();
  });

  test('L-5: права изменились — панель знает без перезагрузки', async ({ browser, request }) => {
    const owner = await open(browser);
    const person = await agent(owner, `Пётр ${Date.now() % 100000}`);
    const peter = await open(browser, person.token);
    await goLive(peter, '/next/chats');
    await expect(peter.getByRole('navigation').first()).toBeVisible();
    const started = Date.now();
    const changed = await request.post(`/api/operators/${person.id}`, { headers: auth, data: { role: 'viewer' } });
    expect(changed.ok()).toBeTruthy();
    await expect(peter.getByText('Ваши права изменились')).toBeVisible({ timeout: INSTANT_MS });
    console.log(`L-5: права у человека через ${Date.now() - started} мс`);
    await owner.context().close();
    await peter.context().close();
  });
});
