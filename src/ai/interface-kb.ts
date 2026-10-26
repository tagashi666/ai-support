import { randomBytes } from 'node:crypto';
import { constants, readFileSync, statSync } from 'node:fs';
import { mkdir, open, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { config, log } from '../config.js';

/**
 * Справочник интерфейса кабинета Bedolaga для AI.
 *
 * У кабинета два вида: полный и «Простой вид кабинета» (lite) — общий
 * переключатель админа магазина. Часть экранов в них совпадает, часть
 * устроена иначе, поэтому манифест v2 хранит экран один раз, а отличия
 * режима — патчем в `modes`. v1 без `modes` читается как полный вид.
 *
 * Поставляемый манифест не правится на месте: у каждой инсталляции свои
 * мелкие отличия в кнопках, и их правки живут в отдельном файле
 * оверрайдов в каталоге данных. Обновление проекта их не затирает.
 */

export type InterfaceMode = 'full' | 'lite';
export const INTERFACE_MODES: readonly InterfaceMode[] = ['full', 'lite'];

export interface InterfaceScreen {
  id: string;
  title: string;
  routeDescription: string;
  keywords: string[];
  instructions: string[];
  image?: string;
  caption?: string;
}

export interface InterfaceKnowledge {
  version: string | number;
  locale: 'ru';
  app: 'bedolaga';
  mode: InterfaceMode;
  screens: InterfaceScreen[];
}

/** Поля экрана, которые можно переопределить режимом или правкой оператора. */
const FIELDS = ['title', 'routeDescription', 'keywords', 'instructions', 'image', 'caption'] as const;
type ScreenPatch = Partial<Record<(typeof FIELDS)[number], unknown>>;

export interface InterfaceOverrides {
  /** Правки поставляемых экранов: `all` — для обоих режимов, `full`/`lite` — для одного. */
  screens: Record<string, { all?: ScreenPatch; full?: ScreenPatch; lite?: ScreenPatch; hidden?: boolean }>;
  /** Экраны, которых нет в поставке. Тот же формат, что и экран манифеста. */
  added: Record<string, unknown>[];
}

const ROOT = resolve(process.cwd(), 'interface-kb');
const MANIFEST = resolve(ROOT, 'manifest.json');
const ASSETS = resolve(ROOT, 'assets');
const DATA_ROOT = resolve(dirname(resolve(process.cwd(), config.dbPath)), 'interface-kb');
export const OVERRIDES = resolve(DATA_ROOT, 'overrides.json');
/** Картинки инсталляции (скриншоты своего кабинета) — в данных, не в репозитории. */
export const LOCAL_ASSETS = resolve(DATA_ROOT, 'assets');
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean && clean.length <= max ? clean : null;
}

/**
 * Разрешён только файл непосредственно из поставляемого assets или, с
 * префиксом `local/`, из каталога картинок инсталляции. URL, абсолютные
 * пути и traversal никогда не попадут ни в prompt, ни в отправку.
 */
export function safeImagePath(image: string | undefined): string | undefined {
  if (!image || image.includes('://') || image.startsWith('/') || image.includes('\\')) return undefined;
  const local = image.startsWith('local/');
  const root = local ? LOCAL_ASSETS : ASSETS;
  const full = resolve(root, local ? image.slice('local/'.length) : image);
  return full.startsWith(`${root}${sep}`) ? full : undefined;
}

function applyPatch(target: Record<string, unknown>, patch: unknown): void {
  if (!patch || typeof patch !== 'object') return;
  for (const field of FIELDS) {
    const value = (patch as Record<string, unknown>)[field];
    if (value !== undefined) target[field] = value;
  }
}

function parseScreen(item: Record<string, unknown>): InterfaceScreen | null {
  const id = text(item.id, 80);
  const title = text(item.title, 160);
  const routeDescription = text(item.routeDescription, 500);
  const keywords = Array.isArray(item.keywords)
    ? item.keywords.map((word) => text(word, 80)).filter((word): word is string => Boolean(word)).slice(0, 30) : [];
  const instructions = Array.isArray(item.instructions)
    ? item.instructions.map((step) => text(step, 600)).filter((step): step is string => Boolean(step)).slice(0, 30) : [];
  if (!id || !ID.test(id) || !title || !routeDescription || !instructions.length) return null;
  const image = text(item.image, 240) ?? undefined;
  return {
    id, title, routeDescription, keywords, instructions,
    image: safeImagePath(image) ? image : undefined,
    caption: text(item.caption, 500) ?? undefined,
  };
}

/**
 * Строгий публичный контракт: неизвестные поля игнорируются, битый экран
 * отбрасывается целиком. Возвращает экраны уже для выбранного режима.
 */
