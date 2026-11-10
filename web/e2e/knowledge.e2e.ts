/**
 * «Знания» (план, этап 5: 6.6, 10.5): «Новая статья» — черновик, публикация
 * с «было → стало» и «Отменить», чужая правка (409), вопрос при уходе с
 * несохранённым, идеи из диалогов (в т.ч. из «Это неверно») с окном отмены,
 * шаблоны, статья из палитры, «В знания…» из диалога, «Разобрать» на «Сегодня».
 * Данные общие на оба прохода: названия уникальны, состояние проверяем через API.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { IdeasResponse, KbDocResponse, KbListResponse, ThreadResponse } from '@shared/api-types';
import { api, expectNoHorizontalScroll, openItems, signIn, TOKEN } from './helpers';

const auth = { authorization: `Bearer ${TOKEN}` };
const unique = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

async function list(request: APIRequestContext): Promise<KbListResponse> {
  return await api<KbListResponse>(request, '/api/kb');
}

async function createDraft(request: APIRequestContext, title: string, text: string): Promise<string> {
  const response = await request.post('/api/kb', { headers: auth, data: { title, text, draft: true } });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { name: string }).name;
}

/** Ответ помощника в синтетике — для «Это неверно» и «В знания…». */
async function assistantMessage(request: APIRequestContext): Promise<{ conversation: number; message: number; text: string }> {
  for (const item of await openItems(request)) {
    const thread = await api<ThreadResponse>(request, `/api/thread/${item.id}`);
    const message = thread.messages.find((entry) => entry.voice === 'assistant' && entry.text);
    if (message) return { conversation: item.id, message: message.id, text: message.text ?? '' };
  }
  throw new Error('нет ответа помощника');
}

async function openEditor(page: Page, name: string): Promise<void> {
  await page.goto(`/next/knowledge/articles/${encodeURIComponent(name)}`);
  await expect(page.getByLabel('Текст статьи')).toBeVisible();
}

test.beforeEach(async ({ page }) => { await signIn(page); });

test('«Новая статья» — черновик; публикация с «было → стало» и «Отменить»', async ({ page, request }) => {
  const title = `Проверка ${unique()}`;
  await page.goto('/next/knowledge');
  await expect(page.getByRole('list', { name: 'Статьи' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Новая статья' }).first().click();
  await expect(page).toHaveURL(/\/next\/knowledge\/new$/);
  await page.getByLabel('Название').fill(title);
  await page.getByLabel('Текст статьи').fill('Первый шаг.\nВторой шаг.');
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page).toHaveURL(/\/next\/knowledge\/articles\/.+\.md$/);
  const name = decodeURIComponent(page.url().split('/').pop()!);
  let kb = await list(request);
  expect(kb.drafts.some((doc) => doc.name === name), 'в черновиках').toBeTruthy();
  expect(kb.kb.some((doc) => doc.name === name), 'не опубликована').toBeFalsy();
  await expect(page.getByRole('status').filter({ hasText: 'черновик' }).first()).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.getByRole('button', { name: 'Опубликовать…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Опубликовать статью?' });
  await expect(sheet.getByText('Помощник начнёт использовать новый текст в течение 15 минут.')).toBeVisible();
  await expect(sheet.getByText(/Изменения против опубликованной: \+4, −0/)).toBeVisible();
  await sheet.getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await expect(page.getByText('Опубликовано', { exact: true })).toBeVisible();
  await expect.poll(async () => (await list(request)).kb.some((doc) => doc.name === name)).toBeTruthy();
  await page.getByRole('button', { name: 'Отменить' }).click();
  await expect(page.getByText(/Публикация отменена/)).toBeVisible();
  kb = await list(request);
  expect(kb.kb.some((doc) => doc.name === name), 'снова не опубликована').toBeFalsy();
  expect(kb.drafts.some((doc) => doc.name === name), 'правка — в черновике').toBeTruthy();
});

test('уход с несохранённым — вопрос; чужая правка — 409 с выбором', async ({ page, request }) => {
  const name = await createDraft(request, `Чужая правка ${unique()}`, 'Исходный текст.');
  await openEditor(page, name);
  await page.getByLabel('Текст статьи').fill('Мой текст.');
  await expect.poll(async () => page.evaluate((key) => localStorage.getItem(key), `next.kb.${name}`)).not.toBeNull();
  await page.goto('/next/knowledge'); // полная перезагрузка: браузерный вопрос не задаётся в автотесте, текст — на устройстве
  await openEditor(page, name);
  await expect(page.getByText(/Вернули ваш несохранённый текст/)).toBeVisible();
  await expect(page.getByLabel('Текст статьи')).toHaveValue('Мой текст.');

  // Переход внутри панели — свой вопрос.
  await page.getByRole('link', { name: /Знания/ }).first().click();
  const leave = page.getByRole('dialog', { name: 'Есть несохранённые правки' });
  await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: 'Остаться' }).click();
  await expect(page).toHaveURL(new RegExp(`/articles/${name.replace('.', '\\.')}$`));

  // Кто-то сохранил черновик, пока вы правили.
  const current = await api<KbDocResponse>(request, `/api/kb/draft/${name}`);
  await request.put(`/api/kb/draft/${name}`, { headers: auth, data: { text: '# Чужая\n\nЧужой текст.\n', expectedVersion: current.version } });
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  const conflict = page.getByRole('dialog', { name: 'Статью изменили' });
  await expect(conflict.getByText(/Статью изменил\(а\) Владелец в \d\d:\d\d, пока вы правили/)).toBeVisible();
  await conflict.getByRole('button', { name: 'Сравнить' }).click();
  await expect(conflict.getByText('+ Мой текст.')).toBeVisible();
  await conflict.getByRole('button', { name: 'Сохранить мой текст поверх' }).click();
  await expect.poll(async () => (await api<KbDocResponse>(request, `/api/kb/draft/${name}`)).text).toContain('Мой текст.');
});

