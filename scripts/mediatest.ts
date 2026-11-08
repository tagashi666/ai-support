import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
const { avatarKey, isPermanentMediaError, MediaFetchError, mediaPath, sweepOrphanMedia } = await import('../src/core/media.js');
const { attachmentFileRef } = await import('../src/core/channels.js');

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
  ok('file_ref по каналу прежнего вида',
    attachmentFileRef('bedolaga', 'f1') === 'bedolaga:f1'
      && attachmentFileRef('minishop', 'f2') === 'minishop:f2'
      && attachmentFileRef('tg_bot', 'f3', 'bot:business:1') === 'tg:bot%3Abusiness%3A1:f3'
      && attachmentFileRef(undefined, 'f4') === 'tg:telegram-default:f4');

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

  // P2-7: файлы удалённых сообщений стираются после фиксации DELETE.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 50));
  const withFile = (externalId: string, externalMsgId: string, fileId: string) => {
    const recorded = store.recordInbound({
      channel: 'tg_dm', externalId, mediaType: 'photo', mediaFileId: fileId, externalMsgId, sentAt: Date.now(),
    })!;
    const attachment = store.attachmentsFor([recorded.message.id])[recorded.message.id]![0]!;
    const fileRef = store.getAttachment(attachment.id)!.file_ref;
    writeFileSync(mediaPath(fileRef), 'x');
    store.markAttachmentDownloaded(attachment.id, mediaPath(fileRef), 1);
    return { recorded, fileRef };
  };
  const lone = withFile('media-del', 'del-1', 'file-del-1');
  store.deleteExternalMessages(lone.recorded.conversation.id, ['del-1']);
  await tick();
  ok('удаление сообщения стирает файл вложения', !existsSync(mediaPath(lone.fileRef)));
  const shared = withFile('media-del2', 'del-2', 'file-del-2');
  const keeper = store.recordInbound({ channel: 'tg_dm', externalId: 'media-del2', text: 'ещё', externalMsgId: 'del-3', sentAt: Date.now() })!;
  store.addAttachment(keeper.message.id, 'photo', shared.fileRef);
  store.deleteExternalMessages(shared.recorded.conversation.id, ['del-2']);
  await tick();
  ok('общий файл другого вложения не стирается', existsSync(mediaPath(shared.fileRef)));

  // Сборщик сирот: только наши имена, только старые, только без ссылок.
  const mediaDir = process.env.MEDIA_DIR!;
  const avatarDir = join(dir, 'avatars');
  mkdirSync(avatarDir, { recursive: true });
  const hours = (n: number) => (Date.now() - n * 60 * 60_000) / 1000;
  const plant = (path: string, ageHours: number) => {
    writeFileSync(path, 'x');
    utimesSync(path, hours(ageHours), hours(ageHours));
    return path;
  };
  const referenced = plant(mediaPath(shared.fileRef), 5);
  const orphanOld = plant(join(mediaDir, 'a'.repeat(32)), 2);
  const orphanFresh = plant(join(mediaDir, 'b'.repeat(32)), 0);
  const staleTmp = plant(join(mediaDir, `.upload-1-${'c'.repeat(24)}.tmp`), 2);
  const foreign = plant(join(mediaDir, 'media.db'), 48);
  const avatarConversation = store.recordInbound({ channel: 'tg_dm', externalId: 'media-avatar', text: 'привет', externalMsgId: 'av-1', sentAt: Date.now() })!;
  store.setConversationAvatar(avatarConversation.conversation.id, 'avatar-file');
  const withAvatar = store.getConversation(avatarConversation.conversation.id)!;
  const liveKey = avatarKey(withAvatar.avatar_source_id ?? withAvatar.source_id, withAvatar.avatar_file_id)!;
  const avatarLive = plant(join(avatarDir, liveKey), 24 * 60);
  const avatarStale = plant(join(avatarDir, 'd'.repeat(32)), 24 * 31);
  const avatarRecent = plant(join(avatarDir, 'e'.repeat(32)), 24 * 2);
  const swept = await sweepOrphanMedia(store, Date.now(), { media: mediaDir, avatars: avatarDir });
  ok('сборщик удаляет старые файлы без ссылки и брошенные .tmp',
    !existsSync(orphanOld) && !existsSync(staleTmp) && swept.media === 2, swept);
  ok('сборщик не трогает файлы со ссылкой, свежие и чужие',
    existsSync(referenced) && existsSync(orphanFresh) && existsSync(foreign));
  ok('кэш аватарок: удаляется только ненужная и старше 30 дней',
    !existsSync(avatarStale) && existsSync(avatarLive) && existsSync(avatarRecent) && swept.avatars === 1, swept);
  ok('сборщик переживает отсутствующий каталог',
    (await sweepOrphanMedia(store, Date.now(), { media: join(dir, 'nope'), avatars: join(dir, 'nope2') })).media === 0);
  // «Печатает…»: только где канал умеет, и никогда не роняет отправку.
  {
    const { typingDelayMs } = await import('../src/ai/responder.js');
    const typingOutbox = new Outbox(store);
    const typingConversation = saved!.conversation.id;
    ok('без отправителя «печатает» не показывается', await typingOutbox.typing(typingConversation) === false);
    let typed = 0;
    typingOutbox.register('tg_dm', { send: async () => ({ externalId: 'x' }), typing: async () => { typed += 1; } } as any);
    ok('канал с typing показывает «печатает»', await typingOutbox.typing(typingConversation) === true && typed === 1);
    const brokenOutbox = new Outbox(store);
    brokenOutbox.register('tg_dm', { send: async () => ({ externalId: 'x' }), typing: async () => { throw new Error('403'); } } as any);
    ok('ошибка индикатора не бросается наружу', await brokenOutbox.typing(typingConversation) === false);
    ok('пауза перед автоответом от 1,2 до 4 с',
      typingDelayMs('да') === 1200 && typingDelayMs('x'.repeat(1000)) === 4000 && typingDelayMs('x'.repeat(80)) === 2600);
  }
} finally {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nВложения и аватарки: все проверки прошли' : `\nПровалено: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