export function parseInterfaceKnowledge(
  raw: unknown,
  mode: InterfaceMode = 'full',
  overrides?: InterfaceOverrides | null,
): InterfaceKnowledge | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  if (input.locale !== 'ru' || input.app !== 'bedolaga'
      || !['string', 'number'].includes(typeof input.version) || !Array.isArray(input.screens)) return null;

  const sources = [...input.screens.slice(0, 300), ...(overrides?.added ?? []).slice(0, 100)];
  const screens = new Map<string, InterfaceScreen>();
  for (const value of sources) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    // `only` — экран существует лишь в одном виде кабинета.
    if ((item.only === 'full' || item.only === 'lite') && item.only !== mode) continue;
    const merged: Record<string, unknown> = { ...item };
    const modes = item.modes as Record<string, unknown> | undefined;
    applyPatch(merged, modes?.[mode]);
    const own = typeof item.id === 'string' ? overrides?.screens[item.id] : undefined;
    if (own?.hidden) continue;
    applyPatch(merged, own?.all);
    applyPatch(merged, own?.[mode]);
    const screen = parseScreen(merged);
    // Добавленный оператором экран с тем же id заменяет поставляемый.
    if (screen) screens.set(screen.id, screen);
  }
  return { version: input.version as string | number, locale: 'ru', app: 'bedolaga', mode, screens: [...screens.values()] };
}

function readJson(path: string): unknown {
  const bytes = readFileSync(path);
  if (bytes.byteLength > 2_000_000) throw new Error(`${path}: больше 2 МБ`);
  return JSON.parse(bytes.toString('utf8'));
}

