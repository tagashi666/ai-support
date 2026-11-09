/**
 * Раздача новой панели по /next (src/panel/webapp.ts): оболочка, файлы с
 * хэшем, глубокие ссылки, 404 без сборки — и та же строгая CSP, что у классики.
 * Сборка Vite в CI идёт после тестов, поэтому здесь — маленькая поддельная
 * сборка во временном каталоге (PANEL_WEB_DIR).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BOT_TOKEN = '1:FakeForNextTests';
process.env.PANEL_TOKEN = 'next-0123456789abcdef';
process.env.AI_MODE = 'off';
process.env.LOG_LEVEL = 'error';
process.env.PANEL_PORT = '8191';
const dir = mkdtempSync(join(tmpdir(), 'next-'));
process.env.DB_PATH = join(dir, 'd.db');
process.env.KB_DIR = join(dir, 'kb');
process.env.DRAFT_DIR = join(dir, 'draft');
process.env.MEDIA_DIR = join(dir, 'media');
for (const sub of ['kb', 'draft', 'media', 'dist/assets', 'empty']) mkdirSync(join(dir, sub), { recursive: true });

const html = '<!doctype html><html lang="ru"><head><script type="module" crossorigin src="/next/assets/index-Ab12.js"></script>'
  + '<link rel="stylesheet" href="/next/assets/index-Cd34.css"></head><body><div id="app"></div></body></html>';
writeFileSync(join(dir, 'dist/index.html'), html);
writeFileSync(join(dir, 'dist/assets/index-Ab12.js'), 'console.log(1);');
writeFileSync(join(dir, 'dist/assets/index-Cd34.css'), 'body{margin:0}');
writeFileSync(join(dir, 'dist/favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`  ok    ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`, detail ?? ''); }
};

const { Store } = await import('../src/core/store.js');
const { openDatabase } = await import('../src/core/db.js');
const { Outbox } = await import('../src/core/outbox.js');
const { startWeb } = await import('../src/panel/server.js');
const B = 'http://127.0.0.1:8191';
const strictCsp = (csp: string): boolean => csp.includes("default-src 'none'") && /script-src 'self';/u.test(csp)
  && !/script-src[^;]*(?:'unsafe-inline'|'unsafe-eval'|'sha256-|'nonce-)/u.test(csp);

console.log('\n[ новая панель: /next ]');
{
  process.env.PANEL_WEB_DIR = join(dir, 'dist');
  const db = openDatabase(); const store = new Store(db);
  const app = await startWeb({ store, outbox: new Outbox(store) });

  const shell = await fetch(`${B}/next`);
  const body = await shell.text();
  check('/next отдаёт оболочку новой панели', shell.status === 200 && body.includes('/next/assets/index-Ab12.js')
    && /text\/html/u.test(shell.headers.get('content-type') ?? ''), shell.status);
  check('оболочка перепроверяется по ETag', shell.headers.get('cache-control') === 'no-cache' && Boolean(shell.headers.get('etag')));
  check('CSP на /next та же строгая: без inline и eval', strictCsp(shell.headers.get('content-security-policy') ?? ''),
    shell.headers.get('content-security-policy'));
  check('в оболочке нет встроенного кода', !/<script\b(?![^>]*\bsrc=)[^>]*>/iu.test(body) && !/\son[a-z]+=/iu.test(body));
  const etag = shell.headers.get('etag') ?? '';
  const again = await fetch(`${B}/next`, { headers: { 'if-none-match': etag } });
  await again.arrayBuffer();
  check('повтор с ETag — 304', again.status === 304);

  for (const deep of ['/next/', '/next/today', '/next/chats/c101']) {
    const page = await fetch(`${B}${deep}`);
    check(`глубокая ссылка ${deep} — та же оболочка`, page.status === 200 && (await page.text()) === body, page.status);
  }

  const script = await fetch(`${B}/next/assets/index-Ab12.js`);
  check('файл с хэшем кэшируется навсегда', script.status === 200
    && script.headers.get('cache-control') === 'public, max-age=31536000, immutable'
    && /javascript/u.test(script.headers.get('content-type') ?? '') && (await script.text()) === 'console.log(1);');
  const style = await fetch(`${B}/next/assets/index-Cd34.css`);
  await style.arrayBuffer();
  check('стили отдаются как text/css', style.status === 200 && /text\/css/u.test(style.headers.get('content-type') ?? ''));
  const icon = await fetch(`${B}/next/favicon.svg`);
  await icon.arrayBuffer();
  check('файл верхнего уровня — с перепроверкой', icon.status === 200 && icon.headers.get('cache-control') === 'no-cache');

  for (const missing of ['/next/assets/nope.js', '/next/assets/..%2F..%2Fpackage.json', '/next/package.json', '/next/index.html.bak']) {
    const res = await fetch(`${B}${missing}`);
    const text = await res.text();
    check(`нет файла ${missing} — 404, а не оболочка и не чужой файл`, res.status === 404 && !text.includes('"name"'), res.status);
  }

  const classic = await fetch(`${B}/`);
  check('классика на / не изменилась', classic.status === 200 && (await classic.text()).includes('/app.js?v='));
  const api = await fetch(`${B}/api/settings`);
  await api.arrayBuffer();
  check('данные по-прежнему только с ключом входа', api.status === 401, api.status);

  await app.close(); db.close();
}

console.log('\n[ новая панель не собрана ]');
{
  // Без второго запуска сервера на том же порту: проверяем регистрацию маршрутов
  // на отдельном экземпляре через inject (сокеты прошлого сервера не мешают).
  process.env.PANEL_WEB_DIR = join(dir, 'empty');
  const { default: Fastify } = await import('fastify');
  const { registerWebApp } = await import('../src/panel/webapp.js');
  const bare = Fastify();
  registerWebApp(bare);
  const res = await bare.inject({ method: 'GET', url: '/next/chats' });
  check('без сборки /next отвечает 404 с подсказкой', res.statusCode === 404 && res.body.includes('npm run build'), res.statusCode);
  await bare.close();
}

console.log('\n[ исходники новой панели ]');
{
  const devHtml = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const scripts = [...devHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)];
  check('web/index.html: один модуль по src, без встроенного кода', scripts.length === 1
    && /type="module"/u.test(scripts[0]?.[1] ?? '') && /src="/u.test(scripts[0]?.[1] ?? '') && !(scripts[0]?.[2] ?? '').trim()
    && !/\sstyle=|\son[a-z]+=/iu.test(devHtml));
  const viteConfig = readFileSync(new URL('../web/vite.config.ts', import.meta.url), 'utf8');
  check('полифил предзагрузки модулей выключен (без встроенного кода)', /modulePreload:\s*\{\s*polyfill:\s*false\s*\}/u.test(viteConfig));
  check("база сборки — '/next/'", /base:\s*'\/next\/'/u.test(viteConfig));
}

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
