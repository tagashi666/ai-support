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

/**
 * CLS (jumps.md): сумма layout-shift без hadRecentInput ≤ 0,02 на сценарий —
 * открытие диалога, новое сообщение, догрузка картинки без размеров, «Решено».
 * Ширины: 1440 и 1024 (desktop), 390 (mobile). Ответы сервера задержаны, как на
 * проде: иначе всё успевает за 500 мс после нажатия и сдвиги не считаются.
 */
const CLS_MAX = 0.02;
type Page = Parameters<Parameters<typeof test>[2]>[0]['page'];

async function trackShifts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store = { sum: 0, list: [] as string[] };
    (window as unknown as { __cls: typeof store }).__cls = store;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: Array<{ node?: Node }> }>) {
        if (entry.hadRecentInput) continue;
        store.sum += entry.value;
        const node = entry.sources?.[0]?.node;
        store.list.push(`${entry.value.toFixed(4)} ${node instanceof Element ? `${node.tagName}.${node.className}` : node?.nodeName ?? '?'}`);
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}
const resetShifts = (page: Page) => page.evaluate(() => { const s = (window as unknown as { __cls: { sum: number; list: string[] } }).__cls; s.sum = 0; s.list = []; });
const shifts = (page: Page) => page.evaluate(() => (window as unknown as { __cls: { sum: number; list: string[] } }).__cls);
async function expectStill(page: Page, label: string): Promise<void> {
  const { sum, list } = await shifts(page);
  console.log(`CLS ${label}: ${sum.toFixed(4)}`);
  expect.soft(sum, `${label}: ${list.join('; ')}`).toBeLessThanOrEqual(CLS_MAX);
}

/** Ширины проекта: на desktop — 1440 и 1024, на mobile — его 390. */
const widths = (project: string): Array<number | null> => (project === 'mobile' ? [null] : [1440, 1024]);
const slowThread = (page: Page, ms: number) => page.route(/\/api\/thread\/\d+(\?|$)/, async (route) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await route.continue();
});
const openRow = (page: Page, id: number) => page.locator(`[data-row-id="${id}"] > div:last-child > button`).first().click();
const feedReady = (page: Page) => expect(page.getByRole('log')).toHaveAttribute('aria-busy', 'false');

test('CLS: открытие диалога и новое сообщение клиента', async ({ page, request }, info) => {
  await trackShifts(page);
  await slowThread(page, 700);
  for (const width of widths(info.project.name)) {
    if (width) await page.setViewportSize({ width, height: 900 });
    const { id } = await inbound(request, 4, `Проверка ширины ${width ?? 390}`);
    await page.goto('/next/chats');
    await expect(page.locator(`[data-row-id="${id}"]`)).toBeVisible();
    await page.waitForTimeout(300);
    await resetShifts(page);
    await openRow(page, id);
    await feedReady(page);
    await page.waitForTimeout(600);
    await expectStill(page, `открытие, ${width ?? 390}`);
    expect(await page.getByRole('log').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), 'лента внизу').toBeLessThan(4);

    await resetShifts(page);
    await inbound(request, 4, 'Новое сообщение во время чтения');
    await expect(page.getByRole('log').getByText('Новое сообщение во время чтения').last()).toBeVisible();
    await page.waitForTimeout(800);
    await expectStill(page, `новое сообщение, ${width ?? 390}`);
  }
});

test('CLS: картинка без размеров догружается — лента не прыгает', async ({ page, request }, info) => {
  await trackShifts(page);
  // Старые записи: у фото нет width/height; сама картинка приходит позже ленты.
  await page.route(/\/api\/thread\/\d+(\?|$)/, async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { messages: Array<{ attachments: Array<{ width: number | null; height: number | null }> }> };
    for (const message of body.messages ?? []) for (const file of message.attachments) { file.width = null; file.height = null; }
    await route.fulfill({ response, json: body });
  });
  await page.route(/\/api\/attachments\/\d+$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 900));
    await route.continue();
  });
  for (const width of widths(info.project.name)) {
    if (width) await page.setViewportSize({ width, height: 900 });
    const { id } = await inbound(request, 0, 'Фото выше');
    await page.goto(`/next/chats/${id}`);
    await feedReady(page);
    await resetShifts(page);
    const img = page.getByRole('log').locator('img').first();
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0), { timeout: 5000 }).toBe(true);
    await page.waitForTimeout(400);
    await expectStill(page, `картинка, ${width ?? 390}`);
    // Лента осталась внизу.
    const gap = await page.getByRole('log').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(gap).toBeLessThan(4);
  }
});

test('CLS: «Решено» — строка уходит, соседи переезжают без скачка', async ({ page, request }, info) => {
  await trackShifts(page);
  for (const width of widths(info.project.name)) {
    if (width) await page.setViewportSize({ width, height: 900 });
    const { id } = await inbound(request, 8, `Решим сейчас ${width ?? 390}`);
    await page.goto(`/next/chats/${id}`);
    await feedReady(page);
    await page.waitForTimeout(300);
    await resetShifts(page);
    const head = page.locator('header').filter({ has: page.getByRole('heading', { level: 2 }) });
    await head.getByRole('button', { name: /^Решено/ }).click();
    await expect(page.getByText(/Диалог решён/)).toBeVisible();
    // Окно отмены прошло, запрос ушёл, кадры вернулись.
    await page.waitForTimeout(UNDO_MS + 1500);
    await expectStill(page, `«Решено», ${width ?? 390}`);
    await page.getByRole('button', { name: 'Отменить' }).waitFor({ state: 'detached' });
  }
});

test('M-1: строка после «Решено» в списке уходит с выходом, не скачком', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'список и меню строки — на компьютере');
  const { id } = await inbound(request, 12, 'Уйдёт с выходом');
  await page.goto('/next/chats');
  const row = page.locator(`[data-row-id="${id}"]`);
  await expect(row).toBeVisible();
  await row.hover();
  await row.getByRole('button', { name: /Действия с диалогом/ }).last().click();
  await page.getByRole('dialog').getByRole('menuitemradio', { name: /^Решено/ }).click();
  await expect(row).toHaveAttribute('data-state', 'closing');
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'Отменить' }).click();
  await expect(row).toBeVisible();
});

test('J-5, M-7: своё сообщение становится настоящим в том же пузыре — без перемонтирования и второго въезда', async ({ page, request }) => {
  const { id } = await inbound(request, 16, 'Ответьте, пожалуйста');
  await page.route(/\/api\/conversations\/\d+\/reply$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  await page.goto(`/next/chats/${id}`);
  await feedReady(page);
  const text = `Проверка пузыря ${Date.now()}`;
  await page.getByRole('textbox', { name: /Ваш ответ/ }).fill(text);
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  const bubble = page.getByRole('log').locator(':scope > div > [data-side="out"]').filter({ hasText: text });
  await expect(bubble).toHaveCount(1);
  await bubble.evaluate((el) => { (el as HTMLElement & { __mark?: boolean }).__mark = true; });
  await expect(bubble).toHaveAttribute('data-message-id', /\d+/);
  await expect(bubble).toHaveCount(1);
  expect(await bubble.evaluate((el) => (el as HTMLElement & { __mark?: boolean }).__mark === true), 'тот же узел').toBe(true);
  expect(await bubble.evaluate((el) => el.querySelector('[data-pending]')!.getAnimations().length), 'без второго въезда').toBe(0);
});