/** Оверрайды проверяются так же строго: всё неизвестное отбрасывается. */
export function parseInterfaceOverrides(raw: unknown): InterfaceOverrides {
  const result: InterfaceOverrides = { screens: {}, added: [] };
  if (!raw || typeof raw !== 'object') return result;
  const input = raw as Record<string, unknown>;
  const screens = input.screens && typeof input.screens === 'object' ? input.screens as Record<string, unknown> : {};
  for (const [id, value] of Object.entries(screens).slice(0, 300)) {
    if (!ID.test(id) || !value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const clean: InterfaceOverrides['screens'][string] = {};
    for (const key of ['all', 'full', 'lite'] as const) {
      if (entry[key] && typeof entry[key] === 'object') {
        const patch: ScreenPatch = {};
        applyPatch(patch as Record<string, unknown>, entry[key]);
        if (Object.keys(patch).length) clean[key] = patch;
      }
    }
    if (entry.hidden === true) clean.hidden = true;
    if (Object.keys(clean).length) result.screens[id] = clean;
  }
  if (Array.isArray(input.added)) {
    // В файл попадают только проверенные поля: всё лишнее из тела запроса отбрасывается.
    for (const item of input.added.slice(0, 100)) {
      if (!item || typeof item !== 'object') continue;
      const screen = parseScreen(item as Record<string, unknown>);
      if (!screen) continue;
      const only = (item as Record<string, unknown>).only;
      result.added.push({ ...screen, ...(only === 'full' || only === 'lite' ? { only } : {}) });
    }
  }
  return result;
}

export function loadInterfaceOverrides(path = OVERRIDES): InterfaceOverrides {
  try {
    return parseInterfaceOverrides(readJson(path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('Правки справочника интерфейса не загружены', err);
    return { screens: {}, added: [] };
  }
}

/** Атомарная запись: оператор не должен получить полуфайл при сбое. */
export async function saveInterfaceOverrides(overrides: unknown, path = OVERRIDES): Promise<InterfaceOverrides> {
  const clean = parseInterfaceOverrides(overrides);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
  return clean;
}

// --- картинки инсталляции ---------------------------------------------------

export const MAX_INTERFACE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_LOCAL_IMAGES = 300;

/** Сохраняет проверенную картинку под случайным именем и возвращает значение для поля `image`. */
export async function saveInterfaceImage(bytes: Buffer, ext: 'png' | 'jpg' | 'webp'): Promise<string> {
  if (!bytes.length || bytes.length > MAX_INTERFACE_IMAGE_BYTES) throw new Error('Недопустимый размер картинки');
  await mkdir(LOCAL_ASSETS, { recursive: true });
  const existing = (await readdir(LOCAL_ASSETS)).filter((name) => !name.startsWith('.')).length;
  if (existing >= MAX_LOCAL_IMAGES) throw new Error(`Слишком много картинок (больше ${MAX_LOCAL_IMAGES}). Удалите ненужные в каталоге данных.`);
  const name = `${randomBytes(16).toString('hex')}.${ext}`;
  await writeFile(resolve(LOCAL_ASSETS, name), bytes, { flag: 'wx', mode: 0o600 });
  return `local/${name}`;
}

/** Читает картинку через дескриптор: подложенный симлинк не откроется, размер ограничен. */
export async function readInterfaceImage(image: string): Promise<Buffer | undefined> {
  const path = safeImagePath(image);
  if (!path) return undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_INTERFACE_IMAGE_BYTES) return undefined;
    return await handle.readFile();
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Сырой поставляемый манифест — для редактора (видно, что было «по умолчанию»). */
export function loadShippedManifest(manifestPath = MANIFEST): Record<string, unknown> | null {
  try {
    return readJson(manifestPath) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('База интерфейса Bedolaga не загружена', err);
    return null;
  }
}

export function loadInterfaceKnowledge(
  manifestPath = MANIFEST,
  mode: InterfaceMode = 'full',
  overridesPath: string | null = OVERRIDES,
): InterfaceKnowledge | null {
  const shipped = loadShippedManifest(manifestPath);
  return shipped ? parseInterfaceKnowledge(shipped, mode, overridesPath ? loadInterfaceOverrides(overridesPath) : null) : null;
}

// Манифест читался и разбирался с диска на каждое сообщение клиента.
// Кешируем по mtime обоих файлов: правка подхватывается без рестарта.
const cache = new Map<string, { stamp: string; base: InterfaceKnowledge | null }>();

function mtime(path: string | null): number {
  if (!path) return 0;
  try { return statSync(path).mtimeMs; } catch { return -1; }
}

function cachedInterfaceKnowledge(manifestPath: string, mode: InterfaceMode, overridesPath: string | null): InterfaceKnowledge | null {
  const key = `${manifestPath}|${mode}|${overridesPath ?? ''}`;
  const manifestTime = mtime(manifestPath);
  if (manifestTime < 0) {
    cache.delete(key);
    return null;
  }
  const stamp = `${manifestTime}|${mtime(overridesPath)}`;
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return hit.base;
  const base = loadInterfaceKnowledge(manifestPath, mode, overridesPath);
  cache.set(key, { stamp, base });
  return base;
}

export function activeInterfaceKnowledge(
  query: string,
  enabled: boolean,
  manifestPath = MANIFEST,
  mode: InterfaceMode = 'full',
  overridesPath: string | null = OVERRIDES,
): InterfaceScreen[] {
  return enabled ? searchInterfaceKnowledge(cachedInterfaceKnowledge(manifestPath, mode, overridesPath), query) : [];
}

// --- какой вид кабинета у магазина ---------------------------------------

let detected: { mode: InterfaceMode; at: number } | undefined;

/**
 * Вид кабинета для AI: явный выбор оператора или, в режиме `auto`, то, что
 * сообщает сам кабинет (публичный `GET /cabinet/branding/lite-mode`).
 * Пока ответа нет — полный вид: он описан подробнее.
 */
export function effectiveInterfaceMode(setting: 'auto' | InterfaceMode): InterfaceMode {
  if (setting !== 'auto') return setting;
  return detected?.mode ?? 'full';
}

export function detectedInterfaceMode(): { mode: InterfaceMode; at: number } | undefined {
  return detected;
}

export async function detectInterfaceMode(baseUrl = config.bedolaga.url): Promise<InterfaceMode | undefined> {
  if (!baseUrl) return undefined;
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/cabinet/branding/lite-mode`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') return undefined;
    detected = { mode: body.enabled ? 'lite' : 'full', at: Date.now() };
    return detected.mode;
  } catch (err) {
    log.debug('Вид кабинета Bedolaga не определён', err);
    return undefined;
  }
}

/** Опрос раз в 10 минут: админ может переключить вид в любой момент. */
export function watchInterfaceMode(baseUrl = config.bedolaga.url): () => void {
  if (!baseUrl) return () => undefined;
  void detectInterfaceMode(baseUrl);
  const timer = setInterval(() => void detectInterfaceMode(baseUrl), 10 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

// --- поиск ------------------------------------------------------------------

function words(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase('ru').match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

/** Детерминированный поиск: модель получает только несколько релевантных проверенных экранов. */
export function searchInterfaceKnowledge(base: InterfaceKnowledge | null, query: string, limit = 3): InterfaceScreen[] {
  if (!base || limit <= 0) return [];
  const normalizedQuery = query.toLocaleLowerCase('ru');
  const wanted = words(query);
  if (!wanted.size) return [];
  return base.screens.map((screen) => {
    const haystack = words([screen.title, screen.routeDescription, ...screen.keywords, ...screen.instructions].join(' '));
    let score = 0;
    for (const word of wanted) if (haystack.has(word)) score += 1;
    for (const key of screen.keywords) {
      const normalizedKey = key.toLocaleLowerCase('ru');
      if (normalizedQuery.includes(normalizedKey)) score += 8;
      else {
        const keyWords = words(normalizedKey);
        if (keyWords.size && [...keyWords].every((word) => wanted.has(word))) score += 4;
      }
    }
    if (normalizedQuery.includes(screen.title.toLocaleLowerCase('ru'))) score += 8;
    // Общая карта разделов полезна для «где меню», но не должна занимать
    // top-3 рядом с точной инструкцией продления, подарка или уведомлений.
    if (screen.id === 'navigation'
        && !/(?:меню|главн|где\s+(?:найти|раздел)|личн\S*\s+кабинет|разделы)/iu.test(normalizedQuery)) score = 0;
    return { screen, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((item) => item.screen);
}

export function renderInterfaceKnowledge(screens: InterfaceScreen[]): string {
  if (!screens.length) return '';
  return screens.map((screen) => [
    `Экран: ${screen.title}`,
    `Где находится: ${screen.routeDescription}`,
    ...screen.instructions.map((step, index) => `${index + 1}. ${step}`),
  ].join('\n')).join('\n\n');
}
