import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BOT_TOKEN = '';
process.env.PANEL_TOKEN = 'minishop-test-token-0123456789';
process.env.AI_MODE = 'off';
process.env.MINISHOP_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
const dir = mkdtempSync(join(tmpdir(), 'ai-support-minishop-'));
process.env.DB_PATH = join(dir, 'minishop.db');
process.env.MEDIA_DIR = join(dir, 'media');
process.env.KB_DIR = join(dir, 'kb');
process.env.SOURCE_REQUEST_FILE = join(dir, 'source-request.json');
process.env.SOURCE_STATUS_FILE = join(dir, 'source-status.json');

const { openDatabase } = await import('../src/core/db.js');
const { Store } = await import('../src/core/store.js');
const {
  MinishopClient,
  MinishopPoller,
  MinishopSender,
  localStatusForMinishop,
  minishopMessageText,
  minishopStatusForLocal,
} = await import('../src/channels/minishop.js');
const { CustomerDirectory, minishopCustomerReader } = await import('../src/integrations/customers.js');
const { SourceManager } = await import('../src/core/sources.js');

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown): void => {
  if (condition) console.log(`  ok    ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`, detail ?? ''); }
};

const user = {
  user_id: 7,
  telegram_id: 7007,
  username: 'mini_user',
  first_name: 'Мини',
  last_name: 'Клиент',
  registration_date: '2026-01-01T00:00:00Z',
};
const ticket = (id: number, status = 'awaiting_admin') => ({
  ticket_id: id,
  user_id: 7,
  subject: `Тикет ${id}`,
  category: 'technical',
  priority: 'normal',
  status,
  last_message_at: '2026-09-18T10:05:00Z',
  last_message_role: 'user',
  user,
});
const details = new Map<number, any>([
  [41, {
    ok: true,
    ticket: ticket(41),
    messages: [
      { message_id: 1, ticket_id: 41, author_role: 'user', body: '<b>Не работает</b><br>на роутере', body_format: 'html', image_id: 'a'.repeat(32), is_internal_note: false, created_at: '2026-09-18T10:00:00Z' },
      { message_id: 2, ticket_id: 41, author_role: 'admin', author_name: 'Оператор', body: 'Смотрю', body_format: 'text', image_id: null, is_internal_note: false, created_at: '2026-09-18T10:03:00Z' },
      { message_id: 3, ticket_id: 41, author_role: 'admin', body: 'внутренняя заметка', body_format: 'text', image_id: null, is_internal_note: true, created_at: '2026-09-18T10:04:00Z' },
    ],
    user_snapshot: {
      name: 'Мини Клиент', telegram_id: 7007, username: 'mini_user',
      subscription_active: true, panel_status: 'ACTIVE', end_date: '2026-12-01T00:00:00Z',
      registration_date: '2026-01-01T00:00:00Z',
      traffic_regular: { used_bytes: 100, limit_bytes: 1000 },
      traffic_premium: { used_bytes: 20, limit_bytes: 200 },
    },
  }],
]);

