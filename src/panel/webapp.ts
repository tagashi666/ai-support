/**
 * Раздача новой панели (каталог web/, сборка Vite) по адресу /next рядом
 * с классической. Классика на / не меняется.
 *
 * Где лежит сборка: в образе — /app/webdist (Dockerfile копирует туда
 * web/dist), в рабочей копии — web/dist после `npm run build`. Переменная
 * PANEL_WEB_DIR задаёт каталог явно (нужна тестам).
 *
 * Файлы читаются в память при старте, как и страница классики: сборка
 * маленькая, а выдача из памяти не даёт обхода путей по определению.
 * Политика содержимого (CSP) общая для всего сервера и здесь не меняется:
 * Vite кладёт скрипты внешними файлами, встроенного кода в index.html нет.
 *
 * Доступ как у классики: оболочка страницы открыта, данные — только через
 * /api с ключом входа. Прототип этапа 1 к API не обращается вовсе.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { etagMatches } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..');

const TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NOT_BUILT = 'Новая панель не собрана. Выполните npm run build (или соберите образ Docker) и перезапустите сервер.';

const tag = (bytes: Buffer): string => `W/"${createHash('sha256').update(bytes).digest('base64url').slice(0, 16)}"`;

/** Каталог сборки: явный, затем образ, затем рабочая копия. */
export function webDistDir(): string | null {
  const candidates = process.env.PANEL_WEB_DIR
    ? [process.env.PANEL_WEB_DIR]
    : [join(projectRoot, 'webdist'), join(projectRoot, 'web', 'dist')];
  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? null;
}

type Asset = { body: Buffer; type: string; etag: string };

function readFlat(dir: string): Map<string, Asset> {
  const files = new Map<string, Asset>();
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir)) {
    const type = TYPES[extname(name).toLowerCase()];
    if (!type || !SAFE_NAME.test(name) || !statSync(join(dir, name)).isFile()) continue;
    const body = readFileSync(join(dir, name));
    files.set(name, { body, type, etag: tag(body) });
  }
  return files;
}

/**
 * Выбор интерфейса на устройстве (план, раздел 12): cookie `ui` и `?ui=classic|next`.
 * Cookie не HttpOnly: переключатели в обеих панелях ставят её сами, а
 * сервер по ней отправляет с `/` в новую. Ключа входа в ней нет.
 */
export const UI_COOKIE = 'ui';
export type UiChoice = 'classic' | 'next';

export function uiCookie(choice: UiChoice, secure: boolean): string {
  return `${UI_COOKIE}=${choice}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Явный выбор в адресе, затем сохранённый на устройстве. */
export function uiChoice(query: unknown, cookieHeader: string | undefined): { asked: UiChoice | null; saved: UiChoice | null } {
  const raw = (query as Record<string, unknown> | undefined)?.ui;
  const asked = raw === 'classic' || raw === 'next' ? raw : null;
  let saved: UiChoice | null = null;
  for (const part of (cookieHeader ?? '').split(';')) {
    const [name, value] = part.split('=').map((piece) => piece.trim());
    if (name === UI_COOKIE && (value === 'classic' || value === 'next')) saved = value;
  }
  return { asked, saved };
}

/** Новая панель собрана: только тогда классика может отправлять в неё. */
export const webAppBuilt = (): boolean => webDistDir() !== null;

export function registerWebApp(app: FastifyInstance): void {
  const dir = webDistDir();
  if (!dir) {
    const notBuilt = async (_request: unknown, reply: FastifyReply) =>
      reply.code(404).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send(NOT_BUILT);
    app.get('/next', notBuilt);
    app.get('/next/*', notBuilt);
    return;
  }

  const html = readFileSync(join(dir, 'index.html'));
  const htmlEtag = tag(html);
  // Файлы в assets/ несут хэш в имени — их можно хранить вечно.
  const hashed = readFlat(join(dir, 'assets'));
  // Файлы верхнего уровня (значок вкладки и т. п.) — без хэша, с перепроверкой.
  const plain = readFlat(dir);
  plain.delete('index.html');

  /** `?ui=classic` в новой панели — вернуться в классику и запомнить выбор. */
  const switchUi = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const { asked } = uiChoice(request.query, request.headers.cookie);
    if (!asked) return false;
    reply.header('set-cookie', uiCookie(asked, request.protocol === 'https'));
    if (asked === 'classic') { void reply.code(302).header('cache-control', 'no-store').redirect('/?ui=classic'); return true; }
    return false;
  };

  app.get('/next', async (request, reply) => {
    if (switchUi(request, reply)) return reply;
    reply.header('etag', htmlEtag).header('cache-control', 'no-cache');
    if (etagMatches(request.headers['if-none-match'], htmlEtag)) return reply.code(304).send();
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get<{ Params: { '*': string } }>('/next/*', async (request, reply) => {
    const rest = request.params['*'] ?? '';
    const assetName = rest.startsWith('assets/') ? rest.slice('assets/'.length) : null;
    const file = assetName !== null ? hashed.get(assetName) : plain.get(rest);
    if (file) {
      reply.header('etag', file.etag)
        .header('cache-control', assetName !== null ? 'public, max-age=31536000, immutable' : 'no-cache');
      if (etagMatches(request.headers['if-none-match'], file.etag)) return reply.code(304).send();
      return reply.type(file.type).send(file.body);
    }
    if (switchUi(request, reply)) return reply;
    // Адрес с точкой в последнем сегменте — это файл, которого нет. Без точки —
    // экран панели: отдаём оболочку, маршрут разберёт сама панель.
    const last = rest.split('/').pop() ?? '';
    if (assetName !== null || last.includes('.')) {
      return reply.code(404).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send('Не найдено');
    }
    reply.header('etag', htmlEtag).header('cache-control', 'no-cache');
    if (etagMatches(request.headers['if-none-match'], htmlEtag)) return reply.code(304).send();
    return reply.type('text/html; charset=utf-8').send(html);
  });
}
