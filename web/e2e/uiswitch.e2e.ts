/**
 * Панель по умолчанию (план, раздел 12, этап 8): `/` без выбора открывает новую
 * панель; cookie `ui`, `?ui=classic` и «Классическая панель» возвращают
 * классику на устройстве; «Система → Панель» и `PANEL_UI=classic` — для всей
 * установки; старые ссылки `/#c<id>` (уведомления) и `/#v=<раздел>` не ломаются.
 * Отдельный сервер на порту +4 запущен с PANEL_UI=classic (playwright.config.ts).
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { classicLink, openItems, signIn, TOKEN } from './helpers';

const PORT = Number(process.env.E2E_PORT ?? 8197);
const CLASSIC_BASE = `http://127.0.0.1:${PORT + 4}`;
const auth = { authorization: `Bearer ${TOKEN}` };

/** Классика узнаётся по своей навигации (на телефоне она может быть свёрнута — проверяем наличие, не видимость). */
const classicNav = (page: Page, view = 'inbox') => page.locator(`button.nav[data-view="${view}"]`);

async function rootStatus(request: APIRequestContext, base = '', cookie?: string): Promise<{ status: number; location: string | undefined }> {
  const res = await request.get(`${base}/`, { maxRedirects: 0, headers: cookie ? { cookie } : {} });
  return { status: res.status(), location: res.headers()['location'] };
}

test.beforeEach(async ({ page }) => { await signIn(page); });

test('по умолчанию / открывает новую панель, «Классическая панель» — в меню аккаунта или в «Ещё»', async ({ page, request }) => {
  expect(await rootStatus(request)).toEqual({ status: 302, location: '/next/' });
  await page.goto('/');
  await expect(page).toHaveURL(/\/next\/(chats|today)?$/);
  await classicLink(page);
});

test('ссылка из уведомления /#c<id> открывает диалог в новой панели', async ({ page, request }) => {
  const id = (await openItems(request))[0]!.id;
  await page.goto(`/#c${id}`);
  await expect(page).toHaveURL(new RegExp(`/next/chats/${id}$`));
});

test('«Классическая панель» — классика, и / помнит выбор (cookie ui)', async ({ page, context }) => {
  await page.goto('/next/today');
  await (await classicLink(page)).click();
  await expect(classicNav(page)).toBeAttached();
  expect(new URL(page.url()).pathname).toBe('/');
  expect((await context.cookies()).find((cookie) => cookie.name === 'ui')?.value).toBe('classic');
  await page.goto('/');
  await expect(classicNav(page)).toBeAttached();
  expect(new URL(page.url()).pathname).toBe('/');
  // «Попробовать новую панель» в классике — обратно, выбор тоже запоминается.
  await page.goto('/?ui=next');
  await expect(page).toHaveURL(/\/next\//);
  expect((await context.cookies()).find((cookie) => cookie.name === 'ui')?.value).toBe('next');
});

test('?ui=classic открывает классику с диалогом и разделом из адреса', async ({ page, request }) => {
  const id = (await openItems(request))[0]!.id;
  await page.goto(`/?ui=classic#c${id}`);
  await expect(classicNav(page)).toBeAttached();
  expect(new URL(page.url()).pathname).toBe('/');
  await page.goto('about:blank');
  await page.goto('/?ui=classic#v=kb');
  // Классика открывает раздел из адреса после загрузки списка — это дольше обычного ожидания.
  await expect(classicNav(page, 'kb')).toHaveAttribute('aria-current', 'true', { timeout: 20_000 });
});

test('старые адреса классики /#v=<раздел> ведут в тот же раздел новой панели', async ({ page }) => {
  for (const [view, path] of [['kb', '/next/knowledge'], ['nodes', '/next/system/servers'], ['stats', '/next/reports'],
    ['queue', '/next/reports/sla'], ['team', '/next/team'], ['settings', '/next/system'], ['lab', '/next/assistant']] as const) {
    await page.goto(`/#v=${view}`);
    await expect(page, view).toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}$`));
  }
  await page.goto('/#v=nope');
  await expect(page).toHaveURL(/\/next\/(chats|today)?#v=nope$/);
});

test('«Система → Панель»: классика для всей установки и «Отменить»', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'меняет настройку общей базы — один раз');
  try {
    await page.goto('/next/system/panel');
    const group = page.getByRole('group', { name: 'Какая панель открывается по адресу панели' });
    await expect(group.getByRole('radio', { name: /^Новая/ })).toBeChecked();
    await group.getByRole('radio', { name: /^Классическая/ }).click();
    await expect(page.getByText('Теперь по умолчанию открывается классическая панель')).toBeVisible();
    // Устройство без выбора — классика; выбравший новую на своём устройстве остаётся в ней.
    expect((await rootStatus(request)).status).toBe(200);
    expect(await rootStatus(request, '', 'ui=next')).toEqual({ status: 302, location: '/next/' });
    await page.getByRole('button', { name: 'Отменить' }).click();
    await expect(group.getByRole('radio', { name: /^Новая/ })).toBeChecked();
    await expect.poll(async () => (await rootStatus(request)).status).toBe(302);
  } finally {
    await request.post('/api/settings', { headers: auth, data: { uiDefault: 'next' } });
  }
});

test('PANEL_UI=classic: классика для всех, переключатель в «Системе» закрыт', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'отдельный сервер — один раз');
  expect((await rootStatus(request, CLASSIC_BASE)).status).toBe(200);
  expect(await rootStatus(request, CLASSIC_BASE, 'ui=next')).toEqual({ status: 302, location: '/next/' });
  const locked = await request.post(`${CLASSIC_BASE}/api/settings`, { headers: auth, data: { uiDefault: 'next' } });
  expect(locked.status()).toBe(409);
  await page.goto(`${CLASSIC_BASE}/`);
  await expect(classicNav(page)).toBeAttached();
  expect(new URL(page.url()).pathname).toBe('/');
  await page.goto(`${CLASSIC_BASE}/next/system/panel`);
  const group = page.getByRole('group', { name: 'Какая панель открывается по адресу панели' });
  await expect(group.getByRole('radio', { name: /^Классическая/ })).toBeChecked();
  await expect(group.getByRole('radio', { name: /^Новая/ })).toBeDisabled();
  await expect(page.getByText('Задано на сервере переменной PANEL_UI — поменять можно только там.')).toBeVisible();
});
