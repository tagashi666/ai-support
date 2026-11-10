/**
 * «Команда» (план, этап 6: 6.10, приложение А, группа U): люди и карточка, добавление с ключом «один раз», новый ключ и
 * отключение (ярус 2), роли с «Затронет N человек» и «было → станет», журнал человеческими фразами, axe в обеих темах.
 * Данные общие на оба прохода: имена уникальны, роли возвращаем как было (даже при падении теста).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { api, expectNoHorizontalScroll, signIn, TOKEN } from './helpers';

const auth = { authorization: `Bearer ${TOKEN}` };
const unique = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

interface Operator { id: number; name: string; role: string; active: number }
interface RolesResponse { roles: Record<string, string[]>; defaults: Record<string, string[]> }

const operators = async (request: APIRequestContext): Promise<Operator[]> =>
  (await api<{ operators: Operator[] }>(request, '/api/operators')).operators;

async function meWith(request: APIRequestContext, token: string): Promise<number> {
  return (await request.get('/api/me', { headers: { authorization: `Bearer ${token}` } })).status();
}

async function settle(page: Page): Promise<void> {
  // Лист открывается с проявлением: контраст на середине анимации axe считает неверно.
  await page.evaluate(async () => { await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))); });
}

async function expectClean(page: Page): Promise<void> {
  await settle(page);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = result.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  expect(bad.map((violation) => violation.id), JSON.stringify(bad.map((v) => [v.id, v.nodes.map((n) => n.target).join(' ')]))).toEqual([]);
}

test.beforeEach(async ({ page }) => { await signIn(page); });

test('«Люди»: владелец, Мария, Пётр и Софья с отключённым доступом; на телефоне карточки, а не таблица', async ({ page }) => {
  await page.goto('/next/team');
  const list = page.getByRole('list', { name: 'Люди' });
  await expect(list).toBeVisible();
  await expect(list.getByText('это вы')).toBeVisible();
  await expect(list.getByRole('button', { name: /Мария/ })).toContainText('доступ открыт');
  await expect(list.getByRole('button', { name: /Пётр/ })).toContainText('Руководитель');
  const sophia = list.getByRole('button', { name: /Софья/ });
  await expect(sophia).toContainText('Наблюдатель');
  await expect(sophia).toContainText('доступ отключён');
  await expect(page.getByRole('tab', { name: 'Роли' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Журнал' })).toBeVisible();
  expect(await page.locator('table').count()).toBe(0);
  await expectNoHorizontalScroll(page);

  // Карточка: «может / не может» словами; своих закрытых слов (кодов прав) на экране нет.
  await sophia.click();
  await expect(page).toHaveURL(/\/next\/team\/people\/\d+$/);
  const card = page.getByRole('dialog', { name: 'Софья · Наблюдатель' });
  await expect(card).toContainText('Может:');
  await expect(card).toContainText('Не может:');
  await expect(card).toContainText('Доступ отключён');
  await expect(card.getByRole('button', { name: 'Вернуть доступ' })).toBeVisible();
  await expect(card).not.toContainText(/conversation:|roles:manage/);
  await expectNoHorizontalScroll(page);
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
});

test('добавить человека: ключ виден один раз; новый ключ (ярус 2); отключить и вернуть доступ', async ({ page, request }) => {
  const name = `Тест ${unique()}`;
  await page.goto('/next/team');
  await page.getByRole('button', { name: 'Добавить человека' }).click();
  await expect(page).toHaveURL(/\/next\/team\/people\/new$/);
  const add = page.getByRole('dialog', { name: 'Новый человек' });
  await add.getByLabel('Имя').fill(name);
  await expect(add.getByRole('radio', { name: /Оператор/ })).toBeChecked();
  await expect(add.getByText(/Только читает/)).toBeVisible();
  await expectNoHorizontalScroll(page);
  await add.getByRole('button', { name: 'Создать' }).click();

  const key = page.getByRole('dialog', { name: 'Ключ входа' });
  const field = key.getByLabel('Ключ входа');
  await expect(field).toHaveAttribute('readonly', '');
  await expect(field).toHaveValue(/^\S{20,}$/);
  const first = await field.inputValue();
  await expect(key.getByText(`Передайте его ${name} лично.`)).toBeVisible();
  await expect(key.getByRole('button', { name: 'Скопировать' })).toBeVisible();
  expect(page.url(), 'ключа нет в адресе').not.toContain(first);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })), 'ключа нет в хранилище').not.toContain(first);
  expect(await meWith(request, first)).toBe(200);
  await key.getByRole('button', { name: 'Готово' }).click();
  await expect(key).toBeHidden();
  await expect(page.getByLabel('Ключ входа')).toHaveCount(0);
  expect(await page.content(), 'ключа нет в странице').not.toContain(first);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(first);

  const row = page.getByRole('button', { name: new RegExp(name) });
  await expect(row).toContainText('Оператор');
  await expect(row).toContainText('доступ открыт');

  // Новый ключ входа: ярус 2, старый перестаёт работать сразу.
  await row.click();
  const card = page.getByRole('dialog', { name: `${name} · Оператор` });
  await card.getByRole('button', { name: 'Новый ключ входа…' }).click();
  const confirm = page.getByRole('dialog', { name: `Новый ключ входа для ${name}?` });
  await expect(confirm.getByText(`Старый ключ ${name} перестанет работать сразу`, { exact: false })).toBeVisible();
  expect(await meWith(request, first), 'пока не подтвердили — старый ключ работает').toBe(200);
  await confirm.getByRole('button', { name: 'Выдать новый ключ' }).click();
  const fresh = page.getByRole('dialog', { name: `Новый ключ для ${name}` });
  const second = await fresh.getByLabel('Ключ входа').inputValue();
  expect(second).toMatch(/^\S{20,}$/);
  expect(second).not.toBe(first);
  expect(await meWith(request, first), 'старый ключ не работает').toBe(401);
  expect(await meWith(request, second)).toBe(200);
  await fresh.getByRole('button', { name: 'Готово' }).click();
  await expect(page.getByLabel('Ключ входа')).toHaveCount(0);
  expect(await page.content()).not.toContain(second);

  // Отключить доступ: ярус 2.
  await row.click();
  await page.getByRole('dialog', { name: `${name} · Оператор` }).getByRole('button', { name: 'Отключить доступ…' }).click();
  const off = page.getByRole('dialog', { name: `Отключить доступ ${name}?` });
  await expect(off.getByText(`${name} сразу выйдет из панели.`, { exact: false })).toBeVisible();
  expect((await operators(request)).find((person) => person.name === name)?.active, 'до подтверждения доступ есть').toBe(1);
  await off.getByRole('button', { name: 'Отключить доступ', exact: true }).click();
  await expect(page.getByText(`Доступ ${name} отключён`)).toBeVisible();
  await expect.poll(async () => (await operators(request)).find((person) => person.name === name)?.active).toBe(0);
  await page.keyboard.press('Escape');
  await expect(row).toContainText('доступ отключён');

  // Вернуть доступ — сразу, без вопроса.
  await row.click();
  await page.getByRole('dialog', { name: `${name} · Оператор` }).getByRole('button', { name: 'Вернуть доступ' }).click();
  await expect.poll(async () => (await operators(request)).find((person) => person.name === name)?.active).toBe(1);
  await page.keyboard.press('Escape');
  await expect(row).toContainText('доступ открыт');

  // Смена роли.
  await row.click();
  const person = page.getByRole('dialog', { name: `${name} · Оператор` });
  await person.getByRole('button', { name: 'Сменить роль' }).click();
  await page.getByRole('dialog', { name: `Роль для ${name}` }).getByRole('radio', { name: /Наблюдатель/ }).check();
  await page.getByRole('dialog', { name: `Роль для ${name}` }).getByRole('button', { name: 'Сменить роль' }).click();
  await expect.poll(async () => (await operators(request)).find((entry) => entry.name === name)?.role).toBe('viewer');
});

test('«Роли»: четыре карточки; «Точно настроить» → «Затронет …» и «было → станет»; отмена; сохранить и вернуть стандартные', async ({ page, request }) => {
  const name = `Читатель ${unique()}`;
  const created = await request.post('/api/operators', { headers: auth, data: { name, role: 'viewer' } });
  expect(created.ok()).toBeTruthy();
  const before = await api<RolesResponse>(request, '/api/roles');
  try {
    await page.goto('/next/team/roles');
    const grid = page.getByRole('list', { name: 'Роли' });
    await expect(grid).toBeVisible();
    await expect(grid.getByRole('heading', { level: 2 })).toHaveText(['Администратор', 'Руководитель', 'Оператор', 'Наблюдатель']);
    await expect(grid.getByText('Может:').first()).toBeVisible();
    await expect(grid.getByText('Не может:').first()).toBeVisible();
    const admin = grid.getByRole('region', { name: 'Администратор' });
    await expect(admin.getByRole('button', { name: 'Точно настроить' })).toHaveCount(0);
    await expect(admin).toContainText('не меняются');
    await expectNoHorizontalScroll(page);

    const viewer = grid.getByRole('region', { name: 'Наблюдатель' });
    await viewer.getByRole('button', { name: 'Точно настроить' }).click();
    const edit = page.getByRole('dialog', { name: 'Права: Наблюдатель' });
    await expect(edit.getByRole('group', { name: 'Диалоги' })).toBeVisible();
    await expect(edit.getByRole('group', { name: 'Настройки помощника' })).toBeVisible();
    await expect(edit).not.toContainText(/\b(AI|SLA)\b/);
    await expectNoHorizontalScroll(page);
    await edit.getByLabel('Править знания', { exact: true }).check();
    await edit.getByRole('button', { name: 'Проверить изменения' }).click();
    const diff = page.getByRole('dialog', { name: 'Что изменится у роли «Наблюдатель»' });
    await expect(diff).toContainText(/Затронет \d+ (человека|человек): .*/);
    await expect(diff).toContainText(name);
    await expect(diff.getByText('Было → станет:')).toBeVisible();
    await expect(diff.getByText('+ Править знания')).toBeVisible();

    // Отмена: права прежние.
    await diff.getByRole('button', { name: 'Назад' }).click();
    await page.getByRole('dialog', { name: 'Права: Наблюдатель' }).getByRole('button', { name: 'Отмена' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await api<RolesResponse>(request, '/api/roles')).roles['viewer']).toEqual(before.roles['viewer']);

    // Сохранить.
    await viewer.getByRole('button', { name: 'Точно настроить' }).click();
    await page.getByRole('dialog', { name: 'Права: Наблюдатель' }).getByLabel('Править знания', { exact: true }).check();
    await page.getByRole('dialog', { name: 'Права: Наблюдатель' }).getByRole('button', { name: 'Проверить изменения' }).click();
    await page.getByRole('dialog', { name: 'Что изменится у роли «Наблюдатель»' }).getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Права роли «Наблюдатель» сохранены')).toBeVisible();
    await expect.poll(async () => (await api<RolesResponse>(request, '/api/roles')).roles['viewer']).toContain('knowledge:manage');
    await expect(viewer).toContainText('Настроено вручную');
    await expect(viewer).toContainText('править знания');

    // Вернуть стандартные — через тот же показ разницы.
    await viewer.getByRole('button', { name: 'Вернуть стандартные' }).click();
    const reset = page.getByRole('dialog', { name: 'Вернуть стандартные права роли «Наблюдатель»?' });
    await expect(reset).toContainText(/Затронет \d+ /);
    await expect(reset.getByText('− Править знания')).toBeVisible();
    await reset.getByRole('button', { name: 'Сохранить' }).click();
    await expect.poll(async () => (await api<RolesResponse>(request, '/api/roles')).roles['viewer']?.slice().sort()).toEqual(before.defaults['viewer']?.slice().sort());
    await expect(viewer).toContainText('Стандартные права');
  } finally {
    await request.put('/api/roles/viewer', { headers: auth, data: { permissions: before.roles['viewer'] } });
  }
});

