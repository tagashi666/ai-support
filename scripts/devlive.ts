/**
 * Локальная проверка живого списка новой панели: временная база с
 * синтетическими диалогами, панель на 127.0.0.1 и поток событий.
 *
 *   npm run build:web && node --import tsx scripts/devlive.ts
 *   открыть http://127.0.0.1:8195/next/?live=1 и войти ключом dev-live-0123456789abcdef
 *
 * Каждые 7 с приходит сообщение клиента, иногда отвечает помощник или
 * оператор. Отправка уходит в поддельный канал (ничего не покидает машину):
 * ответы, файлы и смена статуса заявок проходят как настоящие. Есть
 * черновики разной уверенности, картинка, Business-диалог с закрытым окном
 * 24 ч и коллега с закреплением. Данные вымышленные; база удаляется при
 * выходе (Ctrl+C). DEVLIVE_QUIET=1 — без потока событий.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BOT_TOKEN = '123456:AAFakeForDevLive';
process.env.PANEL_TOKEN = process.env.PANEL_TOKEN ?? 'dev-live-0123456789abcdef';
process.env.AI_MODE = 'suggest';
process.env.AI_API_KEY = 'dev-key-not-used';
process.env.LOG_LEVEL = 'error';
process.env.PANEL_PORT = process.env.PANEL_PORT ?? '8195';
process.env.PANEL_HOST = '127.0.0.1';
const dir = mkdtempSync(join(tmpdir(), 'devlive-'));
process.env.DB_PATH = join(dir, 'd.db');
process.env.MEDIA_DIR = join(dir, 'media');
process.env.KB_DIR = join(dir, 'kb');
process.env.DRAFT_DIR = join(dir, 'draft');
mkdirSync(join(dir, 'kb')); mkdirSync(join(dir, 'draft'));

const { Store } = await import('../src/core/store.js');
const { openDatabase } = await import('../src/core/db.js');
const { Outbox } = await import('../src/core/outbox.js');
const { Operations } = await import('../src/core/operations.js');
const { startWeb } = await import('../src/panel/server.js');

const { saveUploadedMedia } = await import('../src/core/media.js');
const { config } = await import('../src/config.js');

const db = openDatabase();
const store = new Store(db);
const operations = new Operations(store);
const outbox = new Outbox(store);
let sent = 0;
// Поддельные каналы: отвечают как Telegram и Bedolaga, но ничего не отправляют.
const fake = { send: async () => ({ externalMsgId: `dev-out-${++sent}` }), sendAttachment: async () => ({ externalMsgId: `dev-file-${++sent}` }) };
outbox.register('tg_bot', fake);
outbox.register('tg_dm', fake);
outbox.register('bedolaga', { send: fake.send });
const NAMES = ['Анна К.', 'Олег Т.', 'Ирина', 'Павел С.', 'Мария В.', 'Денис', 'Света Л.', 'Георгий', 'Ника', 'Тимур Р.', 'Ольга', 'Артём'];
const TEXTS = ['Не подключается на телефоне', 'Как продлить подписку?', 'Скорость упала вечером', 'Позовите оператора',
  'Сколько устройств можно?', 'Оплатил, но доступа нет', 'Спасибо, заработало', 'Где взять ссылку подписки?'];
let n = 0;
const inbound = (i: number, at: number, text: string) => store.recordInbound({
  channel: i % 4 === 0 ? 'tg_bot' : 'bedolaga', externalId: `dev-${i}`, displayName: NAMES[i % NAMES.length],
  text, externalMsgId: `dev-${i}-${++n}`, sentAt: at,
});

const now = Date.now();
const colleague = operations.authenticate(operations.createOperator('Мария', 'agent').token)!;
for (let i = 0; i < 40; i += 1) {
  const at = now - (i * 7 + 1) * 60_000;
  const conversation = inbound(i, at, TEXTS[i % TEXTS.length]!)!.conversation;
  if (i % 5 === 1) store.recordOutbound({ conversationId: conversation.id, author: 'ai', text: 'Попробуйте обновить подписку в приложении.', sentAt: at + 30_000 });
  if (i % 7 === 2) store.recordOutbound({ conversationId: conversation.id, author: 'agent', text: 'Проверили, всё в порядке.', sentAt: at + 60_000 });
  if (i % 6 === 3) store.setHandoff(conversation.id, at + 10_000);
  if (i % 9 === 4) store.setEscalated(conversation.id, true, 'high');
  if (i % 8 === 5) store.createSuggestion({ conversationId: conversation.id, text: 'Черновик ответа', confidence: 0.5 });
  if (i % 8 === 1) store.createSuggestion({ conversationId: conversation.id, text: 'Здравствуйте! Удалите профиль в приложении и добавьте его заново по ссылке из личного кабинета. Если не поможет — пришлите снимок ошибки.', confidence: 0.96, sources: ['Подключение iOS'] });
  if (i % 8 === 3) store.createSuggestion({ conversationId: conversation.id, text: 'Скорость вечером может падать из-за загрузки сервера. Попробуйте другой сервер в приложении.', confidence: 0.86, sources: ['Скорость'], reason: 'нет статьи про этот сервер' });
  if (i % 11 === 6) operations.claim(conversation.id, colleague);
  if (i % 10 === 9) store.setStatus(conversation.id, 'resolved');
}

// Картинка 2×1 пикселя (PNG), чтобы в ленте было фото с размерами.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNgYPj/n4GBgQEAEgIC/2nUPxkAAAAASUVORK5CYII=', 'base64');
const photoMsg = inbound(0, now - 30_000, 'Вот снимок ошибки')!.message;
const saved = await saveUploadedMedia((async function* () { yield png; })(), config.mediaMaxFileBytes);
store.addLocalAttachment(photoMsg.id, { fileRef: saved.fileRef, localPath: saved.localPath, mediaType: 'photo', mimeType: 'image/png',
  originalName: 'ошибка.png', bytes: saved.bytes, sha256: saved.sha256, width: 640, height: 320 });
store.addNote(photoMsg.conversation_id, 'Клиент на iOS 17, проверить профиль.');
// Business-диалог: клиент писал больше суток назад — окно ответа закрыто.
store.recordInbound({ channel: 'tg_dm', externalId: 'dev-biz', displayName: 'Дина С.', text: 'Верните деньги за месяц',
  externalMsgId: 'dev-biz-1', sentAt: now - 26 * 60 * 60_000, tgUserId: 900001, businessConnectionId: 'dev-bc' });
store.recordInbound({ channel: 'tg_dm', externalId: 'dev-biz2', displayName: 'Елена П.', text: 'Можно на второй телефон?',
  externalMsgId: 'dev-biz2-1', sentAt: now - 21 * 60 * 60_000 - 30 * 60_000, tgUserId: 900002, businessConnectionId: 'dev-bc' });
store.upsertTemplate('привет', 'Приветствие', 'Здравствуйте! Сейчас посмотрю.');

const app = await startWeb({ store, outbox });
// После startWeb: он ставит синхронизацию заявок без клиента Bedolaga (503).
outbox.registerStatusSync('bedolaga', async () => undefined);
console.log(`Панель: http://127.0.0.1:${process.env.PANEL_PORT}/next/?live=1  ключ: ${process.env.PANEL_TOKEN}`);

const timer = setInterval(() => {
  if (process.env.DEVLIVE_QUIET === '1') return;
  const i = Math.floor(Math.random() * 40);
  const result = inbound(i, Date.now(), TEXTS[Math.floor(Math.random() * TEXTS.length)]!);
  if (result && Math.random() < 0.3) {
    setTimeout(() => store.recordOutbound({ conversationId: result.conversation.id, author: Math.random() < 0.5 ? 'ai' : 'agent', text: 'Ответ' }), 3000);
  }
}, 7000);

const stop = async (): Promise<void> => {
  clearInterval(timer);
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
