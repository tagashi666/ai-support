/**
 * «Сегодня» и «Помощник» (план, этап 4: 6.1, 6.7, 10.4): смена режима
 * «было → станет» и «Вернуть как было», пауза и возврат (кнопки, лист,
 * палитра), «Что делал помощник» и «Это неверно», «Попробовать», полоса
 * «Изменено». Режим и пауза — общие для всей базы, поэтому каждый тест
 * возвращает их как было.
 */
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import type { BootstrapResponse } from '@shared/api-types';
import { api, expectNoHorizontalScroll, signIn, TOKEN } from './helpers';

const auth = { authorization: `Bearer ${TOKEN}` };
const boot = async (request: APIRequestContext): Promise<BootstrapResponse> => await api<BootstrapResponse>(request, '/api/bootstrap');

async function restore(request: APIRequestContext): Promise<void> {
  await request.post('/api/settings', { headers: auth, data: { aiMode: 'suggest' } });
  await request.delete('/api/assistant/pause', { headers: auth });
}

/** Модели в e2e нет: /api/ai/try отвечает заготовкой (вердикт «Отвечает сам»). */
async function fakeTry(page: Page): Promise<void> {
  await page.route('**/api/ai/try', async (route: Route) => {
    const body = route.request().postDataJSON() as { text: string; assume?: string };
    const sensitive = /деньг|оператор/i.test(body.text);
    await route.fulfill({ json: {
      draft: { reply: sensitive ? '' : 'Удалите профиль и добавьте заново по ссылке.', confidence: sensitive ? 0.3 : 0.93, needsHuman: sensitive },
      ms: 812, model: 'test-model', sources: ['Подключение iOS', 'Скорость'], usedSources: sensitive ? [] : ['Подключение iOS'],
      verdict: sensitive ? { action: 'suggest', reason: 'чувствительная тема' } : { action: body.assume === 'auto' ? 'auto' : 'suggest', reason: 'уверенность 0.93' },
    } });
  });
}

test.beforeEach(async ({ page }) => { await signIn(page); });
test.afterEach(async ({ request }) => { await restore(request); });

test('«Сегодня»: вердикт, «Ждут вас», помощник и система', async ({ page }) => {
  await page.goto('/next/today');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Добр(ое|ый|ой)/);
  await expect(page.getByText(/Вас жд(ёт|ут) \d+ диалог/)).toBeVisible();
  const card = page.getByRole('region', { name: 'Ждут вас' });
  await expect(card.getByRole('button').first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Помощник' }).getByText('Подсказывает', { exact: true })).toBeVisible();
  // В синтетике сервер «Франкфурт-2» не отвечает (этап 6): строка «Система» называет неполадку.
  await expect(page.getByText(/Система:.*сервер Франкфурт-2 не отвечает/)).toBeVisible();
  await expectNoHorizontalScroll(page);
  await card.getByRole('button').first().click();
  await expect(page).toHaveURL(/\/next\/chats\/\d+$/);
});

test('«Сегодня»: неполадка в вердикте и в «Нужно внимание», «Подробнее» → «Система → Серверы»', async ({ page }) => {
  await page.goto('/next/today');
  await expect(page.getByText(/Есть неполадка: сервер Франкфурт-2 не отвечает\./)).toBeVisible();
  const card = page.getByRole('region', { name: 'Нужно внимание' });
  await expect(card.getByText('Сервер Франкфурт-2 не отвечает')).toBeVisible();
  await card.getByRole('link', { name: 'Подробнее' }).click();
  await expect(page).toHaveURL(/\/next\/system\/servers$/);
});

test('к осторожному — сразу и «Вернуть как было»; к смелому — через лист', async ({ page, request }) => {
  await fakeTry(page);
  await page.goto('/next/assistant');
  await page.getByRole('radio', { name: /^Наблюдает/ }).click();
  await expect(page.getByText(/Применено в \d\d:\d\d: Подсказывает → Наблюдает/)).toBeVisible();
  await expect.poll(async () => (await boot(request)).assistant.mode).toBe('shadow');
  await page.getByRole('button', { name: 'Вернуть как было' }).click();
  await expect.poll(async () => (await boot(request)).assistant.mode).toBe('suggest');

  await page.getByRole('radio', { name: /^Отвечает сам/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Включить «Отвечает сам»?' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Было: Подсказывает → станет: Отвечает сам')).toBeVisible();
  // Пока не нажато «Включить», ничего не применено.
  expect((await boot(request)).assistant.mode).toBe('suggest');
  await sheet.getByRole('button', { name: 'Проверить' }).click();
  await expect(sheet.getByText(/ушёл бы сразу|передал бы вам/).first()).toBeVisible();
  await sheet.getByRole('button', { name: 'Не надо' }).click();
  await expect(sheet).toBeHidden();
  expect((await boot(request)).assistant.mode).toBe('suggest');

  await page.getByRole('radio', { name: /^Отвечает сам/ }).click();
  await page.getByRole('dialog', { name: 'Включить «Отвечает сам»?' }).getByRole('button', { name: 'Включить «Отвечает сам»' }).click();
  await expect.poll(async () => (await boot(request)).assistant.mode).toBe('auto');
  await expect(page.getByText('Сейчас включено')).toBeVisible();
  await page.getByRole('button', { name: 'Вернуть как было' }).click();
  await expect.poll(async () => (await boot(request)).assistant.mode).toBe('suggest');
  await expectNoHorizontalScroll(page);
});

