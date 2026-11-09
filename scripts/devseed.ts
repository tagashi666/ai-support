/**
 * Локальная панель на временной базе с синтетическими диалогами — общая
 * часть scripts/devlive.ts (ручная проверка) и scripts/e2eserver.ts
 * (Playwright). Все внешние системы поддельные: каналы Telegram и Bedolaga,
 * карточка клиента, Remnawave. Ничего не покидает машину. Данные вымышленные.
 *
 * Переменные окружения ставятся до импорта конфигурации, поэтому модули
 * сервера подгружаются динамически внутри startDevPanel.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface DevPanelOptions {
  port: number;
  token: string;
}

export interface DevPanel {
  url: string;
  /** Новое сообщение клиента в диалог с номером i из набора (0..39). */
  inbound(i: number, text?: string): number | null;
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
const GB = 1024 ** 3;

export async function startDevPanel(options: DevPanelOptions): Promise<DevPanel> {
  process.env.BOT_TOKEN = '123456:AAFakeForDevLive';
  process.env.PANEL_TOKEN = options.token;
  process.env.AI_MODE = 'suggest';
  process.env.AI_API_KEY = 'dev-key-not-used';
  process.env.LOG_LEVEL = 'error';
  process.env.PANEL_PORT = String(options.port);
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
  let extended = 0;
  // Поддельные каналы: отвечают как Telegram и Bedolaga, но ничего не отправляют.
  const fake = { send: async () => ({ externalMsgId: `dev-out-${++sent}` }), sendAttachment: async () => ({ externalMsgId: `dev-file-${++sent}` }) };
  outbox.register('tg_bot', fake);
  outbox.register('tg_dm', fake);
  outbox.register('bedolaga', { send: fake.send });

  let n = 0;
  const inboundAt = (i: number, at: number, text: string) => store.recordInbound({
    channel: i % 4 === 0 ? 'tg_bot' : 'bedolaga', externalId: `dev-${i}`, displayName: NAMES[i % NAMES.length],
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

  // Картинка 2×1 пикселя (PNG), чтобы в ленте было фото с размерами.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNgYPj/n4GBgQEAEgIC/2nUPxkAAAAASUVORK5CYII=', 'base64');
  const photoMsg = inboundAt(0, now - 30_000, 'Вот снимок ошибки')!.message;
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

  const app = await startWeb({ store, outbox, customers: customers as never, remnawave: remnawave as never, bedolaga: bedolaga as never });
  // После startWeb: он ставит синхронизацию заявок через клиента Bedolaga.
  outbox.registerStatusSync('bedolaga', async () => undefined);

  return {
    url: `http://127.0.0.1:${options.port}`,
    inbound(i, text) {
      const result = inboundAt(i, Date.now(), text ?? TEXTS[Math.floor(Math.random() * TEXTS.length)]!);
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