let listIds = [41];
let pagingDemo = false;
let replyCalls = 0;
let failedReplyCalls = 0;
let imageReplyCalls = 0;
let patchStatus = '';
let readCalls = 0;
let sawPluginAuth = false;
let sawAdminAuth = false;
const offsets: number[] = [];

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname.startsWith('/api/plugins/ai-support/v1')) {
    sawPluginAuth ||= req.headers['x-api-key'] === 'service-secret';
    if (req.headers['x-api-key'] !== 'service-secret') return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (url.pathname.startsWith('/api/admin')) {
    sawAdminAuth ||= req.headers.authorization === 'Bearer admin-session';
    if (req.headers.authorization !== 'Bearer admin-session') return json({ ok: false, error: 'unauthorized' }, 401);
  }
  const path = url.pathname
    .replace('/api/plugins/ai-support/v1', '')
    .replace('/api/admin', '');
  if (path === '/health') return json({ ok: true, plugin: 'ai_support', version: '1.0.0' });
  if (path === '/support/stats') return json({ ok: true, stats: { active: 2 } });
  if (path === '/support/tickets' && req.method === 'GET') {
    const offset = Number(url.searchParams.get('offset') ?? 0);
    offsets.push(offset);
    if (pagingDemo) {
      const count = offset === 0 ? 100 : offset === 100 ? 1 : 0;
      return json({ ok: true, tickets: Array.from({ length: count }, (_, index) => ticket(offset + index + 1)) });
    }
    return json({ ok: true, tickets: listIds.map((id) => details.get(id)?.ticket ?? ticket(id)) });
  }
  const detail = /^\/support\/tickets\/(\d+)$/.exec(path);
  if (detail && req.method === 'GET') {
    const value = details.get(Number(detail[1]));
    return value ? json(value) : json({ ok: false, error: 'not_found', message: 'Ticket not found' }, 404);
  }
  const messages = /^\/support\/tickets\/(\d+)\/messages$/.exec(path);
  if (messages && req.method === 'POST') {
    const id = Number(messages[1]);
    if (id === 99) {
      failedReplyCalls += 1;
      req.resume();
      return json({ ok: false, error: 'temporary' }, 500);
    }
    const multipart = String(req.headers['content-type'] ?? '').startsWith('multipart/form-data');
    if (multipart) imageReplyCalls += 1;
    else replyCalls += 1;
    req.resume();
    return json({ ok: true, message: { message_id: multipart ? 902 : 901 } });
  }
  if (detail && req.method === 'PATCH') {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      patchStatus = JSON.parse(Buffer.concat(chunks).toString('utf8')).status;
      json({ ok: true, ticket: ticket(Number(detail[1]), patchStatus) });
    });
    return;
  }
  if (/^\/support\/tickets\/\d+\/read$/.test(path) && req.method === 'POST') {
    readCalls += 1;
    req.resume();
    return json({ ok: true });
  }
  if (path === `/message-images/${'a'.repeat(32)}`) {
    res.writeHead(200, { 'content-type': 'image/webp' });
    return res.end(Buffer.from('mini-image'));
  }
  return json({ ok: false, error: 'not_found' }, 404);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/api`;
const client = new MinishopClient(base, 'service-secret', 'plugin');

console.log('\n[ MiniShop API ]');
check('plugin health и нормализация /api работают', (await client.probe()) === 'ai_support 1.0.0');
pagingDemo = true;
const paged = await client.activeTickets();
check('активные тикеты читаются постранично', paged.length === 101 && offsets.slice(-2).join(',') === '0,100', { length: paged.length, offsets });
pagingDemo = false;
check('plugin mode передаёт X-API-Key', sawPluginAuth);
const adminClient = new MinishopClient(base, 'admin-session', 'admin');
check('admin fallback использует штатный AdminBearer', (await adminClient.probe()).includes('2') && sawAdminAuth);
check('статусы MiniShop отображаются без потерь',
  localStatusForMinishop('awaiting_admin') === 'open'
    && localStatusForMinishop('awaiting_user') === 'pending'
    && localStatusForMinishop('closed') === 'resolved'
    && minishopStatusForLocal('pending') === 'awaiting_user');
check('Telegram HTML превращается в безопасный plain text',
  minishopMessageText({ body: '<b>Текст</b><br>&lt;ok&gt;', body_format: 'html' }) === 'Текст\n<ok>');

console.log('\n[ companion-образ MiniShop ]');
const pluginDockerfile = readFileSync('deploy/minishop-plugin/Dockerfile', 'utf8');
const pluginOverride = readFileSync('deploy/minishop-plugin/docker-compose.override.example.yml', 'utf8');
const pluginSource = readFileSync('deploy/minishop-plugin/minishop_ai_support/__init__.py', 'utf8');
check('базовый backend закреплён на проверенной версии',
  pluginDockerfile.includes('remnawave-minishop-backend:3.7.1')
    && !pluginDockerfile.includes('remnawave-minishop-backend:latest'));
check('compose не смешивает companion-образ с плавающим latest',
  pluginOverride.includes('MINISHOP_AI_SUPPORT_IMAGE:-minishop-backend-ai-support:3.7.1'));
check('загрузка внешних плагинов включена явно',
  pluginOverride.includes('PLUGINS_ENABLED: "true"') && pluginOverride.includes('PLUGINS_STRICT: "true"'));
check('неподготовленный администратор получает диагностируемую ошибку',
  pluginSource.includes('503, "admin_unavailable"'));
check('повреждённое изображение не превращается в HTTP 500',
  pluginSource.includes('(ValueError, MessageImageError, SyntaxError)'));
check('service API регистрируется на backend и WebApp плоскостях',
  pluginSource.includes('WEB_SCOPE_WEBAPP, WEB_SCOPE_WEBHOOKS')
    && pluginSource.includes('{WEB_SCOPE_WEBAPP, WEB_SCOPE_WEBHOOKS}'));

console.log('\n[ подключение MiniShop ]');
const sourceToken = 'source-service-token-0123456789';
const sourceState = await new SourceManager().request({
  kind: 'minishop', name: 'Основной магазин', url: `http://127.0.0.1:${port}/api`,
  token: sourceToken, mode: 'plugin',
}, []);
const sourceRequest = JSON.parse(readFileSync(process.env.SOURCE_REQUEST_FILE, 'utf8')) as any;
check('MiniShop ставится в очередь с фиксированным source id', sourceState.queued
  && sourceRequest.source.id === 'minishop-default' && sourceRequest.source.mode === 'plugin');
