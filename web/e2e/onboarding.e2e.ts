/**
 * Первый запуск и обучение (6.13), уведомления в панели (7.7): чек-лист по
 * фактам на «Сегодня», учебный диалог без запросов к серверу и вне счётчиков,
 * «Это устройство → Показать чек-лист запуска», подсказки нового оператора,
 * заголовок вкладки и тост «… ждёт вас». axe на новых экранах в обеих темах.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openItems, signIn, TOKEN } from './helpers';

async function serious(page: Page): Promise<string[]> {
  await page.evaluate(async () => { await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))); });
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return result.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.slice(0, 3).map((node) => node.target.join(' ')).join(' | ')}`);
}

test('владелец: чек-лист по фактам, учебный диалог из пяти заданий без запросов, чек-лист снова из «Этого устройства»', async ({ page }) => {
  await signIn(page, { fresh: true });
  await page.goto('/next/today');
  const list = page.getByRole('region', { name: 'Начало работы' });
  await expect(list).toBeVisible();
  // В синтетике канал, модель, статьи и коллега есть — открыт только учебный диалог.
  await expect(list.getByRole('heading')).toHaveText(/НАЧАЛО РАБОТЫ · 5 ИЗ 6|Начало работы · 5 из 6/i);
  await list.getByRole('button', { name: 'Открыть' }).click();
  await expect(page).toHaveURL(/\/next\/chats\/learn$/);
  await expect(page.getByText('Учебный диалог: клиенту ничего не уходит, в отчёты не попадает.')).toBeVisible();

  // Учебный диалог живёт в браузере: ни одного запроса к диалогам и ответам.
  const calls: string[] = [];
  page.on('request', (request) => { if (/\/api\/(conversations|suggestions|thread)/.test(request.url())) calls.push(request.url()); });
  const draft = page.getByRole('region', { name: 'Черновик помощника · Уверен' });
  await draft.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.getByText('Учебный диалог: клиенту ничего не ушло').first()).toBeVisible();
  await draft.getByRole('button', { name: 'Править' }).click();
  const field = page.getByRole('textbox', { name: 'Ваш ответ…' });
  await expect(field).toBeFocused();
  await field.press('End');
  await field.pressSequentially(' Если не выйдет — напишите.');
  await page.getByRole('button', { name: 'Отправить', exact: true }).last().click();
  await page.getByRole('tab', { name: 'Заметка' }).click();
  await page.getByRole('textbox', { name: /Заметка для команды/ }).fill('Клиент на iOS');
  await page.getByRole('button', { name: 'Сохранить заметку' }).click();
  await page.getByRole('button', { name: 'Решено' }).click();
  await page.getByRole('button', { name: 'Отменить' }).click();
  await expect(page.getByText('Сделано 5 из 5')).toBeVisible();
  expect(calls, 'запросы из учебного диалога').toEqual([]);

  // Ни в одном счётчике: заголовок вкладки и бейдж «Диалогов» — только настоящие «Ждут вас».
  const items = await openItems(page.request);
  const mine = items.filter((item) => item.section === 'mine').length;
  await expect(page).toHaveTitle(new RegExp(`^\\(${mine}\\) `));

  await page.goto('/next/today');
  await expect(list.getByText('6. Попробовать на учебном диалоге')).toBeVisible();
  await expect(list.locator('li[data-state="todo"]')).toHaveCount(0);
  await list.getByRole('button', { name: 'Скрыть, вернусь позже' }).click();
  await expect(list).toBeHidden();
  await page.goto('/next/device');
  await page.getByRole('button', { name: 'Показать чек-лист запуска' }).click();
  await page.goto('/next/today');
  await expect(page.getByRole('region', { name: 'Начало работы' })).toBeVisible();
});

test('учебный диалог стоит над секциями и закрывается', async ({ page }) => {
  await signIn(page, { fresh: true });
  await page.goto('/next/chats');
  const row = page.locator('[data-tutorial="true"]');
  await expect(row).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Учебный диалог · не в счётчиках' })).toBeVisible();
  await row.getByRole('button').click();
  await page.getByRole('button', { name: 'Закрыть учебный диалог' }).click();
  await expect(page).toHaveURL(/\/next\/chats$/);
  await expect(page.locator('[data-tutorial="true"]')).toHaveCount(0);
});

test('новый оператор: три подсказки и строка о роли, один раз на устройстве', async ({ page, request }) => {
  const created = await request.post('/api/operators', { headers: { authorization: `Bearer ${TOKEN}` }, data: { name: `Новичок ${Date.now() % 100000}`, role: 'agent' } });
  const { token } = await created.json() as { token: string };
  await signIn(page, { token, fresh: true });
  await page.goto('/next/today');
  await expect(page.getByText('1 из 3')).toBeVisible();
  await expect(page.getByText('Вы — Оператор: отвечаете клиентам и пишете заметки.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Дальше' }).click();
  await expect(page.getByText(/Черновик помощника: вы решаете/)).toBeVisible();
  await page.getByRole('button', { name: 'Дальше' }).click();
  await page.getByRole('button', { name: 'Понятно' }).click();
  await expect(page.getByText('1 из 3')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('1 из 3')).toHaveCount(0);
  await page.goto('/next/device');
  await page.getByRole('button', { name: 'Показать подсказки заново' }).click();
  await page.goto('/next/today');
  await expect(page.getByText('1 из 3')).toBeVisible();
});

test('«… ждёт вас»: тост в другом разделе, число в заголовке, точка на значке', async ({ page, request }) => {
  await signIn(page);
  await page.goto('/next/today');
  await expect(page).toHaveTitle(/^\(\d+\) /);
  expect(await page.locator('link[rel="icon"]').getAttribute('href')).toMatch(/^data:image\/svg\+xml/);
  const target = (await openItems(request)).find((item) => item.section === 'ai' && !item.owner);
  test.skip(!target, 'в синтетике нет диалога у помощника');
  await request.post(`/api/conversations/${target!.id}/state`, { headers: { authorization: `Bearer ${TOKEN}` }, data: { handoff: true } });
  const toast = page.getByRole('status').filter({ hasText: 'ждёт вас' });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Открыть' }).click();
  await expect(page).toHaveURL(new RegExp(`/next/chats/${target!.id}$`));
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe · обучение · ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test('чек-лист на «Сегодня» и учебный диалог', async ({ page }) => {
      await signIn(page, { fresh: true });
      await page.goto('/next/today');
      await expect(page.getByRole('region', { name: 'Начало работы' })).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.goto('/next/chats/learn');
      await expect(page.getByText('Задания')).toBeVisible();
      expect(await serious(page)).toEqual([]);
    });
  });
}

test('клавиатура: «Ответ / Заметка» стрелками, в учебном диалоге тоже (8.7)', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'клавиатура — на компьютере');
  await signIn(page);
  const target = (await openItems(request)).find((item) => !item.owner && item.state !== 'done' && item.channel === 'telegram')!;
  await page.goto(`/next/chats/${target.id}`);
  const reply = page.getByRole('tab', { name: 'Ответ' });
  await reply.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /Заметка/ })).toBeFocused();
  await expect(page.getByRole('tab', { name: /Заметка/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(reply).toHaveAttribute('aria-selected', 'true');
  await page.goto('/next/chats/learn');
  await page.getByRole('tab', { name: 'Ответ' }).focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Заметка' })).toHaveAttribute('aria-selected', 'true');
});
