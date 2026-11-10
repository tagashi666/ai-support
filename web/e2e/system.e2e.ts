/**
 * «Система» (план, этап 6: 6.9): вердикт и строка неполадки → «Серверы», имя «для помощника»
 * (Enter, Esc), уведомления (смена уровня и «Отменить», тест), откат — лист яруса 2,
 * axe на вкладках и листах в обеих темах, 390 без горизонтальной прокрутки.
 * Установка обновления меняет поддельное состояние (после неё «обновить» больше нечего),
 * поэтому тест установки стоит последним и сам пропускается, если обновление уже стоит.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { api, expectNoHorizontalScroll, signIn } from './helpers';

interface NodesBody { nodes: Array<{ name: string; aliasKey?: string; rawName: string; alias: string | null }> }
interface NotifyBody { configured: boolean; level: 'all' | 'important' | 'minimal' }

async function serious(page: Page): Promise<string[]> {
  await page.evaluate(async () => { await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))); });
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.slice(0, 3).map((node) => node.target.join(' ')).join(' | ')}`);
}
function expectClean(found: string[]): void {
  expect(found, JSON.stringify(found)).toEqual([]);
}

const LEVEL_NAME = { all: 'Каждое событие', important: 'Только то, что требует вмешательства', minimal: 'Только передачи и просрочки' } as const;

test.beforeEach(async ({ page }) => { await signIn(page); });

test('вердикт с неполадкой «Франкфурт-2»; строка неполадки открыта и ведёт в «Серверы»', async ({ page }) => {
  await page.goto('/next/system');
  await expect(page.getByRole('heading', { name: 'Система', level: 1 }), 'вердикт, шаг 1').toBeVisible();
  // Сервер не отвечает — неполадка (как на «Сегодня»): «Есть неисправность»; при одних предупреждениях — «Есть что проверить: N».
  await expect(page.getByRole('status').filter({ hasText: /Есть неисправность|Есть что проверить: \d+/ }), 'вердикт, шаг 2').toBeVisible();
  await expect(page.getByText(/Сервер Франкфурт-2 не отвечает/).first(), 'вердикт, шаг 3').toBeVisible();
  await expect(page.getByText(/проверено в \d\d:\d\d/), 'вердикт, шаг 4').toBeVisible();
  await expect(page.getByRole('button', { name: 'Проверить сейчас' }), 'вердикт, шаг 5').toBeVisible();
  // «Что проверено»: красное и янтарное сверху — «Серверы» выше «Приложения».
  const names = await page.locator('button[aria-expanded]').filter({ hasText: /Приложение|Серверы/ }).allInnerTexts();
  expect(names[0]).toContain('Серверы');
  await expectNoHorizontalScroll(page);

  await page.getByRole('button', { name: 'Приложение' }).click();
  await expect(page.getByText('Время работы'), 'вердикт, шаг 6').toBeVisible();
  // Второй кнопки «Подробнее» в вердикте нет (R-28): путь — строка «Серверы» → «Открыть серверы».
  await expect(page.getByRole('button', { name: 'Подробнее' })).toHaveCount(0);
  await page.locator('button[aria-expanded]').filter({ hasText: 'Серверы' }).click();
  await page.getByRole('button', { name: 'Открыть серверы' }).click();
  await expect(page).toHaveURL(/\/next\/system\/servers$/);
  await expect(page.getByText('Франкфурт-2').first(), 'вердикт, шаг 7').toBeVisible();
  await expect(page.getByText(/отвечают, 1 выключен|отвечает, 1 выключен/), 'вердикт, шаг 8').toBeVisible();
});

test('«Для специалистов» раскрывается: настройки поверх файла, курсоры, счётчики', async ({ page }) => {
  await page.goto('/next/system');
  await page.getByRole('button', { name: 'Для специалистов' }).click();
  await expect(page.getByText('Настройки, заданные в панели поверх файла настроек')).toBeVisible();
  await expect(page.getByText('Сколько записей в базе')).toBeVisible();
  await expect(page.getByText('Доступ Remnawave').first()).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('уведомления: «Отправить тест» из проверок здоровья', async ({ page }) => {
  await page.goto('/next/system');
  await page.getByRole('button', { name: 'Уведомления' }).first().click();
  await page.getByRole('button', { name: 'Отправить тест' }).click();
  await expect(page.getByText('Отправлено — проверьте служебный чат.')).toBeVisible();
});

test('сервер: имя «для помощника» — Enter сохраняет, Esc отменяет', async ({ page, request }) => {
  await page.goto('/next/system/servers');
  await expect(page.getByText(/Данные от \d\d:\d\d/)).toBeVisible();
  await expect(page.getByText(/не отвечает/).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  const field = page.getByLabel('Имя для помощника: Франкфурт-2');
  await field.fill('Германия 2');
  await field.press('Enter');
  await expect(page.getByText('Сохранено ✓')).toBeVisible();
  const saved = await api<NodesBody>(request, '/api/nodes');
  expect(saved.nodes.find((n) => n.name === 'Франкфурт-2')?.alias).toBe('Германия 2');

  await field.fill('Другое имя');
  await field.press('Escape');
  await expect(field).toHaveValue('Германия 2');
  expect((await api<NodesBody>(request, '/api/nodes')).nodes.find((n) => n.name === 'Франкфурт-2')?.alias).toBe('Германия 2');

  // Вернуть как было: пустое имя снимает псевдоним.
  await field.fill('');
  await field.press('Enter');
  await expect(page.getByText('Сохранено ✓')).toBeVisible();
  expect((await api<NodesBody>(request, '/api/nodes')).nodes.find((n) => n.name === 'Франкфурт-2')?.alias ?? null).toBeNull();
});

test('уведомления: смена уровня применяется сразу, «Отменить» возвращает; тест отправляется', async ({ page, request }) => {
  const before = (await api<NotifyBody>(request, '/api/system/notifications')).level;
  const next = before === 'minimal' ? 'important' : 'minimal';
  await page.goto('/next/system/notifications');
  await expect(page.getByRole('group', { name: 'Что присылать в Telegram' })).toBeVisible();
  await page.getByRole('radio', { name: new RegExp(`^${LEVEL_NAME[next]}`) }).click();
  await expect(page.getByText(`Теперь присылаем: ${LEVEL_NAME[next]}`)).toBeVisible();
  await expect.poll(async () => (await api<NotifyBody>(request, '/api/system/notifications')).level).toBe(next);
  await page.getByRole('button', { name: 'Отменить' }).click();
  await expect.poll(async () => (await api<NotifyBody>(request, '/api/system/notifications')).level).toBe(before);
  await expect(page.getByRole('radio', { name: new RegExp(`^${LEVEL_NAME[before]}`) })).toBeChecked();

  await page.getByRole('button', { name: 'Отправить тест' }).click();
  await expect(page.getByText('Отправлено — проверьте служебный чат.')).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('откат: лист второго яруса открывается и закрывается «Отмена»', async ({ page }) => {
  await page.goto('/next/system/update');
  await expect(page.getByText(/Сейчас \d+\.\d+\.\d+\./)).toBeVisible();
  await page.getByRole('button', { name: /^Расширенно/ }).click();
  await page.getByRole('button', { name: 'Откатить…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Откатить на прежнюю версию?' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/Данные не удаляются/)).toBeVisible();
  await sheet.getByRole('button', { name: 'Отмена' }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole('button', { name: /^История операций/ }).click();
  await expectNoHorizontalScroll(page);
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe · система · ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    test('пять вкладок', async ({ page }) => {
      await page.goto('/next/system');
      await expect(page.getByText(/Есть что проверить|Всё в порядке|Есть неисправность/)).toBeVisible();
      await page.getByRole('button', { name: 'Для специалистов' }).click();
      await page.getByRole('button', { name: 'Приложение' }).click();
      expectClean(await serious(page));
      await page.goto('/next/system/servers');
      await expect(page.getByText(/Данные от \d\d:\d\d/)).toBeVisible();
      expectClean(await serious(page));
      await page.goto('/next/system/notifications');
      await expect(page.getByRole('group', { name: 'Что присылать в Telegram' })).toBeVisible();
      expectClean(await serious(page));
      await page.goto('/next/system/panel');
      await expect(page.getByRole('group', { name: 'Какая панель открывается по адресу панели' })).toBeVisible();
      expectClean(await serious(page));
      await page.goto('/next/system/update');
      await expect(page.getByText(/Сейчас \d+\.\d+\.\d+\./)).toBeVisible();
      await page.getByRole('button', { name: /^Расширенно/ }).click();
      await page.getByRole('button', { name: /^История операций/ }).click();
      expectClean(await serious(page));
    });

    test('листы: откат и обновление', async ({ page }) => {
      await page.goto('/next/system/update');
      await expect(page.getByText(/Сейчас \d+\.\d+\.\d+\./)).toBeVisible();
      await page.getByRole('button', { name: /^Расширенно/ }).click();
      await page.getByRole('button', { name: 'Откатить…' }).click();
      await expect(page.getByRole('dialog', { name: 'Откатить на прежнюю версию?' })).toBeVisible();
      expectClean(await serious(page));
      await page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click();
      const open = page.getByRole('button', { name: /^Обновить до \d+\.\d+\.\d+…$/ });
      if (await open.count() > 0) {
        await open.click();
        await expect(page.getByRole('dialog', { name: /^Обновить до \d+\.\d+\.\d+\?$/ })).toBeVisible();
        expectClean(await serious(page));
      }
    });
  });
}

test('телефон: вкладки без горизонтальной прокрутки', async ({ page }) => {
  const screens: Array<[string, RegExp]> = [
    ['/next/system', /Есть что проверить|Всё в порядке|Есть неисправность/],
    ['/next/system/servers', /Данные от \d\d:\d\d/],
    ['/next/system/update', /Сейчас \d+\.\d+\.\d+\./],
    ['/next/system/notifications', /Что присылать в Telegram/],
    ['/next/system/panel', /Какая панель открывается/],
  ];
  for (const [path, ready] of screens) {
    await page.goto(path);
    await expect(page.getByRole('tablist', { name: 'Система' })).toBeVisible();
    await expect(page.getByText(ready).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
});

// Последним: после установки поддельное обновление считается установленным.
test('обновление: лист с «Что нового» → шаги → «Готово»', async ({ page }) => {
  await page.goto('/next/system/update');
  await expect(page.getByText(/Сейчас \d+\.\d+\.\d+\./)).toBeVisible();
  const open = page.getByRole('button', { name: /^Обновить до \d+\.\d+\.\d+…$/ });
  test.skip(await open.count() === 0, 'обновление уже установлено в этом прогоне');
  const label = (await open.innerText()).replace('…', '');
  await open.click();
  const sheet = page.getByRole('dialog', { name: `${label}?` });
  await expect(sheet.getByText('Что нового', { exact: true })).toBeVisible();
  await expect(sheet.getByText('Отчёты и сроки ответа в новой панели')).toBeVisible();
  await expect(sheet.getByText('Что произойдёт')).toBeVisible();
  await expect(sheet.getByText(/Сделаем копию/)).toBeVisible();
  await expect(sheet.getByText(/сами вернём/)).toBeVisible();
  await sheet.getByRole('button', { name: label, exact: true }).click();
  await expect(sheet).toBeHidden();
  const progress = page.getByRole('region', { name: 'Ход операции' });
  await expect(progress).toBeVisible();
  await expect(progress.getByText('Копия').first()).toBeVisible();
  await expect(progress.getByText(/Установлена версия/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Это последняя версия/)).toBeVisible();
  await expectNoHorizontalScroll(page);
});