check('service token не возвращается из SourceManager', !JSON.stringify(sourceState).includes(sourceToken));
check('файл задания MiniShop имеет режим 0600', (statSync(process.env.SOURCE_REQUEST_FILE).mode & 0o777) === 0o600);
unlinkSync(process.env.SOURCE_REQUEST_FILE);

console.log('\n[ MiniShop poller ]');
const db = openDatabase();
const store = new Store(db);
const events: { text: string | null; backfill: boolean }[] = [];
store.on('message', ({ conversation, message, backfill }) => {
  if (conversation.channel === 'minishop') events.push({ text: message.text, backfill });
});
const poller = new MinishopPoller(client, store, 60_000, 'Мой MiniShop');
await poller.tick();
const first = store.findConversation('minishop', '41', 'minishop-default');
check('тикет импортирован в отдельный канал и источник', first?.source_id === 'minishop-default'
  && first.channel === 'minishop' && store.sourceAccount('minishop-default')?.name === 'Мой MiniShop', first);
check('пользователь MiniShop связан с Telegram', first?.tg_user_id === 7007 && first.username === 'mini_user');
check('холодная история импортирована без live-событий', events.length === 2 && events.every((event) => event.backfill), events);
check('внутренняя заметка не попала клиентской перепиской', store.listMessages(first!.id).length === 2);
check('HTML сообщения очищен', store.listMessages(first!.id)[0]?.text === 'Не работает\nна роутере');
check('картинка MiniShop зарегистрирована', store.pendingAttachments().some((item) => item.file_ref === `minishop:${'a'.repeat(32)}`));
await poller.tick();
check('повторный poll не дублирует сообщения', store.listMessages(first!.id).length === 2);

details.set(42, {
  ok: true,
  ticket: ticket(42, 'awaiting_user'),
  messages: [
    { message_id: 10, ticket_id: 42, author_role: 'user', body: 'старый контекст', body_format: 'text', image_id: null, is_internal_note: false, created_at: '2026-09-18T11:00:00Z' },
    { message_id: 11, ticket_id: 42, author_role: 'user', body: 'живой вопрос', body_format: 'text', image_id: null, is_internal_note: false, created_at: '2026-09-18T11:01:00Z' },
  ],
  user_snapshot: {},
});
listIds = [41, 42];
const beforeLive = events.length;
await poller.tick();
const liveEvents = events.slice(beforeLive);
const second = store.findConversation('minishop', '42', 'minishop-default');
check('у нового тикета после baseline только последнее входящее live',
  liveEvents.length === 2 && liveEvents.filter((event) => !event.backfill).length === 1
    && liveEvents.find((event) => !event.backfill)?.text === 'живой вопрос', liveEvents);
check('awaiting_user синхронизирован как ожидание клиента', second?.status === 'pending');

details.get(41).ticket.status = 'closed';
listIds = [42];
await poller.tick();
check('исчезнувший из active тикет дочитывается и закрывается локально', store.getConversation(first!.id)?.status === 'resolved');

console.log('\n[ MiniShop исходящие и профиль ]');
const sender = new MinishopSender(client);
const sent = await sender.send(second!, { text: 'Ответ оператора' });
check('текстовый ответ уходит в штатный messages endpoint', sent.externalMsgId === '901' && replyCalls === 1);
const sentImage = await sender.sendAttachment(second!, {
  bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg', mediaType: 'photo', fileName: 'answer.jpg', caption: 'Фото',
});
check('ответ с картинкой отправляется multipart', sentImage.externalMsgId === '902' && imageReplyCalls === 1);
let rejected = false;
try { await client.reply(99, 'не ретраить'); } catch { rejected = true; }
check('неидемпотентный reply не повторяется после HTTP 500', rejected && failedReplyCalls === 1, failedReplyCalls);
await client.setStatus(42, 'resolved');
await client.markRead(42);
check('статус и read синхронизируются обратно', patchStatus === 'resolved' && readCalls === 1, { patchStatus, readCalls });
check('изображение скачивается с авторизацией', (await client.downloadImage('a'.repeat(32)))?.toString() === 'mini-image');
check('опасный image id отбрасывается до запроса', await client.downloadImage('../secret') === null);

const directory = new CustomerDirectory(store, undefined, undefined, minishopCustomerReader(client));
const profile = await directory.build(store.getConversation(first!.id)!);
check('карточка клиента дополнена snapshot MiniShop', profile.found
  && profile.sources.includes('MiniShop')
  && profile.identity.telegramId === 7007
  && profile.subscription?.trafficUsed === 120
  && profile.subscription.trafficLimit === 1200, profile);

await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
db.close();
rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nMiniShop: все проверки прошли' : `\nПровалено: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
