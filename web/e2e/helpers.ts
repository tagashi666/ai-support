import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { InboxItem, InboxResponse, ThreadResponse } from '@shared/api-types';

export const TOKEN = process.env.E2E_TOKEN ?? 'e2e-key-0123456789abcdef';
const PORT = Number(process.env.E2E_PORT ?? 8197);
export const CONTROL = `http://127.0.0.1:${PORT + 1}`;

/**
 * Ключ общий с классикой (localStorage panelToken) — как будто вы уже вошли.
 * По умолчанию — опытный человек: обучение (6.13) на этом устройстве пройдено;
 * `fresh` — первый вход: чек-лист, подсказки и учебный диалог на месте.
 */
export async function signIn(page: Page, options: { token?: string; fresh?: boolean } = {}): Promise<void> {
  await page.addInitScript(({ token, fresh }) => {
    localStorage.setItem('panelToken', token);
    localStorage.setItem('next.mode', 'live');
    if (!fresh && localStorage.getItem('next.onboarding') === null) {
      localStorage.setItem('next.onboarding', JSON.stringify({ welcomeDone: true, checklistHidden: true, hintsDone: true, tutorialClosed: true }));
    }
  }, { token: options.token ?? TOKEN, fresh: options.fresh ?? false });
}

export async function api<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path, { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(response.ok(), `${path} → ${response.status()}`).toBeTruthy();
  return await response.json() as T;
}

export async function control<T = unknown>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.post(`${CONTROL}${path}`);
  return await response.json() as T;
}

export async function stats(request: APIRequestContext): Promise<{ sent: number; extensions: number }> {
  return await (await request.get(`${CONTROL}/stats`)).json() as { sent: number; extensions: number };
}

export async function openItems(request: APIRequestContext): Promise<InboxItem[]> {
  return (await api<InboxResponse>(request, '/api/inbox?view=open&limit=200')).items;
}

/** Первый открытый диалог, у которого черновик помощника нужного уровня и никто не ведёт. */
export async function threadWithDraft(request: APIRequestContext, level: 'sure' | 'check' | 'unsure'): Promise<number> {
  for (const item of await openItems(request)) {
    if (item.owner || item.channel === 'business') continue;
    const thread = await api<ThreadResponse>(request, `/api/thread/${item.id}`);
    if (thread.suggestion?.level === level && (!thread.head.window.applies || thread.head.window.open)) return item.id;
  }
  throw new Error(`нет диалога с черновиком ${level}`);
}

/** Нет горизонтальной прокрутки страницы. */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow, 'горизонтальная прокрутка').toBeLessThanOrEqual(0);
}

/**
 * «Классическая панель» (R2 A3): от 768 px — пункт меню аккаунта внизу навигации,
 * на телефоне — строка в «Ещё». Возвращает ссылку, уже на виду.
 */
export async function classicLink(page: Page): Promise<Locator> {
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await page.locator('button[popovertarget="account-menu"]').click();
    const item = page.getByRole('menu').getByRole('menuitem', { name: 'Классическая панель' });
    await expect(item).toBeVisible();
    return item;
  }
  await page.getByRole('navigation').getByRole('link', { name: 'Ещё' }).click();
  const link = page.getByRole('link', { name: 'Классическая панель' });
  await expect(link).toBeVisible();
  return link;
}

/** Строки списка в порядке показа. */
export async function rowOrder(page: Page): Promise<string[]> {
  return await page.locator('[data-row-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row-id') ?? ''));
}
