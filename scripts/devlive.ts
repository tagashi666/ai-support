/**
 * Локальная проверка новой панели: временная база с синтетическими
 * диалогами, панель на 127.0.0.1 и поток событий (scripts/devseed.ts).
 *
 *   npm run build:web && node --import tsx scripts/devlive.ts
 *   открыть http://127.0.0.1:8195/next/?live=1 и войти ключом dev-live-0123456789abcdef
 *
 * Каждые 7 с приходит сообщение клиента, иногда отвечает помощник или
 * оператор. Отправка уходит в поддельный канал (ничего не покидает машину):
 * ответы, файлы и смена статуса заявок проходят как настоящие. Есть
 * черновики разной уверенности, картинка, Business-диалог с закрытым окном
 * 24 ч, коллега с закреплением, поддельные карточка клиента, Remnawave и
 * Bedolaga. Данные вымышленные; база удаляется при выходе (Ctrl+C).
 * DEVLIVE_QUIET=1 — без потока событий.
 */
import { startDevPanel, TEXTS } from './devseed.js';

const panel = await startDevPanel({
  port: Number(process.env.PANEL_PORT ?? 8195),
  token: process.env.PANEL_TOKEN ?? 'dev-live-0123456789abcdef',
});
console.log(`Панель: ${panel.url}/next/?live=1  ключ: ${process.env.PANEL_TOKEN}`);

const timer = setInterval(() => {
  if (process.env.DEVLIVE_QUIET === '1') return;
  const id = panel.inbound(Math.floor(Math.random() * 40), TEXTS[Math.floor(Math.random() * TEXTS.length)]);
  if (id !== null && Math.random() < 0.3) {
    setTimeout(() => panel.outbound(id, Math.random() < 0.5 ? 'ai' : 'agent', 'Ответ'), 3000);
  }
}, 7000);

const stop = async (): Promise<void> => {
  clearInterval(timer);
  await panel.stop();
  process.exit(0);
};
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
