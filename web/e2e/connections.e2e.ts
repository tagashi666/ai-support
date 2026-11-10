/**
 * «Подключения» (план, этап 6: 6.11): карточки каналов, «Как мы представляемся» с примером для клиента,
 * мастер бота (успех и «вернули как было»), «Проверить подключение» у Business, папки (создать, изменить,
 * удалить с «Отменить» и без), axe в обеих темах, телефон без горизонтальной прокрутки.
 * Данные общие на весь прогон: названия уникальны, профиль возвращается как был.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ConnectionsResponse } from '@shared/api-types';
import { api, expectNoHorizontalScroll, signIn, TOKEN } from './helpers';

const auth = { authorization: `Bearer ${TOKEN}` };
const unique = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
/** Выдуманный ключ бота: цифры, двоеточие, ≥20 знаков. */
const botKey = (mark = 'A'): string => `123456789:${mark}${'B'.repeat(24)}`;

interface Meta { folders: Array<{ id: number; name: string; color: string | null; source_ids: string[] }> }

async function waitIdle(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => (await api<{ queued: boolean }>(request, '/api/sources/status')).queued, { timeout: 20_000 }).toBe(false);
}

async function serious(page: Page): Promise<string> {
  // Лист открывается с проявлением: контраст на середине анимации axe считает неверно.
  await page.evaluate(async () => { await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))); });
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = result.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  return bad.length === 0 ? '' : JSON.stringify(bad.map((violation) => [violation.id, violation.nodes.slice(0, 3).map((node) => node.target.join(' ')).join(' | ')]));
}

async function runWizard(page: Page, request: APIRequestContext, name: string, key: string): Promise<void> {
  await waitIdle(request);
  await page.goto('/next/connections');
  await page.getByRole('button', { name: 'Подключить канал или источник' }).click();
  const wizard = page.getByRole('dialog');
  await expect(wizard.getByText('1 из 3')).toBeVisible();
  await expect(wizard.getByRole('radio', { name: /Telegram-бот/ })).toBeChecked();
  await wizard.getByRole('button', { name: 'Дальше' }).click();
  await expect(wizard.getByText('2 из 3')).toBeVisible();
  await wizard.getByLabel('Название', { exact: true }).fill(name);
  await wizard.getByLabel('Ключ', { exact: true }).fill(key);
  await wizard.getByRole('button', { name: 'Подключить и проверить' }).click();
}

test.beforeEach(async ({ page }) => { await signIn(page); });

