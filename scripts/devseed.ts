/**
 * Локальная панель на временной базе с синтетическими диалогами — общая
 * часть scripts/devlive.ts (ручная проверка) и scripts/e2eserver.ts
 * (Playwright). Все внешние системы поддельные: каналы Telegram и Bedolaga,
 * карточка клиента, Remnawave. Ничего не покидает машину. Данные вымышленные.
 *
 * Переменные окружения ставятся до импорта конфигурации, поэтому модули
 * сервера подгружаются динамически внутри startDevPanel.
 *
 * Изоляция (этап 6): `.env` проекта не читается (ENV_FILE → несуществующий
 * файл во временном каталоге), все переменные, которые знает src/config.ts,
 * унаследованные из оболочки, стираются, интеграции выключены, пути файлов
 * обновления и подключений — во временном каталоге. Локальный прогон равен CI
 * и не может увидеть данные настоящей инсталляции. isolate() проверяет это
 * после загрузки конфигурации и падает, если что-то указывает наружу.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, gzipSync } from 'node:zlib';
import { FakeSources, FakeUpdates, fakeNodes, fakeNotifier } from './devfakes.js';

export interface DevPanelOptions {
  port: number;
  token: string;
  /** Ещё столько выдуманных диалогов — нагрузочный e2e (план, 11.6: 500 диалогов). */
  extra?: number;
  /** Диалог на столько сообщений (DEVSEED_HEAVY, замеры раздела D): лента под нагрузкой. */
  longThread?: number;
  /** PANEL_UI установки — e2e «классика для всех» (раздел 12, этап 8). */
  panelUi?: 'classic' | 'next';
}

export interface DevPanel {
  url: string;
  /** Новое сообщение клиента в диалог с номером i из набора (0..39). */
  inbound(i: number, text?: string): number | null;
  /** Новое сообщение в нагрузочный диалог с номером i (0..extra-1) — замеры живых кадров. */
  inboundExtra(i: number, text: string): number | null;
  /** Ответ помощника или оператора — поток событий как у живой панели. */
  outbound(conversationId: number, author: 'ai' | 'agent', text: string): void;
  /** Сколько сообщений ушло в поддельные каналы. */
  sent(): number;
  /** Сколько раз продлевали подписку в поддельной Bedolaga. */
  extensions(): number;
  /** Разорвать все сокеты (проверка обрыва связи). */
  dropSockets(): void;
  stop(): Promise<void>;
}

export const NAMES = ['Анна К.', 'Олег Т.', 'Ирина', 'Павел С.', 'Мария В.', 'Денис', 'Света Л.', 'Георгий', 'Ника', 'Тимур Р.', 'Ольга', 'Артём'];
export const TEXTS = ['Не подключается на телефоне', 'Как продлить подписку?', 'Скорость упала вечером', 'Позовите оператора',
  'Сколько устройств можно?', 'Оплатил, но доступа нет', 'Спасибо, заработало', 'Где взять ссылку подписки?'];

const DAY = 86_400_000;

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
/** Синтетический PNG: градиент, RGB, без внешних файлов. */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      rows[at] = 40 + x * 3; rows[at + 1] = 90 + y * 4; rows[at + 2] = 200;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const GB = 1024 ** 3;

/** Имена переменных, которые читает src/config.ts (строковые литералы в верхнем регистре). */
export function configEnvNames(): string[] {
  const text = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
  return [...new Set([...text.matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)].map((match) => match[1]!))];
}

