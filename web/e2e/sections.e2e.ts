/**
 * Разделы без скачков (audit/ui-polish, шаг 3: J-6, J-8, J-9): CLS ≤ 0,02 на переходах по вкладкам
 * «Системы», при появлении полосы паузы и на «Сегодня». Ответы сервера задержаны, как на проде:
 * иначе всё успевает за 500 мс после нажатия и сдвиги не считаются. Ширины: 1440 (desktop) и 390 (mobile).
 */
import { expect, test } from '@playwright/test';
import { classicLink, signIn, TOKEN } from './helpers';

const CLS_MAX = 0.02;
type Page = Parameters<Parameters<typeof test>[2]>[0]['page'];
interface Store { sum: number; list: string[] }

async function trackShifts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store: Store = { sum: 0, list: [] };
    (window as unknown as { __cls: Store }).__cls = store;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: Array<{ node?: Node; previousRect: DOMRect; currentRect: DOMRect }> }>) {
        if (entry.hadRecentInput) continue;
        store.sum += entry.value;
        const source = entry.sources?.[0];
        const node = source?.node;
        const box = source ? ` y ${Math.round(source.previousRect.y)}→${Math.round(source.currentRect.y)} h ${Math.round(source.previousRect.height)}→${Math.round(source.currentRect.height)}` : '';
        store.list.push(`${entry.value.toFixed(4)} ${node instanceof Element ? `${node.tagName}.${node.className}` : node?.nodeName ?? '?'}${box}`);
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}
const resetShifts = (page: Page) => page.evaluate(() => { const s = (window as unknown as { __cls: Store }).__cls; s.sum = 0; s.list = []; });
const shifts = (page: Page) => page.evaluate(() => (window as unknown as { __cls: Store }).__cls);
async function expectStill(page: Page, label: string): Promise<void> {
  const { sum, list } = await shifts(page);
  console.log(`CLS ${label}: ${sum.toFixed(4)}${list.length ? ` [${list.join("; ")}]` : ""}`);
  expect.soft(sum, `${label}: ${list.join('; ')}`).toBeLessThanOrEqual(CLS_MAX);
}
/** Ответы API (кроме догона событий) идут с задержкой. */
const slowApi = (page: Page, ms: number, pattern = /\/api\/(?!events)/) => page.route(pattern, async (route) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await route.continue();
});
const settle = (page: Page) => page.waitForTimeout(1200);

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await trackShifts(page);
});

test('CLS: «Сегодня» — карточки по мере данных', async ({ page }, info) => {
  await slowApi(page, 600, /\/api\/(activity|health|problems)/);
  await page.goto('/next/today');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await settle(page);
  await expectStill(page, `Сегодня ${info.project.name}`);
});

test('CLS: «Система» — переходы по вкладкам', async ({ page }, info) => {
  await page.goto('/next/system');
  const tabs = page.getByRole('tab');
  await expect(tabs.first()).toBeVisible();
  await settle(page);
  await slowApi(page, 500);
  await resetShifts(page);
  const count = await tabs.count();
  expect(count).toBeGreaterThan(1);
  for (let i = 1; i < count; i += 1) {
    await tabs.nth(i).click();
    await page.waitForTimeout(900);
  }
  await tabs.first().click();
  await settle(page);
  await expectStill(page, `Система, вкладки ${info.project.name}`);
});

test('CLS: полоса паузы появляется без сдвига экрана', async ({ page, request }, info) => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  await request.delete('/api/assistant/pause', { headers: auth });
  await page.goto('/next/today');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await settle(page);
  await resetShifts(page);
  try {
    await request.post('/api/assistant/pause', { headers: auth, data: { until: Date.now() + 60 * 60_000 } });
    const strip = page.getByRole('status').filter({ hasText: /Помощник на паузе/ });
    await expect(strip).toBeVisible();
    await settle(page);
    await expectStill(page, `полоса паузы ${info.project.name}`);
    // Полосу можно убрать до новой паузы — экран под ней не двигается и тут.
    await resetShifts(page);
    await strip.getByRole('button', { name: 'Скрыть до следующего изменения' }).click();
    await expect(strip).toBeHidden();
    await settle(page);
    await expectStill(page, `полоса паузы скрыта ${info.project.name}`);
  } finally {
    await request.delete('/api/assistant/pause', { headers: auth });
  }
});

test('верхней полосы нет: «Классическая панель» и «Выйти» — в меню аккаунта (телефон — «Ещё»), «Прототипа» нет (R2 A3)', async ({ page }) => {
  await page.goto('/next/today');
  await expect(page.getByRole('heading', { name: 'Сегодня', level: 1 })).toBeVisible();
  await expect(page.getByText('Рабочая панель', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Прототип' })).toHaveCount(0);
  // Заголовок раздела — у верхнего края: над ним ничего нет.
  const top = await page.getByRole('heading', { name: 'Сегодня', level: 1 }).boundingBox();
  expect(top?.y ?? 999, 'заголовок у верха').toBeLessThanOrEqual(48);
  await classicLink(page);
  const signOut = (page.viewportSize()?.width ?? 0) >= 768
    ? page.getByRole('menu').getByRole('menuitem', { name: 'Выйти' })
    : page.getByRole('button', { name: 'Выйти' });
  await expect(signOut).toBeVisible();
});
