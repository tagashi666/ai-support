/**
 * Каркас R2 (audit/ui-polish/R2-SPEC.md, A1–A4): на широком экране разделы прижаты
 * к навигации и не сжаты в колонку по центру; подписи навигации и аккаунта не
 * выходят за свои строки; ключ root показан как «Владелец». Только desktop-проект:
 * ширины задаются в самих тестах.
 */
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

const SECTIONS = ['today', 'knowledge', 'assistant', 'reports', 'connections', 'team', 'system', 'device'] as const;

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'ширины задаёт тест');
  await signIn(page);
});

/** Левый край контента и ширина его области относительно навигации и окна. */
async function measure(page: Page): Promise<{ navRight: number; left: number; width: number; viewport: number }> {
  return await page.evaluate(() => {
    const nav = [...document.querySelectorAll('nav')].find((el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 200)!;
    const h1 = document.querySelector('main h1')!;
    // Область контента: предок заголовка прямо под прокручиваемым экраном раздела.
    let box: HTMLElement = h1.parentElement!;
    while (box.parentElement && getComputedStyle(box.parentElement).overflowY !== 'auto' && box.parentElement.tagName !== 'MAIN') box = box.parentElement;
    const style = getComputedStyle(box);
    const width = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return { navRight: nav.getBoundingClientRect().right, left: h1.getBoundingClientRect().left, width, viewport: innerWidth };
  });
}

test('2560: каждый раздел начинается у навигации и занимает ≥ 70% ширины (A4)', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  for (const section of SECTIONS) {
    await page.goto(`/next/${section}`);
    await expect(page.locator('main h1')).toBeVisible();
    const m = await measure(page);
    expect(m.left - m.navRight, `${section}: отступ от навигации`).toBeLessThanOrEqual(48);
    expect(m.left - m.navRight, `${section}: не под навигацией`).toBeGreaterThanOrEqual(0);
    expect(m.width / m.viewport, `${section}: ширина области контента`).toBeGreaterThanOrEqual(0.7);
  }
});

test('подписи навигации и аккаунта не выходят за свои строки: 1024, 1440, 2560 (A1, A2)', async ({ page }) => {
  for (const [width, height] of [[1024, 768], [1440, 900], [2560, 1440]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/next/today');
    await expect(page.locator('main h1')).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Разделы' });
    await expect(nav.getByRole('link', { name: /Диалоги/ })).toBeVisible();
    const overflow = await nav.evaluate((root) => [...root.querySelectorAll<HTMLElement>('a, button, a *, button *')]
      .filter((el) => {
        const box = el.getBoundingClientRect();
        // Подпись «только для чтения с экрана» в узкой панели (1×1 px) не видна — её не меряем.
        if (box.width <= 1 || box.height <= 1 || getComputedStyle(el).display === 'none') return false;
        return el.scrollWidth > el.clientWidth + 0.5 && el.clientWidth > 0;
      })
      .map((el) => `${el.tagName}.${el.className}: «${el.textContent}» ${el.scrollWidth}>${el.clientWidth}`));
    expect(overflow, `${width}: выходят за строку`).toEqual([]);
    // Каждая строка навигации — в пределах колонки навигации.
    const outside = await nav.evaluate((root) => {
      const edge = root.getBoundingClientRect().right;
      return [...root.querySelectorAll('a, button')].filter((el) => el.getBoundingClientRect().right > edge + 0.5).map((el) => el.textContent);
    });
    expect(outside, `${width}: за краем навигации`).toEqual([]);
    // Подписи в одну строку: высота пункта как у одного ряда.
    const tall = await nav.evaluate((root) => [...root.querySelectorAll('li > a, li > button')].filter((el) => el.getBoundingClientRect().height > 44).map((el) => el.textContent));
    expect(tall, `${width}: подпись переносится`).toEqual([]);
  }
});

test('ключ root — «Владелец», не «Администратор»: навигация, меню, «Это устройство» (A2)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/next/today');
  const account = page.locator('button[popovertarget="account-menu"]');
  await expect(account).toContainText('Владелец');
  await expect(page.getByRole('navigation', { name: 'Разделы' })).not.toContainText('Администратор');
  await account.click();
  const menu = page.getByRole('menu', { name: 'Аккаунт' });
  await expect(menu.getByRole('menuitemradio', { name: 'Авто' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Классическая панель' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Выйти' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(account).toBeFocused();
  await page.goto('/next/device');
  await expect(page.getByText(/^Вы: Владелец$/)).toBeVisible();
  // Узкая панель (768–1279): только аватар, имя — в подписи кнопки.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(account).toHaveAccessibleName(/Владелец/);
  const nameBox = await account.getByText('Владелец', { exact: true }).boundingBox();
  expect(nameBox?.width ?? 0, 'имя в узкой панели не видно').toBeLessThanOrEqual(1);
});

test('тема из меню аккаунта применяется сразу (A2)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/next/today');
  await page.locator('button[popovertarget="account-menu"]').click();
  await page.getByRole('menuitemradio', { name: 'Тёмная' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('menuitemradio', { name: 'Авто' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
});

test('«Диалоги» без выбранного диалога — тихое состояние, не «Сегодня» (A6)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/next/chats');
  await expect(page.getByText('Выберите диалог', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Сегодня' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Ждут вас', exact: true })).toHaveCount(0);
});
