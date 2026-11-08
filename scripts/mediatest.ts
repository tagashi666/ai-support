import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Вложения и аватарки: окончательные ошибки, ручной повтор, лимит
// параллельности и живость WebSocket-канала. Без Telegram и внешней сети.
process.env.BOT_TOKEN = '';
process.env.AI_API_KEY = '';
process.env.AI_MODE = 'off';
process.env.BEDOLAGA_ENABLED = 'false';
process.env.MINISHOP_ENABLED = 'false';
process.env.REMNAWAVE_ENABLED = 'false';
process.env.NODES_STATUS_ENABLED = 'false';
process.env.SUPPORT_API_ENABLED = 'false';
process.env.UPDATE_ENABLED = 'false';
process.env.PANEL_TOKEN = 'media-panel-token-0123456789';
process.env.PANEL_PORT = '8098';
process.env.LOG_LEVEL = 'error';

const dir = mkdtempSync(join(tmpdir(), 'ai-support-media-'));
process.env.DB_PATH = join(dir, 'media.db');
process.env.MEDIA_DIR = join(dir, 'media');
process.env.KB_DIR = join(dir, 'kb');
process.env.DRAFT_DIR = join(dir, 'draft');
for (const d of [process.env.MEDIA_DIR, process.env.KB_DIR, process.env.DRAFT_DIR]) mkdirSync(d, { recursive: true });

const { Store, ATTACHMENT_GAVE_UP, ATTACHMENT_SHOW_FAILED_AFTER } = await import('../src/core/store.js');
const { openDatabase } = await import('../src/core/db.js');
const { Outbox } = await import('../src/core/outbox.js');
const { startWeb } = await import('../src/panel/server.js');
const { limitConcurrency } = await import('../src/core/http.js');
const { isPermanentMediaError, MediaFetchError } = await import('../src/core/media.js');

const db = openDatabase();
const store = new Store(db);
const app = await startWeb({ store, outbox: new Outbox(store) });
const base = 'http://127.0.0.1:8098';
const headers = { authorization: `Bearer ${process.env.PANEL_TOKEN}` };
let failures = 0;
const ok = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`, detail ?? ''); }
};

try {
  // Запись входящего с файлом — одна транзакция: сообщение и вложение вместе.
  const saved = store.recordInbound({
    channel: 'tg_dm', externalId: 'media-1', text: null as unknown as string, mediaType: 'photo',
    mediaFileId: 'file-1', externalMsgId: 'm1', sentAt: Date.now(),
  });
  ok('входящее с фото записано', Boolean(saved));
  const pending = store.pendingAttachments();
  ok('вложение встало в очередь вместе с сообщением', pending.length === 1, pending);
  const attachmentId = pending[0]!.id;
  ok('повторная доставка не создаёт дубль',
    store.recordInbound({ channel: 'tg_dm', externalId: 'media-1', mediaType: 'photo', mediaFileId: 'file-1', externalMsgId: 'm1', sentAt: Date.now() }) === null
      && store.pendingAttachments().length === 1);

  ok('слишком большой файл — окончательная ошибка', isPermanentMediaError(new Error("Call to 'getFile' failed! (400: Bad Request: file is too big)")));
  ok('сетевой сбой повторяется', !isPermanentMediaError(new Error('fetch failed')));
  ok('HTTP 404 источника — окончательная ошибка', isPermanentMediaError(new MediaFetchError('HTTP 404', true)));

  const pendingResponse = await fetch(`${base}/api/attachments/${attachmentId}`, { headers });
  ok('пока файл качается — 202', pendingResponse.status === 202, pendingResponse.status);

  store.deferAttachment(attachmentId, new Error('file is too big'), Date.now(), true);
  ok('окончательная ошибка снимает вложение с автоповторов',
    store.getAttachment(attachmentId)?.next_attempt_at === ATTACHMENT_GAVE_UP && store.pendingAttachments().length === 0);
  const failed = await fetch(`${base}/api/attachments/${attachmentId}`, { headers });
  const failedBody = await failed.json() as { failed?: boolean; error?: string };
  ok('панель получает отказ с причиной, а не вечный скелетон',
    failed.status === 424 && failedBody.failed === true && /20 МБ/.test(failedBody.error ?? ''), failedBody);
  ok('причина продублирована в заголовке для HEAD',
    /20/.test(decodeURIComponent(failed.headers.get('x-attachment-error') ?? '')));

  let retryEvents = 0;
  store.on('attachment_retry', () => { retryEvents += 1; });
  const retry = await fetch(`${base}/api/attachments/${attachmentId}/retry`, { method: 'POST', headers });
  ok('ручной повтор доступен оператору', retry.status === 200, retry.status);
  ok('повтор возвращает вложение в очередь и будит загрузчик',
    store.pendingAttachments().length === 1 && retryEvents === 1);

  for (let i = 0; i < ATTACHMENT_SHOW_FAILED_AFTER; i += 1) store.deferAttachment(attachmentId, new Error('fetch failed'));
  const flaky = await fetch(`${base}/api/attachments/${attachmentId}`, { headers });
  ok('после серии временных сбоев тоже показывается ошибка', flaky.status === 424, flaky.status);

  const limit = limitConcurrency(2);
  let active = 0, peak = 0;
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => limit(async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return i;
  })));
  ok('ограничитель держит не больше двух задач', peak === 2, peak);
  ok('ограничитель сохраняет результаты', results.join() === '0,1,2,3,4,5');
  const failedTask = await limit(async () => { throw new Error('x'); }).catch((err: Error) => err.message);
  ok('ошибка задачи не ломает очередь', failedTask === 'x' && await limit(async () => 'after') === 'after');

  const conversation = store.getConversation(saved!.conversation.id)!;
  ok('без аватарки — 404', (await fetch(`${base}/api/conversations/${conversation.id}/avatar`, { headers })).status === 404);
  store.setConversationAvatar(conversation.id, 'stale-file');
  store.clearConversationAvatar(conversation.id);
  ok('пропавшее фото очищается, панель покажет инициалы', !store.getConversation(conversation.id)?.avatar_file_id);
} finally {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nВложения и аватарки: все проверки прошли' : `\nПровалено: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
