/**
 * Локальная проверка живого списка новой панели: временная база с
 * синтетическими диалогами, панель на 127.0.0.1 и поток событий.
 *
 *   npm run build:web && node --import tsx scripts/devlive.ts
 *   открыть http://127.0.0.1:8195/next/?live=1 и войти ключом dev-live-0123456789abcdef
 *
 * Каждые 7 с приходит сообщение клиента, иногда отвечает помощник или
 * оператор. Данные вымышленные; база удаляется при выходе (Ctrl+C).
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

const db = openDatabase();
const store = new Store(db);
const operations = new Operations(store);
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
  if (i % 11 === 6) operations.claim(conversation.id, colleague);
  if (i % 10 === 9) store.setStatus(conversation.id, 'resolved');
}

const app = await startWeb({ store, outbox: new Outbox(store) });
console.log(`Панель: http://127.0.0.1:${process.env.PANEL_PORT}/next/?live=1  ключ: ${process.env.PANEL_TOKEN}`);

const timer = setInterval(() => {
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