test('идея из «Это неверно»: без неверного ответа; «Опубликовать для помощника» после окна отмены', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'отметка одна на сообщение — один проход');
  const { message } = await assistantMessage(request);
  const marker = `Правильный ответ ${unique()}`;
  const feedback = await request.post(`/api/messages/${message}/feedback`, { headers: auth, data: { verdict: 'wrong', reason: 'fact', correct: marker } });
  const ideaId = ((await feedback.json()) as { idea_id: number }).idea_id;
  expect(ideaId).toBeGreaterThan(0);

  await page.goto(`/next/knowledge/ideas/${ideaId}`);
  const card = page.getByRole('region').filter({ hasText: marker });
  await expect(card.getByText(/Откуда: «Это неверно» в диалоге/)).toBeVisible();
  await expect(card.getByText(marker)).toBeVisible();
  await card.getByRole('button', { name: 'Опубликовать для помощника' }).click();
  await expect(page.getByText(/^Опубликовано: «/)).toBeVisible();
  // До конца окна отмены сервер ничего не знает.
  let ideas = await api<IdeasResponse>(request, '/api/learning/candidates?status=pending');
  expect(ideas.candidates.some((row) => row.id === ideaId)).toBeTruthy();
  await expect.poll(async () => (await api<IdeasResponse>(request, '/api/learning/candidates?status=all')).candidates.find((row) => row.id === ideaId)?.status,
    { timeout: 12_000 }).toBe('approved');
  ideas = await api<IdeasResponse>(request, '/api/learning/candidates?status=all');
  const file = ideas.candidates.find((row) => row.id === ideaId)!.file_name;
  const published = await api<KbDocResponse>(request, `/api/kb/kb/${file}`);
  expect(published.text).toContain(marker);
});

test('идея: «Отклонить ▾» с причиной и «Отменить»', async ({ page, request }) => {
  const { message } = await assistantMessage(request);
  // Повторная отметка того же ответа допустима: каждая «как правильно» — своя идея.
  const marker = `Отклоняемая ${unique()}`;
  const feedback = await request.post(`/api/messages/${message}/feedback`, { headers: auth, data: { verdict: 'wrong', correct: marker } });
  const ideaId = ((await feedback.json()) as { idea_id: number }).idea_id;
  await page.goto(`/next/knowledge/ideas/${ideaId}`);
  const card = page.getByRole('region').filter({ hasText: marker });
  await card.getByRole('button', { name: /^Отклонить/ }).click();
  await page.getByRole('dialog', { name: 'Почему отклонить' }).getByRole('menuitemradio', { name: 'Дубль' }).click();
  await page.getByRole('button', { name: 'Отменить' }).click();
  await expect(page.getByRole('region').filter({ hasText: marker })).toBeVisible();
  await page.waitForTimeout(6500);
  let row = (await api<IdeasResponse>(request, '/api/learning/candidates?status=all')).candidates.find((item) => item.id === ideaId);
  expect(row?.status, 'отмена — запрос не ушёл').toBe('pending');
  await page.getByRole('region').filter({ hasText: marker }).getByRole('button', { name: /^Отклонить/ }).click();
  await page.getByRole('dialog', { name: 'Почему отклонить' }).getByRole('menuitemradio', { name: 'Слишком частное' }).click();
  await expect.poll(async () => (await api<IdeasResponse>(request, '/api/learning/candidates?status=all')).candidates.find((item) => item.id === ideaId)?.status,
    { timeout: 12_000 }).toBe('rejected');
  row = (await api<IdeasResponse>(request, '/api/learning/candidates?status=all')).candidates.find((item) => item.id === ideaId);
  expect(row?.decided_by).toBe('root');
});