/** Стереть унаследованные переменные и закрыть чтение .env — до импорта конфигурации. */
function scrubEnv(dir: string): void {
  for (const name of configEnvNames()) delete process.env[name];
  process.env.ENV_FILE = join(dir, 'no-such.env');
  // Интеграции выключены явно: поддельные клиенты передаются в startWeb сами.
  for (const name of ['BEDOLAGA_ENABLED', 'MINISHOP_ENABLED', 'REMNAWAVE_ENABLED', 'NODES_STATUS_ENABLED', 'SUPPORT_API_ENABLED', 'TRANSCRIBE_ENABLED', 'AI_AUTO_LEARN']) {
    process.env[name] = 'false';
  }
  // Модель — закрытый локальный порт: случайный вызов падает сразу, а не уходит в сеть.
  process.env.AI_BASE_URL = 'http://127.0.0.1:9/v1';
  process.env.UPDATE_ENABLED = 'true';
  process.env.UPDATE_REQUEST_FILE = join(dir, 'update-request.json');
  process.env.UPDATE_STATUS_FILE = join(dir, 'update-status.json');
  process.env.SOURCE_REQUEST_FILE = join(dir, 'source-request.json');
  process.env.SOURCE_STATUS_FILE = join(dir, 'source-status.json');
}

/** Проверка после загрузки конфигурации: всё локально и во временном каталоге. */
function isolate(config: { dbPath: string; mediaDir: string; kbDir: string; draftDir: string; update: { requestFile: string; statusFile: string };
  sourceManagement: { requestFile: string; statusFile: string }; ai: { baseUrl: string }; bedolaga: { enabled: boolean }; minishop: { enabled: boolean };
  remnawave: { enabled: boolean } }, dir: string): void {
  const paths = [config.dbPath, config.mediaDir, config.kbDir, config.draftDir, config.update.requestFile, config.update.statusFile,
    config.sourceManagement.requestFile, config.sourceManagement.statusFile];
  const outside = paths.filter((path) => !path.startsWith(dir));
  const enabled = [config.bedolaga.enabled && 'Bedolaga', config.minishop.enabled && 'MiniShop', config.remnawave.enabled && 'Remnawave'].filter(Boolean);
  if (outside.length > 0 || enabled.length > 0 || !/^http:\/\/127\.0\.0\.1:/.test(config.ai.baseUrl)) {
    throw new Error(`Локальная панель не изолирована: пути ${outside.join(', ') || '—'}, интеграции ${enabled.join(', ') || '—'}, модель ${config.ai.baseUrl}`);
  }
}