test('карточки: бот, Business, Bedolaga, Remnawave, MiniShop — состояние словом', async ({ page }) => {
  await page.goto('/next/connections');
  await expect(page.getByRole('heading', { name: 'Подключения', level: 1 })).toBeVisible();
  const bot = page.getByRole('region', { name: 'Telegram-бот «Поддержка»' });
  await expect(bot.getByText('работает', { exact: true })).toBeVisible();
  await expect(bot.getByRole('button', { name: 'Как мы представляемся' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Telegram Business', exact: true }).getByText(/^(подключён|выключен|не подключён)$/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Bedolaga', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Remnawave', exact: true }).getByText(/^подключено · (только чтение|действия разрешены)$/)).toBeVisible();
  const shop = page.getByRole('region', { name: 'MiniShop', exact: true });
  await expect(shop.getByText('не подключён', { exact: true })).toBeVisible();
  await expect(shop.getByRole('button', { name: 'Подключить' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Каналы и источники' })).toHaveAttribute('aria-selected', 'true');
  await expectNoHorizontalScroll(page);
});

test('Business: «Проверить подключение» перечитывает и отвечает', async ({ page, request }) => {
  const data = await api<ConnectionsResponse>(request, '/api/connections');
  const expected = data.businessConnections.some((item) => item.enabled) ? 'Подключено ✓' : 'Пока не видим подключение';
  await page.goto('/next/connections');
  await page.getByRole('region', { name: 'Telegram Business', exact: true }).getByRole('button', { name: 'Проверить подключение' }).click();
  await expect(page.getByRole('region', { name: 'Telegram Business', exact: true }).getByRole('status')).toContainText(expected);
});

test('«Как мы представляемся»: правка приветствия меняет пример; сохранение; возвращаем как было', async ({ page, request }) => {
  const before = (await api<ConnectionsResponse>(request, '/api/connections')).serviceProfiles['telegram-dev'];
  expect(before, 'профиль в синтетике').toBeTruthy();
  const greeting = `Добрый день! Это проверка ${unique()}.`;
  try {
    await page.goto('/next/connections');
    await page.getByRole('region', { name: 'Telegram-бот «Поддержка»' }).getByRole('button', { name: 'Как мы представляемся' }).click();
    const sheet = page.getByRole('dialog', { name: 'Как мы представляемся' });
    const preview = sheet.getByRole('region', { name: 'Так это увидит клиент' });
    await expect(preview.getByText(before!.greetingMessage, { exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await sheet.getByLabel('Приветствие').fill(greeting);
    await expect(preview.getByText(greeting, { exact: true })).toBeVisible();
    // Ошибка у поля: фраза передачи короче 5 знаков.
    await sheet.getByLabel('Фраза при передаче человеку').fill('Да');
    await expect(sheet.getByText(/Фраза короче 5 знаков/)).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await sheet.getByLabel('Фраза при передаче человеку').fill(before!.handoffMessage);
    await expectNoHorizontalScroll(page);
    await sheet.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Сохранено ✓')).toBeVisible();
    await expect.poll(async () => (await api<ConnectionsResponse>(request, '/api/connections')).serviceProfiles['telegram-dev']?.greetingMessage).toBe(greeting);
  } finally {
    const restored = await request.post('/api/settings/services/telegram-dev', {
      headers: auth, data: { serviceName: before!.serviceName, greetingMessage: before!.greetingMessage, handoffMessage: before!.handoffMessage },
    });
    expect(restored.ok(), 'профиль возвращён').toBeTruthy();
  }
});

test('мастер бота: ход до «Подключено ✓», новый источник в списке, ключ стирается', async ({ page, request }) => {
  const name = `Бот ${unique()}`;
  await runWizard(page, request, name, botKey());
  const wizard = page.getByRole('dialog');
  await expect(wizard.getByText('3 из 3')).toBeVisible();
  await expect(wizard.getByRole('list', { name: 'Ход подключения' })).toBeVisible();
  await expect(wizard.getByText('Подключено ✓')).toBeVisible({ timeout: 25_000 });
  // Ключ нигде на странице не остался.
  expect(await page.evaluate((key) => document.body.innerHTML.includes(key) || [...document.querySelectorAll('input')].some((input) => input.value.includes(key)), botKey())).toBe(false);
  await wizard.getByRole('button', { name: 'Готово' }).click();
  await expect(page.getByRole('region', { name: `Telegram-бот «${name}»` }).getByText('работает', { exact: true })).toBeVisible();
  const data = await api<ConnectionsResponse>(request, '/api/connections');
  expect(data.sources.some((source) => source.name === name && source.kind === 'telegram_bot')).toBeTruthy();
});

test('мастер: проверка полей до отправки, ключ можно показать', async ({ page }) => {
  await page.goto('/next/connections');
  await page.getByRole('button', { name: 'Подключить канал или источник' }).click();
  const wizard = page.getByRole('dialog');
  await wizard.getByRole('radio', { name: /MiniShop/ }).check();
  await wizard.getByRole('button', { name: 'Дальше' }).click();
  await wizard.getByRole('button', { name: 'Подключить и проверить' }).click();
  await expect(wizard.getByText('Укажите название.')).toBeVisible();
  await expect(wizard.getByText('Укажите адрес.')).toBeVisible();
  await expect(wizard.getByText('Вставьте ключ.')).toBeVisible();
  await wizard.getByLabel('Адрес').fill('http://shop.example.org');
  await wizard.getByLabel('Ключ', { exact: true }).fill('короткий');
  await expect(wizard.getByLabel('Ключ', { exact: true })).toHaveAttribute('type', 'password');
  await wizard.getByRole('button', { name: 'Показать' }).click();
  await expect(wizard.getByLabel('Ключ', { exact: true })).toHaveAttribute('type', 'text');
  await wizard.getByRole('button', { name: 'Подключить и проверить' }).click();
  await expect(wizard.getByText(/Нужен полный адрес с https:\/\//)).toBeVisible();
  await expect(wizard.getByText(/Ключ короче 24 знаков/)).toBeVisible();
  await expect(wizard.getByText('Для специалистов', { exact: true })).toBeVisible();
});

test('мастер с плохим ключом: «Не подключилось, вернули как было»', async ({ page, request }) => {
  const name = `Плохой ${unique()}`;
  await runWizard(page, request, name, `123456789:bad${'B'.repeat(24)}`);
  const wizard = page.getByRole('dialog');
  await expect(wizard.getByText(/Не подключилось, вернули как было: Проверка не прошла: ключ не подошёл/)).toBeVisible({ timeout: 25_000 });
  await wizard.getByRole('button', { name: 'Что проверить' }).click();
  await expect(wizard.getByText(/Скопируйте ключ из @BotFather целиком/)).toBeVisible();
  await expect(wizard.getByRole('button', { name: 'Попробовать ещё раз' })).toBeVisible();
  await wizard.getByRole('button', { name: 'Закрыть' }).last().click();
  await expect(page.getByRole('region', { name: `Telegram-бот «${name}»` })).toHaveCount(0);
});

test('Business в мастере: три шага и «Проверить подключение», без запроса на сервер', async ({ page }) => {
  const posts: string[] = [];
  page.on('request', (req) => { if (req.method() === 'POST') posts.push(req.url()); });
  await page.goto('/next/connections');
  await page.getByRole('button', { name: 'Подключить канал или источник' }).click();
  const wizard = page.getByRole('dialog');
  await wizard.getByRole('radio', { name: /Telegram Business/ }).check();
  await wizard.getByRole('button', { name: 'Дальше' }).click();
  await expect(wizard.getByRole('listitem')).toHaveCount(3);
  await wizard.getByRole('button', { name: 'Проверить подключение' }).click();
  await expect(wizard.getByRole('status')).toBeVisible();
  expect(posts.filter((url) => url.includes('/api/sources'))).toEqual([]);
});

test('папки: создать, изменить, удалить с «Отменить» и без', async ({ page, request }) => {
  const name = `Папка ${unique()}`;
  const renamed = `${name} (новая)`;
  const folders = async (): Promise<Meta['folders']> => (await api<Meta>(request, '/api/inbox/meta')).folders;
  await page.goto('/next/connections');
  await page.getByRole('tab', { name: 'Папки' }).click();
  await expect(page).toHaveURL(/\/next\/connections\/folders$/);
  await expect(page.getByRole('list', { name: 'Папки' })).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.getByRole('button', { name: 'Новая папка' }).click();
  const sheet = page.getByRole('dialog', { name: 'Новая папка' });
  await sheet.getByRole('button', { name: 'Сохранить' }).click();
  await expect(sheet.getByText('Укажите название папки.')).toBeVisible();
  await sheet.getByLabel('Название').fill(name);
  await sheet.getByRole('radio', { name: 'Красный' }).check();
  await sheet.getByRole('checkbox', { name: 'Поддержка' }).check();
  await sheet.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('list', { name: 'Папки' }).getByText(name, { exact: true })).toBeVisible();
  const created = (await folders()).find((folder) => folder.name === name);
  expect(created?.color).toBe('#be123c');
  expect(created?.source_ids).toEqual(['telegram-dev']);

  await page.getByRole('button', { name: `Изменить папку «${name}»` }).click();
  const edit = page.getByRole('dialog', { name: 'Изменить папку' });
  await edit.getByLabel('Название').fill(renamed);
  await edit.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('list', { name: 'Папки' }).getByText(renamed, { exact: true })).toBeVisible();
  expect((await folders()).some((folder) => folder.name === renamed)).toBeTruthy();

  // «Отменить»: папка возвращается, на сервере остаётся.
  await page.getByRole('button', { name: `Удалить папку «${renamed}»` }).click();
  await expect(page.getByRole('list', { name: 'Папки' }).getByText(renamed, { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Папки' }).getByText(renamed, { exact: true })).toBeVisible();
  expect((await folders()).some((folder) => folder.name === renamed)).toBeTruthy();

  // Без отмены: после окна запрос уходит, папки нет.
  await page.getByRole('button', { name: `Удалить папку «${renamed}»` }).click();
  await expect.poll(async () => (await folders()).some((folder) => folder.name === renamed), { timeout: 15_000 }).toBe(false);
  await expect(page.getByRole('list', { name: 'Папки' }).getByText(renamed, { exact: true })).toHaveCount(0);
});

test('телефон и компьютер: ни вкладки, ни мастер, ни лист не дают горизонтальной прокрутки', async ({ page }) => {
  await page.goto('/next/connections');
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Подключить канал или источник' }).click();
  await expectNoHorizontalScroll(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Дальше' }).click();
  await expectNoHorizontalScroll(page);
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe · подключения · ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test.beforeEach(async ({ page }) => { await signIn(page); });

    test('вкладки «Каналы и источники» и «Папки»', async ({ page }) => {
      await page.goto('/next/connections');
      await expect(page.getByRole('region', { name: 'MiniShop' })).toBeVisible();
      expect(await serious(page), 'нарушения axe').toBe('');
      await page.goto('/next/connections/folders');
      await expect(page.getByRole('button', { name: 'Новая папка' })).toBeVisible();
      await expect(page.getByRole('list', { name: 'Папки' })).toBeVisible();
      expect(await serious(page), 'нарушения axe').toBe('');
      await page.getByRole('button', { name: 'Новая папка' }).click();
      await expect(page.getByRole('dialog', { name: 'Новая папка' })).toBeVisible();
      expect(await serious(page), 'нарушения axe').toBe('');
    });

    test('мастер: выбор, поля и ошибки', async ({ page }) => {
      await page.goto('/next/connections');
      await page.getByRole('button', { name: 'Подключить канал или источник' }).click();
      const wizard = page.getByRole('dialog');
      await expect(wizard.getByText('1 из 3')).toBeVisible();
      expect(await serious(page), 'нарушения axe').toBe('');
      await wizard.getByRole('button', { name: 'Дальше' }).click();
      await wizard.getByRole('button', { name: 'Подключить и проверить' }).click();
      await expect(wizard.getByText('Укажите название.')).toBeVisible();
      expect(await serious(page), 'нарушения axe').toBe('');
    });

    test('лист «Как мы представляемся»', async ({ page }) => {
      await page.goto('/next/connections');
      await page.getByRole('region', { name: 'Telegram-бот «Поддержка»' }).getByRole('button', { name: 'Как мы представляемся' }).click();
      await expect(page.getByRole('region', { name: 'Так это увидит клиент' })).toBeVisible();
      expect(await serious(page), 'нарушения axe').toBe('');
    });
  });
}
