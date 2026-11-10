/**
 * Палитра ⌘K (6.5), клавиши по event.code (7.3) и «Это устройство» (6.12).
 */
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

test.beforeEach(async ({ page }) => { await signIn(page); });

/** Нажатие в русской раскладке: физическая клавиша K, символ «л». */
async function russianModK(page: Page): Promise<void> {
  await page.evaluate(() => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'л', metaKey: mac, ctrlKey: !mac, bubbles: true }));
  });
}

test('⌘K в русской раскладке: найти диалог и открыть с клавиатуры', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'клавиатура — на компьютере');
  await page.goto('/next/chats');
  await expect(page.locator('[data-row-id]').first()).toBeVisible();
  await russianModK(page);
  const palette = page.getByRole('dialog', { name: 'Поиск и команды' });
  await expect(palette).toBeVisible();
  const box = palette.getByRole('combobox');
  await expect(box).toBeFocused();
  await box.fill('Олег');
  const option = palette.getByRole('option', { name: /Олег Т\./ }).first();
  await expect(option).toBeVisible();
  // ↓ до первого диалога и Enter.
  while (!(await option.getAttribute('aria-selected'))?.includes('true')) await box.press('ArrowDown');
  await box.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(/\/next\/chats\/\d+$/);
});

test('«?» — список клавиш, «]» — следующий диалог; одиночные буквы выключены', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'клавиатура — на компьютере');
  await page.goto('/next/chats');
  await page.locator('[data-row-id]').first().click();
  await expect(page).toHaveURL(/\/next\/chats\/\d+$/);
  const first = page.url();
  await page.locator('main').click({ position: { x: 600, y: 20 } }).catch(() => undefined);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Shift+Slash');
  const help = page.getByRole('dialog', { name: 'Клавиши' });
  await expect(help).toBeVisible();
  await expect(help.getByText('Одной буквой · выключено')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await page.keyboard.press('BracketRight');
  await expect(page).not.toHaveURL(first);
  // E по умолчанию ничего не делает (14.7).
  const url = page.url();
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(300);
  await expect(page.getByRole('button', { name: 'Отменить' })).toHaveCount(0);
  expect(page.url()).toBe(url);
});

test('«Это устройство»: тема и размер текста — сразу и в общем ключе темы', async ({ page }) => {
  await page.goto('/next/device');
  await page.getByRole('radiogroup', { name: 'Тема' }).getByRole('radio', { name: 'Тёмная' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('dark');
  await page.getByRole('radiogroup', { name: 'Размер текста' }).getByRole('radio', { name: '125%' }).check();
  expect(await page.evaluate(() => document.documentElement.style.fontSize)).toBe('125%');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('radiogroup', { name: 'Тема' }).getByRole('radio', { name: 'Авто' }).check();
  await page.getByRole('radiogroup', { name: 'Размер текста' }).getByRole('radio', { name: '100%' }).check();
  expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('system');
});

test('«Это устройство» целиком: плотность, стартовый экран, Enter отправляет, звук (6.12)', async ({ page }) => {
  await page.goto('/next/device');
  await page.getByRole('radiogroup', { name: 'Плотность' }).getByRole('radio', { name: 'Компактно' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await page.getByRole('radiogroup', { name: 'Начинать с' }).getByRole('radio', { name: 'Сегодня' }).check();
  await page.getByRole('switch', { name: /Enter отправляет ответ/ }).check();
  await page.getByRole('switch', { name: /Звук, когда прибавилось/ }).check();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await expect(page.getByRole('switch', { name: /Enter отправляет ответ/ })).toBeChecked();
  await page.goto('/next/');
  await expect(page).toHaveURL(/\/next\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Добр(ое|ый|ой)/);
  await page.goto('/next/device');
  await page.getByRole('radiogroup', { name: 'Плотность' }).getByRole('radio', { name: 'Просторно' }).check();
  await page.getByRole('radiogroup', { name: 'Начинать с' }).getByRole('radio', { name: 'По экрану' }).check();
  await page.getByRole('switch', { name: /Enter отправляет ответ/ }).uncheck();
  await page.getByRole('switch', { name: /Звук, когда прибавилось/ }).uncheck();
  await expect(page.locator('html')).not.toHaveAttribute('data-density', 'compact');
});
