/**
 * axe на главных экранах (план, 11.6 «Доступность»): список, диалог,
 * «Клиент», палитра, «Это устройство», «Сегодня», «Помощник» и «Знания» — в светлой и тёмной теме. Серьёзных и критических нарушений нет.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signIn, threadWithDraft } from './helpers';

async function serious(page: Page): Promise<string[]> {
  // Лист открывается с проявлением: контраст на середине анимации axe считает неверно.
  await page.evaluate(async () => { await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))); });
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.slice(0, 3).map((node) => node.target.join(' ')).join(' | ')}`);
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe · ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test.beforeEach(async ({ page }) => { await signIn(page); });

    test('список диалогов', async ({ page }) => {
      await page.goto('/next/chats');
      await expect(page.locator('[data-row-id]').first()).toBeVisible();
      expect(await serious(page)).toEqual([]);
    });

    test('диалог с черновиком', async ({ page, request }) => {
      const id = await threadWithDraft(request, 'check');
      await page.goto(`/next/chats/${id}`);
      await expect(page.getByRole('region', { name: 'Черновик помощника' })).toBeVisible();
      expect(await serious(page)).toEqual([]);
    });

    test('клиент', async ({ page, request }) => {
      const id = await threadWithDraft(request, 'check');
      await page.goto(`/next/chats/${id}/client`);
      await expect(page.getByRole('heading', { name: 'Клиент' }).first()).toBeVisible();
      await expect(page.getByText('Подписка', { exact: true }).first()).toBeVisible();
      expect(await serious(page)).toEqual([]);
    });

    test('«Сегодня» и «Помощник» (этап 4)', async ({ page }) => {
      await page.goto('/next/today');
      await expect(page.getByRole('region', { name: 'Помощник' })).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.goto('/next/assistant');
      await expect(page.getByRole('radiogroup', { name: 'Как помощник отвечает клиентам' })).toBeVisible();
      await expect(page.getByRole('spinbutton').first()).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.getByRole('radio', { name: /^Отвечает сам/ }).click();
      await expect(page.getByRole('dialog', { name: 'Включить «Отвечает сам»?' })).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.goto('/next/assistant/activity');
      await expect(page.getByRole('list', { name: 'Что делал помощник' })).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.goto('/next/assistant/voice');
      await expect(page.getByRole('textbox', { name: 'Название сервиса' })).toBeVisible();
      expect(await serious(page)).toEqual([]);
    });

    test('палитра и «Это устройство»', async ({ page }) => {
      await page.goto('/next/device');
      await expect(page.getByRole('heading', { name: 'Это устройство' })).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.goto('/next/chats');
      await page.keyboard.press('ControlOrMeta+KeyK');
      await expect(page.getByRole('dialog', { name: 'Поиск и команды' })).toBeVisible();
      expect(await serious(page)).toEqual([]);
    });

    test('«Знания»: статьи, редактор, лист публикации, идеи, шаблоны (этап 5)', async ({ page }) => {
      await page.goto('/next/knowledge');
      await expect(page.getByRole('list', { name: 'Статьи' })).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.goto('/next/knowledge/articles/skorost');
      await expect(page.getByLabel('Текст статьи')).toBeVisible();
      await expect(page.getByText(/Изменения против опубликованной/).first()).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.getByRole('button', { name: 'Опубликовать…' }).click();
      await expect(page.getByRole('dialog', { name: 'Опубликовать статью?' })).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.keyboard.press('Escape');
      await page.goto('/next/knowledge/ideas');
      await expect(page.getByRole('list', { name: 'Идеи из диалогов' })).toBeVisible();
      await page.getByRole('list', { name: 'Идеи из диалогов' }).getByRole('button').first().click();
      await expect(page.getByRole('button', { name: 'Опубликовать для помощника' })).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.goto('/next/knowledge/templates');
      await expect(page.getByRole('list', { name: 'Шаблоны' })).toBeVisible();
      expect(await serious(page)).toEqual([]);
      // «Подсказки по кабинету» — только при подключённом Bedolaga (в CI его нет).
      if (await page.getByRole('tab', { name: 'Подсказки по кабинету' }).count()) {
        await page.goto('/next/knowledge/hints');
        await expect(page.getByRole('list', { name: 'Экраны' })).toBeVisible();
        expect(await serious(page)).toEqual([]);
      }
    });
  });
}