test('«Разобрать» на «Сегодня» ведёт в «Идеи из диалогов»', async ({ page }) => {
  await page.goto('/next/today');
  const link = page.getByRole('link', { name: 'Разобрать' });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/next\/knowledge\/ideas/);
  await expect(page.getByRole('tab', { name: /Идеи из диалогов/ })).toHaveAttribute('aria-selected', 'true');
});

test('шаблоны: создать, найти, удалить с «Отменить»', async ({ page, request }) => {
  const shortcut = `т${unique()}`;
  await page.goto('/next/knowledge/templates');
  await page.getByRole('button', { name: 'Новый шаблон' }).click();
  const sheet = page.getByRole('dialog', { name: 'Новый шаблон' });
  await sheet.getByLabel('Короткое имя').fill(shortcut);
  await sheet.getByLabel('Название').fill('Проверим и вернёмся');
  await sheet.getByLabel('Текст').fill('Проверим и вернёмся с ответом.');
  await sheet.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByRole('searchbox', { name: 'Найти шаблон' }).fill(shortcut);
  const row = page.getByRole('list', { name: 'Шаблоны' }).getByRole('listitem');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(`/${shortcut} · Проверим и вернёмся`);
  await row.getByRole('button', { name: 'Удалить' }).click();
  await expect(page.getByText(/Шаблон «Проверим и вернёмся» удалён/)).toBeVisible();
  await page.getByRole('button', { name: 'Отменить' }).click();
  await expect(row).toHaveCount(1);
  const templates = await api<{ templates: Array<{ shortcut: string; id: number }> }>(request, '/api/templates');
  const created = templates.templates.find((item) => item.shortcut === shortcut);
  expect(created).toBeTruthy();
  await request.delete(`/api/templates/${created!.id}`, { headers: auth });
});

test('статья из палитры открывает саму статью', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'палитра по ⌘K — на компьютере');
  await page.goto('/next/chats');
  await page.getByRole('button', { name: 'Найти' }).first().click();
  const palette = page.getByRole('dialog', { name: 'Поиск и команды' });
  await palette.getByRole('combobox').fill('Лимит устройств');
  await palette.getByRole('option', { name: /Лимит устройств/ }).first().click();
  await expect(page).toHaveURL(/\/next\/knowledge\/articles\/limit-ustroystv\.md$/);
  await expect(page.getByLabel('Название')).toHaveValue('Лимит устройств');
});

test('«В знания…» из диалога — новая статья с вопросом и ответом', async ({ page, request }) => {
  const { conversation, text } = await assistantMessage(request);
  await page.goto(`/next/chats/${conversation}`);
  await page.locator('[data-side="out"]').filter({ hasText: text }).last().getByRole('button', { name: 'Действия с сообщением' }).click();
  await page.getByRole('menuitemradio', { name: 'В знания…' }).click();
  await expect(page).toHaveURL(/\/next\/knowledge\/new$/);
  await expect(page.getByLabel('Текст статьи')).not.toHaveValue('');
  await expect(page.getByLabel('Название')).not.toHaveValue('');
  // Уход без сохранения: вопрос и «Не сохранять».
  await page.getByRole('link', { name: /Знания/ }).first().click();
  await page.getByRole('dialog', { name: 'Есть несохранённые правки' }).getByRole('button', { name: 'Не сохранять' }).click();
  await expect(page).toHaveURL(/\/next\/knowledge$/);
});