export async function startDevPanel(options: DevPanelOptions): Promise<DevPanel> {
  const dir = mkdtempSync(join(tmpdir(), 'devlive-'));
  scrubEnv(dir);
  process.env.BOT_TOKEN = '123456:AAFakeForDevLive';
  process.env.PANEL_TOKEN = options.token;
  process.env.AI_MODE = 'suggest';
  process.env.AI_API_KEY = 'dev-key-not-used';
  process.env.LOG_LEVEL = 'error';
  process.env.PANEL_PORT = String(options.port);
  process.env.PANEL_HOST = '127.0.0.1';
  if (options.panelUi) process.env.PANEL_UI = options.panelUi;
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
  const { config, version } = await import('../src/config.js');
  isolate(config, dir);

  const db = openDatabase();
  const store = new Store(db);
  const operations = new Operations(store);
  const outbox = new Outbox(store);
  let sent = 0;
  let extended = 0;
  // Поддельные каналы: отвечают как Telegram и Bedolaga, но ничего не отправляют.
  const fake = { send: async () => ({ externalMsgId: `dev-out-${++sent}` }), sendAttachment: async () => ({ externalMsgId: `dev-file-${++sent}` }) };
  outbox.register('tg_bot', fake);
  outbox.register('tg_dm', fake);
  outbox.register('bedolaga', { send: fake.send });

  let n = 0;
  const inboundAt = (i: number, at: number, text: string) => store.recordInbound({
    channel: i % 4 === 0 ? 'tg_bot' : 'bedolaga', externalId: i % 4 === 0 ? `dev-${i}` : String(4400 + i), displayName: NAMES[i % NAMES.length],
    text, externalMsgId: `dev-${i}-${++n}`, sentAt: at,
  });

  const now = Date.now();
  const colleague = operations.authenticate(operations.createOperator('Мария', 'agent').token)!;
  const byIndex = new Map<number, number>();
  for (let i = 0; i < 40; i += 1) {
    const at = now - (i * 7 + 1) * 60_000;
    const conversation = inboundAt(i, at, TEXTS[i % TEXTS.length]!)!.conversation;
    byIndex.set(i, conversation.id);
    if (i % 5 === 1) store.recordOutbound({ conversationId: conversation.id, author: 'ai', text: 'Попробуйте обновить подписку в приложении.', sentAt: at + 30_000 });
    if (i % 7 === 2) store.recordOutbound({ conversationId: conversation.id, author: 'agent', text: 'Проверили, всё в порядке.', sentAt: at + 60_000 });
    if (i % 6 === 3) store.setHandoff(conversation.id, at + 10_000);
    if (i % 9 === 4) store.setEscalated(conversation.id, true, 'high');
    if (i % 8 === 5) store.createSuggestion({ conversationId: conversation.id, text: 'Черновик ответа', confidence: 0.5 });
    if (i % 8 === 1) store.createSuggestion({ conversationId: conversation.id, text: 'Здравствуйте! Удалите профиль в приложении и добавьте его заново по ссылке из личного кабинета. Если не поможет — пришлите снимок ошибки.', confidence: 0.96, sources: ['Подключение iOS'] });
    if (i % 8 === 3) store.createSuggestion({ conversationId: conversation.id, text: 'Скорость вечером может падать из-за загрузки сервера. Попробуйте другой сервер в приложении.', confidence: 0.86, sources: ['Скорость'], reason: 'нет статьи про этот сервер' });
    if (i % 11 === 6) operations.claim(conversation.id, colleague);
    if (i % 10 === 9) store.setStatus(conversation.id, 'resolved');
    if (i % 13 === 7) store.setSuspicious(conversation.id, true);
  }
  // Нагрузка (11.6): только у отдельного e2e-сервера; каждый третий ждёт человека.
  for (let i = 0; i < (options.extra ?? 0); i += 1) {
    const at = now - (i * 3 + 2) * 60_000;
    const result = store.recordInbound({ channel: 'tg_bot', externalId: `load-${i}`, displayName: `Клиент ${i + 1}`,
      text: TEXTS[i % TEXTS.length]!, externalMsgId: `load-${i}-1`, sentAt: at });
    if (result && i % 3 === 0) store.setHandoff(result.conversation.id, at + 5_000);
  }
  // Длинная лента (DEVSEED_HEAVY): клиент и оператор по очереди, раз в 2 мин, последнее — минуту назад.
  const long = options.longThread ?? 0;
  let longId = 0;
  for (let i = 0; i < long; i += 1) {
    const at = now - (long - i) * 120_000;
    if ((long - 1 - i) % 2 === 0 || !longId) {
      longId = store.recordInbound({ channel: 'tg_bot', externalId: 'long-1', displayName: 'Длинный диалог',
        text: `${TEXTS[i % TEXTS.length]!} (${i + 1})`, externalMsgId: `long-1-${i}`, sentAt: at })?.conversation.id ?? longId;
    } else {
      store.recordOutbound({ conversationId: longId, author: i % 6 === 1 ? 'ai' : 'agent', text: `Ответ ${i + 1}: проверьте подписку в приложении.`, sentAt: at });
    }
  }

  // Картинка 64×32 (настоящий PNG — её можно открыть в редакторе), чтобы в ленте было фото с размерами.
  const png = makePng(64, 32);
  const photoMsg = inboundAt(0, now - 30_000, 'Вот снимок ошибки')!.message;
  const saved = await saveUploadedMedia((async function* () { yield png; })(), config.mediaMaxFileBytes);
  store.addLocalAttachment(photoMsg.id, { fileRef: saved.fileRef, localPath: saved.localPath, mediaType: 'photo', mimeType: 'image/png',
    originalName: 'ошибка.png', bytes: saved.bytes, sha256: saved.sha256, width: 640, height: 320 });
  store.addNote(photoMsg.conversation_id, 'Клиент на iOS 17, проверить профиль.');

  // «Знания» (этап 5): выдуманные статьи, черновик с правками, черновик-идеи.
  const kbDir = join(dir, 'kb');
  const draftDir = join(dir, 'draft');
  writeFileSync(join(kbDir, 'podklyuchenie-ios.md'), '# Подключение iOS\n\n1. Установите приложение из App Store.\n2. Нажмите «+» и вставьте ссылку из письма.\n');
  writeFileSync(join(kbDir, 'limit-ustroystv.md'), '# Лимит устройств\n\nНа тарифе до трёх устройств одновременно. Лишние отключаются в боте.\n');
  writeFileSync(join(kbDir, 'skorost.md'), '# Скорость\n\nЕсли вечером медленно, выберите другой сервер в приложении.\n');
  writeFileSync(join(draftDir, 'skorost.md'), '# Скорость\n\nЕсли вечером медленно, выберите другой сервер в приложении.\nПомогает и перезапуск приложения.\n');
  writeFileSync(join(draftDir, 'vozvrat-platezha.md'), '# Возврат платежа\n\nВозврат оформляется в течение трёх дней после оплаты.\n');
  writeFileSync(join(draftDir, 'prodlenie-posle-blokirovki-karty.md'), '# Продление после блокировки карты\n\nЕсли оплата не прошла, смените карту в разделе «Оплата» — подписка продлится сама.\n');
  writeFileSync(join(draftDir, 'vtoroy-telefon.md'), '# Второй телефон на подписке\n\nДобавьте устройство по той же ссылке; лимит — три устройства.\n');
  writeFileSync(join(draftDir, 'oshibka-sertifikata.md'), '# Ошибка сертификата на iOS\n\nОбновите профиль: удалите его и добавьте заново по ссылке.\n');
  operations.registerCandidates([
    { title: 'Продление после блокировки карты', file: 'prodlenie-posle-blokirovki-karty.md', confidence: 0.9 },
    { title: 'Второй телефон на подписке', file: 'vtoroy-telefon.md', confidence: 0.7 },
    { title: 'Ошибка сертификата на iOS', file: 'oshibka-sertifikata.md', confidence: 0.5 },
  ], 'auto-learn');
  store.syncKb('files', [
    { extId: 'podklyuchenie-ios.md', title: 'Подключение iOS', body: 'Установите приложение из App Store.' },
    { extId: 'limit-ustroystv.md', title: 'Лимит устройств', body: 'На тарифе до трёх устройств одновременно.' },
    { extId: 'skorost.md', title: 'Скорость', body: 'Если вечером медленно, выберите другой сервер.' },
  ]);
  // Анимированный стикер TGS (Lottie в gzip): квадрат, который вращается.
  const lottie = { v: '5.5.2', fr: 30, ip: 0, op: 60, w: 128, h: 128, nm: 'dev', ddd: 0, assets: [], layers: [{
    ddd: 0, ind: 1, ty: 4, nm: 'square', sr: 1, ip: 0, op: 60, st: 0, bm: 0,
    ks: { o: { a: 0, k: 100 }, r: { a: 1, k: [{ t: 0, s: [0], i: { x: [0.5], y: [0.5] }, o: { x: [0.5], y: [0.5] } }, { t: 60, s: [360] }] },
      p: { a: 0, k: [64, 64, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } },
    shapes: [{ ty: 'rc', d: 1, s: { a: 0, k: [60, 60] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 12 } },
      { ty: 'fl', c: { a: 0, k: [0.15, 0.39, 0.92, 1] }, o: { a: 0, k: 100 } }],
  }] };
  const tgs = gzipSync(Buffer.from(JSON.stringify(lottie)));
  const stickerMsg = inboundAt(0, now - 20_000, '')!.message;
  const savedTgs = await saveUploadedMedia((async function* () { yield tgs; })(), config.mediaMaxFileBytes);
  store.addLocalAttachment(stickerMsg.id, { fileRef: savedTgs.fileRef, localPath: savedTgs.localPath, mediaType: 'tgs_sticker',
    mimeType: 'application/x-tgsticker', originalName: 'sticker.tgs', bytes: savedTgs.bytes, sha256: savedTgs.sha256, width: 128, height: 128 });
  // Ответ помощника из черновика — для «Почему так?».
  const answered = byIndex.get(4)!;
  const used = store.createSuggestion({ conversationId: answered, text: 'Можно подключить до трёх устройств.', confidence: 0.88,
    sources: ['Устройства'], reason: 'статья короткая' });
  store.recordOutbound({ conversationId: answered, author: 'ai', text: 'Можно подключить до трёх устройств.', suggestionId: used.id });
  // Журнал помощника для «Что делал помощник» и «Сегодня» (этап 4): решения ворот и передачи.
  store.logEvent('ai_draft', answered, { suggestion: used.id, action: 'auto', reason: 'уверенность 0.88' });
  for (const row of db.prepare('SELECT id, conversation_id, confidence FROM ai_suggestion WHERE id != ?').all(used.id) as Array<{ id: number; conversation_id: number; confidence: number | null }>) {
    store.logEvent('ai_draft', row.conversation_id, { suggestion: row.id, action: 'suggest',
      reason: (row.confidence ?? 0) < 0.7 ? 'уверенность 0.50 ниже порога' : 'режим suggest' });
  }
  for (const [i, id] of byIndex) if (i % 6 === 3) store.logEvent('ai_handoff', id, { reason: 'модель сама просит человека' });
  // Business-диалог: клиент писал больше суток назад — окно ответа закрыто.
  store.recordInbound({ channel: 'tg_dm', externalId: 'dev-biz', displayName: 'Дина С.', text: 'Верните деньги за месяц',
    externalMsgId: 'dev-biz-1', sentAt: now - 26 * 60 * 60_000, tgUserId: 900001, businessConnectionId: 'dev-bc' });
  store.recordInbound({ channel: 'tg_dm', externalId: 'dev-biz2', displayName: 'Елена П.', text: 'Можно на второй телефон?',
    externalMsgId: 'dev-biz2-1', sentAt: now - 21 * 60 * 60_000 - 30 * 60_000, tgUserId: 900002, businessConnectionId: 'dev-bc' });
  store.upsertTemplate('привет', 'Приветствие', 'Здравствуйте! Сейчас посмотрю.');

  // --- поддельные источники карточки клиента -------------------------------
  const indexOf = new Map([...byIndex].map(([i, id]) => [id, i]));
  type Conv = { id: number };
  const iso = (ms: number): string => new Date(ms).toISOString();
  const profileOf = (conversation: Conv) => {
    const i = indexOf.get(conversation.id) ?? 100;
    if (i % 13 === 7) {
      return { found: false, identity: {}, sources: [], trace: ['Bedolaga: по Telegram ID ничего', 'Remnawave: по нику и описанию ничего'] };
    }
    const sourceFailed = i % 17 === 11;
    return {
      found: true,
      identity: { username: `client${i}`, name: NAMES[i % NAMES.length] },
      subscription: {
        status: i % 6 === 5 ? 'EXPIRED' : 'ACTIVE', expiresAt: iso(now + ((i * 3) % 40) * DAY - (i % 6 === 5 ? 50 * DAY : 0)),
        trafficUsed: ((i * 7) % 90) * GB, trafficLimit: 100 * GB, deviceLimit: 3, devices: (i % 3) + 1, shortId: `dev${i}a1`,
      },
      activity: {
        firstSeen: iso(now - (60 + i * 9) * DAY), dailyAverageBytes: (0.4 + (i % 5) * 0.3) * GB,
        topNodes: [{ name: 'Франкфурт-2 (Германия 2)', bytes: 31 * GB }, { name: 'Амстердам-1', bytes: 8 * GB }],
        lastNode: 'Франкфурт-2 (Германия 2)',
      },
      ...(i % 4 !== 0 ? { balance: { amount: 120 + i * 10, currency: 'RUB' } } : {}),
      remnawaveRef: `dev-ref-${i}`,
      sources: i % 4 !== 0 ? ['Bedolaga', 'Remnawave'] : ['Remnawave'],
      trace: ['Bedolaga: найден по Telegram ID', `Remnawave: запись dev-ref-${i} по нику`],
      ...(sourceFailed ? { sourceFailed: true } : {}),
    };
  };
  const checked = new Map<number, number>();
  const customers = {
    async get(conversation: Conv) { if (!checked.has(conversation.id)) checked.set(conversation.id, Date.now() - 3 * 60_000); return profileOf(conversation); },
    async build(conversation: Conv) { checked.set(conversation.id, Date.now()); return profileOf(conversation); },
    peek(conversation: Conv) { return { profile: profileOf(conversation), stale: false }; },
    checkedAt(conversation: Conv) { return checked.get(conversation.id) ?? null; },
  };
  const devicesOf = new Map<string, Array<{ id: string; hwid: string; platform: string; model: string }>>();
  const devices = (ref: string) => {
    if (!devicesOf.has(ref)) devicesOf.set(ref, [
      { id: '1', hwid: `${ref}-hw-iphone`, platform: 'iOS', model: 'iPhone 14' },
      { id: '2', hwid: `${ref}-hw-laptop`, platform: 'Windows', model: 'Ноутбук' },
    ]);
    return devicesOf.get(ref)!;
  };
  const remnawave = {
    capabilities: () => ({ profile: true, devices: true, deleteDevice: true, resetDevices: true, revoke: true }),
    indexState: () => ({ size: 40, at: now }),
    async profile(ref: string) {
      const i = Number(ref.replace(/\D/g, ''));
      return { userRef: ref, username: `client${i}`, status: 'ACTIVE', expiresAt: iso(now + 33 * DAY), trafficUsed: 41 * GB, trafficLimit: 100 * GB,
        deviceLimit: 3, shortId: `dev${i}a1`, subscriptionUrl: `https://sub.example.invalid/${ref}` };
    },
    async devices(ref: string) { return devices(ref); },
    async resetDevices(ref: string) { devicesOf.set(ref, []); return true; },
    async revoke() { return true; },
    async deleteDevice(ref: string, hwid: string) { devicesOf.set(ref, devices(ref).filter((d) => d.hwid !== hwid)); return true; },
    async explain() { return { ref: undefined, steps: ['Искали по Telegram ID — нет', 'Искали по нику — нет', 'Искали в описании — нет'], indexSize: 40, near: [] }; },
    async nodes() { return []; },
  };
  const bedUser = {
    id: 42, telegram_id: 555, username: 'client', first_name: 'Анна', last_name: 'К.', status: 'active', language: 'ru',
    balance_kopeks: 12_000, referral_code: 'DEV42', has_had_paid_subscription: true, has_made_first_topup: true,
    created_at: iso(now - 200 * DAY), last_activity: iso(now - DAY),
    promo_group: { id: 1, name: 'Постоянные', server_discount_percent: 10 },
  };
  let bedSubscription = {
    id: 900, user_id: 42, status: 'active', actual_status: 'active', is_trial: false, start_date: iso(now - 20 * DAY),
    end_date: iso(now + 12 * DAY), traffic_limit_gb: 100, traffic_used_gb: 41, device_limit: 3, autopay_enabled: false,
  };
  const page = <T>(items: T[], limit = 50, offset = 0) => ({ items: items.slice(offset, offset + limit), total: items.length, limit, offset });
  const bedolaga = {
    setStatus: async () => undefined,
    userByTelegramId: async () => bedUser,
    searchUsers: async () => [bedUser],
    userTransactions: async () => [],
    user: async () => bedUser,
    ticket: async (ticketId: number) => ({ id: ticketId, user_id: 42, title: 'Заявка', status: 'open', messages: [] }),
    subscriptions: async (_u: number, limit?: number, offset?: number) => page([bedSubscription], limit, offset),
    transactions: async (_u: number, limit?: number, offset?: number) => page([
      { id: 701, user_id: 42, type: 'payment', amount_kopeks: 25_000, description: 'Оплата месяца', payment_method: 'card', is_completed: true, created_at: iso(now - 20 * DAY) },
    ], limit, offset),
    ticketsForUser: async (_u: number, limit?: number, offset?: number) => page([
      { id: 77, user_id: 42, title: 'Не подключается', status: 'open', priority: 'normal', messages_count: 2, created_at: iso(now - DAY) },
    ], limit, offset),
    referralDetails: async (_u: number, limit = 50, offset = 0) => ({
      referrer: { invited_count: 1, active_referrals: 1, total_earned_kopeks: 5000, referral_commission_percent: 10 },
      referrals: { items: [{ id: 43, username: 'friend', status: 'active' }], total: 1, limit, offset },
    }),
    extendSubscription: async (subscriptionId: number, days: number) => {
      extended += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      bedSubscription = { ...bedSubscription, end_date: iso(Date.parse(bedSubscription.end_date) + days * DAY) };
      return { ...bedSubscription, id: subscriptionId };
    },
  };

  // --- этап 6: команда, журнал, история обновлений, подключения (всё выдуманное) ---
  const lead = operations.createOperator('Пётр', 'lead');
  const off = operations.createOperator('Софья', 'viewer');
  operations.setOperatorActive(Number(off.operator.id), false);
  const root = operations.rootActor();
  const peter = operations.authenticate(lead.token)!;
  operations.audit(root, 'POST /api/settings', 'settings', undefined, { aiMode: 'auto' });
  operations.audit(peter, 'PUT /api/sla/high', 'sla', 'high', { firstResponseMinutes: 30, resolutionMinutes: 480 });
  operations.audit(colleague, 'POST /api/conversations/3/reply', 'conversations', '3', { text: 'Проверили, всё в порядке.' });
  operations.audit(root, 'POST /api/operators', 'operators', undefined, { name: 'Софья', role: 'viewer' });
  operations.audit(peter, 'POST /api/kb/publish/skorost.md', 'kb', 'publish', {});
  operations.audit(root, 'POST /api/nodes/alias', 'nodes', 'alias', { name: 'de-fra-2', alias: 'Германия 2' });
  operations.recordUpdate('update', version, 'completed', root);
  store.syncSource({ id: 'telegram-dev', kind: 'telegram_bot', name: 'Поддержка', enabled: true });
  store.saveServiceProfile('telegram-dev', { serviceName: 'Поддержка', greetingMessage: 'Здравствуйте! Чем помочь?', handoffMessage: 'Передаю ваш вопрос специалисту, он скоро ответит.' });
  store.saveFolder({ name: 'Бот', color: '#2563eb', sourceIds: ['telegram-dev'] });

  const updates = new FakeUpdates(version);
  const sources = new FakeSources((job) => store.syncSource({ id: job.id, kind: job.kind as 'telegram_bot', name: job.name, enabled: true }));
  const app = await startWeb({ store, outbox, customers: customers as never, remnawave: remnawave as never, bedolaga: bedolaga as never,
    updates: updates as never, sources: sources as never, nodes: fakeNodes(now) as never, notifier: fakeNotifier() as never });
  // После startWeb: он ставит синхронизацию заявок через клиента Bedolaga.
  outbox.registerStatusSync('bedolaga', async () => undefined);

  return {
    url: `http://127.0.0.1:${options.port}`,
    inbound(i, text) {
      const result = inboundAt(i, Date.now(), text ?? TEXTS[Math.floor(Math.random() * TEXTS.length)]!);
      return result?.conversation.id ?? null;
    },
    inboundExtra(i, text) {
      const result = store.recordInbound({ channel: 'tg_bot', externalId: `load-${i}`, displayName: `Клиент ${i + 1}`,
        text, externalMsgId: `load-${i}-${++n}`, sentAt: Date.now() });
      return result?.conversation.id ?? null;
    },
    outbound(conversationId, author, text) { store.recordOutbound({ conversationId, author, text }); },
    sent: () => sent,
    extensions: () => extended,
    dropSockets() {
      const server = (app as unknown as { websocketServer?: { clients: Set<{ terminate(): void }> } }).websocketServer;
      for (const client of server?.clients ?? []) client.terminate();
    },
    async stop() {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
