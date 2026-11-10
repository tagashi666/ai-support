/**
 * Сервер для Playwright (web/e2e): панель на синтетической базе
 * (scripts/devseed.ts) без случайного потока и управляющий порт рядом —
 * тест сам решает, когда прийти кадрам и когда оборвать связь.
 *
 *   E2E_PORT=8197 node --import tsx scripts/e2eserver.ts
 *   E2E_EXTRA=460 — ещё столько диалогов (нагрузочный проект load, 11.6)
 *   POST :8198/burst?n=20&ms=50  — n сообщений клиентов с паузой ms
 *   POST :8198/drop              — разорвать все сокеты
 *   GET  :8198/stats             — {sent, extensions}
 * Только 127.0.0.1; база удаляется при выходе.
 */
import { createServer } from 'node:http';
import { startDevPanel } from './devseed.js';

const port = Number(process.env.E2E_PORT ?? 8197);
const panel = await startDevPanel({ port, token: process.env.E2E_TOKEN ?? 'e2e-key-0123456789abcdef', extra: Number(process.env.E2E_EXTRA ?? 0) });

const control = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const reply = (body: unknown): void => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(body)); };
  if (url.pathname === '/stats') return reply({ sent: panel.sent(), extensions: panel.extensions() });
  if (url.pathname === '/drop') { panel.dropSockets(); return reply({ ok: true }); }
  if (url.pathname === '/burst') {
    const n = Math.min(1000, Number(url.searchParams.get('n') ?? 10));
    const ms = Math.max(0, Number(url.searchParams.get('ms') ?? 50));
    let done = 0;
    const tick = (): void => {
      // Только диалоги без открытого теста: 2..39 по кругу.
      panel.inbound(2 + (done % 38), `Сообщение ${done + 1}`);
      done += 1;
      if (done < n) setTimeout(tick, ms);
    };
    tick();
    return reply({ ok: true, n });
  }
  response.statusCode = 404;
  response.end();
});
control.listen(port + 1, '127.0.0.1', () => console.log(`e2e: ${panel.url}/next/ · управление :${port + 1}`));

const stop = async (): Promise<void> => { control.close(); await panel.stop(); process.exit(0); };
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
