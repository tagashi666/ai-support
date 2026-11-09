/**
 * axe на главных экранах (план, 11.6 «Доступность»): список, диалог,
 * «Клиент» — в светлой и тёмной теме. Серьёзных и критических нарушений нет.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signIn, threadWithDraft } from './helpers';

async function serious(page: Page): Promise<string[]> {
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
  });
}
