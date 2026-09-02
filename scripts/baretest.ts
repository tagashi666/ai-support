import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Реальный минимальный профиль: ни Telegram, ни Bedolaga, ни Remnawave, ни AI.
// Все env задаются до динамических импортов, потому что config загружается один раз.
process.env.BOT_TOKEN = '';
process.env.AI_API_KEY = '';
process.env.AI_MODE = 'off';
process.env.BEDOLAGA_ENABLED = 'false';
process.env.REMNAWAVE_ENABLED = 'false';
process.env.NODES_STATUS_ENABLED = 'false';
process.env.SUPPORT_API_ENABLED = 'false';
process.env.UPDATE_ENABLED = 'false';
process.env.PANEL_TOKEN = 'bare-panel-token-0123456789';
process.env.PANEL_PORT = '8099';
process.env.LOG_LEVEL = 'error';

const dir = mkdtempSync(join(tmpdir(), 'ai-support-bare-'));
process.env.DB_PATH = join(dir, 'bare.db');
process.env.MEDIA_DIR = join(dir, 'media');
process.env.KB_DIR = join(dir, 'kb');
process.env.DRAFT_DIR = join(dir, 'draft');
mkdirSync(process.env.MEDIA_DIR, { recursive: true });
mkdirSync(process.env.KB_DIR, { recursive: true });
mkdirSync(process.env.DRAFT_DIR, { recursive: true });

const { config } = await import('../src/config.js');
const { Store } = await import('../src/core/store.js');
const { openDatabase } = await import('../src/core/db.js');
const { Outbox } = await import('../src/core/outbox.js');
const { seedTemplates } = await import('../src/core/templates.js');
const { startWeb } = await import('../src/panel/server.js');

const db = openDatabase();
const store = new Store(db);
seedTemplates(store);
const outbox = new Outbox(store);
const app = await startWeb({ store, outbox });
const base = 'http://127.0.0.1:8099';
const headers = { authorization: `Bearer ${process.env.PANEL_TOKEN}` };
let failures = 0;
const ok = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`, detail ?? ''); }
};

try {
  ok('конфигурация допускает пустой BOT_TOKEN', config.botToken === '');
  ok('AI полностью выключен без ключа', config.ai.mode === 'off' && config.ai.apiKeys.length === 0);
  ok('голая панель отвечает', (await fetch(`${base}/`)).status === 200);
  const health = await (await fetch(`${base}/api/health`, { headers })).json() as { ok?: boolean };
  ok('health-check работает без интеграций', health.ok === true, health);
  const settings = await (await fetch(`${base}/api/settings`, { headers })).json() as any;
  ok('все внешние каналы действительно отключены',
    settings.channels.tg_dm === false && settings.channels.tg_bot === false && settings.channels.bedolaga === false,
    settings.channels);
  ok('панель всё равно получает стартовые шаблоны',
    ((await (await fetch(`${base}/api/templates`, { headers })).json() as any).templates?.length ?? 0) >= 10);
  const conversations = await (await fetch(`${base}/api/conversations`, { headers })).json() as any;
  ok('пустая очередь корректно отображается', Array.isArray(conversations.conversations) && conversations.conversations.length === 0);
} finally {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nАвтономный запуск: все проверки прошли' : `\nПровалено: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