test('«Журнал»: человеческие строки, фильтры «кто» и «что», «Как есть» раскрывается', async ({ page }) => {
  await page.goto('/next/team/log');
  const list = page.getByRole('list', { name: 'Журнал действий' });
  await expect(list).toBeVisible();
  // Журнал общий для всех тестов: строка могла уйти за первые 50 — догружаем «Показать ещё».
  const mode = list.getByText(/изменил\(а\) режим помощника/).first();
  const more = page.getByRole('button', { name: 'Показать ещё' });
  for (let i = 0; i < 10 && !(await mode.isVisible()) && (await more.isVisible()); i += 1) await more.click();
  await expect(mode).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.getByLabel('Кто').selectOption({ label: 'Мария' });
  const item = list.getByRole('listitem').filter({ hasText: 'ответил(а) в диалоге №3' }).first();
  await expect(item).toContainText('Мария');
  await expect(item.locator('summary')).toHaveText('Как есть');
  await expect(item.locator('summary')).toBeVisible();
  await expect(item.getByText('POST /api/conversations/3/reply')).toHaveCount(0);
  await expect(list.getByRole('listitem').filter({ hasNotText: 'Мария' })).toHaveCount(0);
  await item.locator('summary').click();
  await expect(item.getByText('POST /api/conversations/3/reply')).toBeVisible();
  await expect(item.getByText('Содержимое')).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.getByLabel('Кто').selectOption({ label: 'Все' });
  await page.getByLabel('Что').selectOption({ label: 'Знания и шаблоны' });
  await expect(list.getByText(/опубликовал\(а\) статью/).first()).toBeVisible();
  await expect(list.getByText('ответил(а) в диалоге №3')).toHaveCount(0);
  await page.getByLabel('Кто').selectOption({ label: 'Мария' });
  await expect(page.getByText('По этим фильтрам ничего нет.')).toBeVisible();
  await page.getByRole('button', { name: 'Сбросить фильтры' }).click();
  await expect(list).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe · «Команда» · ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    test('люди, карточка, добавление', async ({ page, request }) => {
      await page.goto('/next/team');
      await expect(page.getByRole('list', { name: 'Люди' })).toBeVisible();
      await expectClean(page);
      const maria = (await operators(request)).find((person) => person.name === 'Мария');
      await page.goto(`/next/team/people/${maria?.id}`);
      await expect(page.getByRole('dialog', { name: 'Мария · Оператор' })).toBeVisible();
      await expectClean(page);
      await page.getByRole('button', { name: 'Отключить доступ…' }).click();
      await expect(page.getByRole('dialog', { name: 'Отключить доступ Мария?' })).toBeVisible();
      await expectClean(page);
      await page.goto('/next/team/people/new');
      await expect(page.getByRole('dialog', { name: 'Новый человек' })).toBeVisible();
      await expectClean(page);
    });

    test('роли и журнал', async ({ page }) => {
      await page.goto('/next/team/roles');
      await expect(page.getByRole('list', { name: 'Роли' })).toBeVisible();
      await expectClean(page);
      await page.getByRole('region', { name: 'Оператор' }).getByRole('button', { name: 'Точно настроить' }).click();
      await expect(page.getByRole('dialog', { name: 'Права: Оператор' })).toBeVisible();
      await expectClean(page);
      await page.getByRole('button', { name: 'Проверить изменения' }).click();
      await expect(page.getByRole('dialog', { name: 'Что изменится у роли «Оператор»' })).toBeVisible();
      await expectClean(page);
      await page.goto('/next/team/log');
      await expect(page.getByRole('list', { name: 'Журнал действий' })).toBeVisible();
      await page.getByRole('list', { name: 'Журнал действий' }).locator('summary').first().click();
      await expectClean(page);
    });
  });
}
