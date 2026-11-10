/**
 * «Отчёты» (план, 6.8): сводка с общим периодом, «Показать таблицей», ссылки «Требуют внимания»,
 * «По людям» (таблица / карточки), правка цели срока с Enter, фильтр «Просроченные», лист «Сбросить статистику…»
 * (сам сброс не делаем — данные общие), axe на трёх вкладках и листе, 390 без горизонтальной прокрутки.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { api, expectNoHorizontalScroll, signIn, TOKEN } from './helpers';

const auth = { authorization: `Bearer ${TOKEN}` };

interface Policy { priority: string; first_response_minutes: number; resolution_minutes: number }
interface QueueRows { conversations: { id: number; overdue: boolean }[] }
interface People { operators: { name: string }[] }

async function serious(page: Page): Promise<string[]> {
  await page.evaluate(async () => { await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))); });
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.slice(0, 3).map((node) => node.target.join(' ')).join(' | ')}`);
}

test.beforeEach(async ({ page }) => { await signIn(page); });

test('сводка: период общий, смена на 30 дней меняет запрос; «Считаем с …»', async ({ page }) => {
  await page.goto('/next/reports');
  await expect(page.getByRole('heading', { name: 'Отчёты', level: 1 })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Сводка' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Ждут человека').first()).toBeVisible();
  await expect(page.getByText(/^Считаем с /)).toBeVisible();
  await expect(page.getByRole('radio', { name: '7 дней' })).toBeChecked();
  const asked = page.waitForRequest((request) => request.url().includes('/api/stats?days=30'));
  await page.getByRole('radio', { name: '30 дней' }).check();
  await asked;
  await expect(page.getByRole('radio', { name: '30 дней' })).toBeChecked();
  // Период общий: он же на «По людям» и помнится на устройстве.
  const people = page.waitForRequest((request) => request.url().includes('/api/operator-stats?days=30'));
  await page.getByRole('tab', { name: 'По людям' }).click();
  await people;
  await expect(page).toHaveURL(/\/next\/reports\/people$/);
  expect(await page.evaluate(() => localStorage.getItem('next.reportsPeriod'))).toBe('30');
  await page.getByRole('radio', { name: '7 дней' }).check();
  await expectNoHorizontalScroll(page);
});

test('сводка: «Показать таблицей» и «важные ›» открывает Диалоги с фильтром', async ({ page }) => {
  await page.goto('/next/reports');
  await expect(page.getByText('Ждут человека').first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Показать таблицей' }).click();
  await expect(page.getByRole('table', { name: 'Когда пишут (часы)' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Сообщений от клиентов по дням' })).toBeVisible();
  await page.getByRole('button', { name: 'Показать столбиками' }).click();
  await expect(page.getByRole('table')).toHaveCount(0);

  await expect(page.getByText('Требуют внимания').first()).toBeVisible();
  await page.getByRole('link', { name: /^важные/ }).click();
  await expect(page).toHaveURL(/\/next\/chats$/);
  const saved = await page.evaluate(() => localStorage.getItem('next.chatsFilter'));
  expect(JSON.parse(saved ?? '{}')).toMatchObject({ important: true });
  // Не оставляем фильтр соседним тестам.
  await page.evaluate(() => localStorage.removeItem('next.chatsFilter'));
});

test('по людям: таблица на компьютере, карточки на телефоне', async ({ page, request }, info) => {
  const { operators } = await api<People>(request, '/api/operator-stats?days=7');
  expect(operators.length).toBeGreaterThan(0);
  await page.goto('/next/reports/people');
  await expect(page.getByRole('tab', { name: 'По людям' })).toHaveAttribute('aria-selected', 'true');
  if (info.project.name === 'desktop') {
    const table = page.getByRole('table');
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Медиана ответа' })).toBeVisible();
    await expect(table.getByText(operators[0]!.name).first()).toBeVisible();
  } else {
    await expect(page.getByRole('list', { name: 'Люди' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Люди' }).getByText(operators[0]!.name).first()).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  }
});

test('сроки ответа: правка цели «Высокая» — Enter и «Сохранено ✓»', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'цель общая — один проход');
  const before = (await api<{ policies: Policy[] }>(request, '/api/sla')).policies.find((policy) => policy.priority === 'high')!;
  await page.goto('/next/reports/sla');
  await expect(page.getByText('Считаем по календарному времени.')).toBeVisible();
  await expect(page.getByText(/Срок вышел — напомним в Telegram/)).toBeVisible();
  const field = page.getByLabel('Высокая: первый ответ, минут');
  await expect(field).toHaveValue(String(before.first_response_minutes));
  const next = before.first_response_minutes + 1;
  try {
    await field.fill(String(next));
    await field.press('Enter');
    await expect(page.getByText('Сохранено ✓')).toBeVisible();
    const after = (await api<{ policies: Policy[] }>(request, '/api/sla')).policies.find((policy) => policy.priority === 'high')!;
    expect(after.first_response_minutes).toBe(next);
    expect(after.resolution_minutes).toBe(before.resolution_minutes);
  } finally {
    await request.put('/api/sla/high', {
      headers: auth, data: { firstResponseMinutes: before.first_response_minutes, resolutionMinutes: before.resolution_minutes },
    });
  }
  // Неверный ввод не уходит на сервер.
  await page.reload();
  const again = page.getByLabel('Высокая: первый ответ, минут');
  await again.fill('0');
  await again.press('Enter');
  await expect(page.getByText(/Нужно целое число минут от 1 до 10080/)).toBeVisible();
});

test('сроки ответа: фильтр «Просроченные» и открытие диалога', async ({ page, request }) => {
  const queue = await api<QueueRows>(request, '/api/queue');
  const late = queue.conversations.filter((row) => row.overdue);
  expect(late.length, 'в синтетике есть просроченные').toBeGreaterThan(0);
  await page.goto('/next/reports/sla');
  const list = page.getByRole('list', { name: 'Сейчас по срокам' });
  await expect(list.getByRole('link').first()).toBeVisible();
  await page.getByRole('radio', { name: 'Просроченные' }).check();
  await expect(list.getByRole('link')).toHaveCount(late.length);
  for (const link of await list.getByRole('link').all()) await expect(link).toContainText('срок вышел');
  await page.getByRole('radio', { name: 'Никто не ведёт' }).check();
  await expect(list.getByRole('link').first()).toBeVisible();
  for (const link of await list.getByRole('link').all()) await expect(link).not.toContainText(/(^|\s)ведёт\s+[А-ЯЁ]/);
  await expectNoHorizontalScroll(page);
  await page.getByRole('radio', { name: 'Просроченные' }).check();
  await list.getByRole('link').first().click();
  await expect(page).toHaveURL(/\/next\/chats\/\d+$/);
});

test('«Сбросить статистику…»: лист второго яруса, «Отмена» закрывает', async ({ page }) => {
  await page.goto('/next/reports');
  await expect(page.getByText('Ждут человека').first()).toBeVisible();
  await page.getByRole('button', { name: 'Действия с отчётом' }).click();
  await page.getByRole('menuitem', { name: 'Сбросить статистику…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Сбросить статистику?' });
  await expect(sheet.getByText(/Прежние итоги нельзя будет восстановить/)).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Сбросить статистику' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Отмена' }).click();
  await expect(sheet).toBeHidden();
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe · отчёты · ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    test('сводка, по людям, сроки ответа и лист сброса', async ({ page }) => {
      await page.goto('/next/reports');
      await expect(page.getByText('Ждут человека').first()).toBeVisible();
      expect(await serious(page), 'сводка').toEqual([]);
      await page.getByRole('button', { name: 'Показать таблицей' }).click();
      await expect(page.getByRole('table', { name: 'Когда пишут (часы)' })).toBeVisible();
      expect(await serious(page), 'сводка, таблицы').toEqual([]);

      await page.goto('/next/reports/people');
      await expect(page.getByRole('tab', { name: 'По людям' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByText('Обработано').first()).toBeVisible();
      expect(await serious(page), 'по людям').toEqual([]);

      await page.goto('/next/reports/sla');
      await expect(page.getByRole('list', { name: 'Сейчас по срокам' }).getByRole('link').first()).toBeVisible();
      expect(await serious(page), 'сроки ответа').toEqual([]);

      await page.goto('/next/reports');
      await expect(page.getByText('Ждут человека').first()).toBeVisible();
      await page.getByRole('button', { name: 'Действия с отчётом' }).click();
      await page.getByRole('menuitem', { name: 'Сбросить статистику…' }).click();
      await expect(page.getByRole('dialog', { name: 'Сбросить статистику?' })).toBeVisible();
      expect(await serious(page), 'лист сброса').toEqual([]);
    });
  });
}
