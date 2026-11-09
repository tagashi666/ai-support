/**
 * Вложения (прил. А.E): стикер TGS через /vendor/lottie.min.js под CSP,
 * просмотрщик с «Править» → редактор картинки → файл клиенту; «Почему так?»
 * у ответа помощника (6.3.2).
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ThreadResponse } from '@shared/api-types';
import { api, openItems, signIn, stats } from './helpers';

test.beforeEach(async ({ page }) => { await signIn(page); });

async function threadWhere(request: APIRequestContext, test: (thread: ThreadResponse) => boolean): Promise<number> {
  for (const item of await openItems(request)) {
    const thread = await api<ThreadResponse>(request, `/api/thread/${item.id}`);
    if (test(thread)) return item.id;
  }
  throw new Error('нет подходящего диалога');
}

test('стикер TGS играет, фото правится в редакторе и уходит файлом', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'редактор — на компьютере');
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error' && /Content Security Policy|eval/.test(message.text())) errors.push(message.text()); });
  const id = await threadWhere(request, (thread) => thread.messages.some((message) => message.attachments.some((file) => file.kind === 'tgs_sticker')));
  await page.goto(`/next/chats/${id}`);
  const sticker = page.getByRole('img', { name: 'Стикер' });
  await expect(sticker).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
  await expect(sticker.locator('svg')).toHaveCount(1);
  expect(errors).toEqual([]);

  await page.getByRole('button', { name: 'Открыть фото' }).first().click();
  const viewer = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Править' }) });
  await viewer.getByRole('button', { name: 'Править' }).click();
  const editor = page.getByRole('dialog', { name: /Правка картинки/ });
  await expect(editor).toBeVisible();
  // Клавиши инструментов — по физической клавише, как в классике.
  await editor.locator('canvas').click();
  await page.keyboard.press('KeyL');
  await expect(editor.getByRole('button', { name: 'Линия' })).toHaveAttribute('aria-pressed', 'true');
  const box = (await editor.locator('canvas').boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 10, box.y + box.height - 10, { steps: 5 });
  await page.mouse.up();
  const before = (await stats(request)).sent;
  await editor.getByRole('button', { name: 'Отправить клиенту' }).click();
  await expect(editor).toBeHidden();
  await expect.poll(async () => (await stats(request)).sent).toBe(before + 1);
});

test('«Почему так?» у ответа помощника: источники и уверенность', async ({ page, request }) => {
  const id = await threadWhere(request, (thread) => thread.messages.some((message) => message.voice === 'assistant' && message.suggestion_id !== null));
  await page.goto(`/next/chats/${id}`);
  const answer = page.locator('[data-side="out"]').filter({ hasText: 'до трёх устройств' }).first();
  await answer.getByRole('button', { name: 'Действия с сообщением' }).click();
  await page.getByRole('menuitemradio', { name: 'Почему так?' }).click();
  const why = page.getByRole('dialog', { name: 'Почему так?' });
  await expect(why).toContainText('«Устройства»');
  await expect(why).toContainText('Уверенность');
});