test('пауза с «Сегодня», полоса на всех экранах и возобновление', async ({ page, request }) => {
  await page.goto('/next/today');
  await page.getByRole('region', { name: 'Помощник' }).getByRole('button', { name: 'Пауза' }).click();
  const sheet = page.getByRole('dialog', { name: 'Пауза помощника везде' });
  await sheet.getByRole('menuitemradio', { name: 'на 1 час' }).click();
  await expect.poll(async () => (await boot(request)).assistant.pause?.until ?? null).not.toBeNull();
  await expect(page.getByRole('status').filter({ hasText: /Помощник на паузе до \d\d:\d\d/ })).toBeVisible();
  await expect(page.getByText(/новые вопросы ждут вас|Остальное спокойно/)).toBeVisible();
  // Строка состояния видна и в списке диалогов.
  await page.goto('/next/chats');
  const strip = page.getByRole('status').filter({ hasText: 'Помощник на паузе' });
  await expect(strip).toBeVisible();
  await strip.getByRole('button', { name: 'Возобновить' }).click();
  await expect(strip).toBeHidden();
  await expect.poll(async () => (await boot(request)).assistant.pause ?? null).toBeNull();
});

test('пауза из палитры', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'клавиатура — на компьютере');
  await page.goto('/next/chats');
  await expect(page.locator('[data-row-id]').first()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+KeyK');
  const palette = page.getByRole('dialog', { name: 'Поиск и команды' });
  await palette.getByRole('combobox').fill('пауза');
  await palette.getByRole('option', { name: /Пауза помощника, пока не включу/ }).click();
  await expect.poll(async () => (await boot(request)).assistant.pause?.at ?? null).not.toBeNull();
  await expect(page.getByRole('status').filter({ hasText: 'Помощник на паузе пока не включите' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+KeyK');
  await palette.getByRole('combobox').fill('возобновить');
  await palette.getByRole('option', { name: /Возобновить помощника/ }).click();
  await expect.poll(async () => (await boot(request)).assistant.pause ?? null).toBeNull();
});

test('«Что делал помощник» и «Это неверно»', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'отметка одна на базу — один проход');
  await page.goto('/next/assistant/activity');
  const list = page.getByRole('list', { name: 'Что делал помощник' });
  await expect(list.getByText(/ответил сам/).first()).toBeVisible();
  await expect(list.getByText(/передал вам/).first()).toBeVisible();
  await expect(page.getByText(/Сегодня: ответил сам \d+/)).toBeVisible();
  await page.getByRole('radio', { name: 'передал вам' }).click();
  await expect(list.getByText(/ответил сам/)).toHaveCount(0);
  await page.getByRole('radio', { name: 'всё' }).click();
  await list.getByRole('button', { name: 'Это неверно' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Это неверно' });
  await sheet.getByRole('menuitemradio', { name: 'Неверный факт' }).click();
  await sheet.getByRole('textbox', { name: 'Что не так (по желанию)' }).fill('Устройств можно пять');
  await sheet.getByRole('button', { name: 'Отметить' }).click();
  await expect(sheet).toBeHidden();
  await expect(list.getByText('Отмечено как неверное').first()).toBeVisible();
});

test('«Попробовать»: ответ, уверенность словом, что было бы в «Отвечает сам»', async ({ page }) => {
  await fakeTry(page);
  await page.goto('/next/assistant/try');
  await page.getByRole('textbox', { name: 'Вопрос клиента' }).fill('Не подключается на айфоне');
  await page.getByRole('button', { name: 'Проверить', exact: true }).click();
  const result = page.getByRole('region', { name: 'Ответ помощника' });
  await expect(result.getByText('Удалите профиль и добавьте заново по ссылке.')).toBeVisible();
  await expect(result.getByText('ушёл бы сразу')).toBeVisible();
  await expect(result.getByText(/использовано/)).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('полоса «Изменено»: было → станет, проверка у поля, «Отменить»', async ({ page, request }) => {
  await page.goto('/next/assistant');
  const field = page.getByRole('spinbutton', { name: 'После вашего ответа молчит' });
  const before = await field.inputValue();
  await field.fill(String(Number(before) + 15));
  const bar = page.getByRole('region', { name: 'Изменено: 1' });
  await expect(bar).toBeVisible();
  await expect(bar.getByText(`После вашего ответа молчит: ${before} мин → ${Number(before) + 15} мин`)).toBeVisible();
  await field.fill('5000');
  await expect(page.getByRole('alert').filter({ hasText: 'Нужно число от 0 до 1440' })).toBeVisible();
  await bar.getByRole('button', { name: 'Отменить' }).click();
  await expect(bar).toBeHidden();
  await expect(field).toHaveValue(before);
  const settings = await api<{ runtime: { humanHoldMinutes: number } }>(request, '/api/assistant/settings');
  expect(String(settings.runtime.humanHoldMinutes)).toBe(before);
});
