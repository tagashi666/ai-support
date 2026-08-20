/**
 * Прогоняет конвейер целиком без настоящего токена и без сети:
 * фейковый апдейт → grammY → SQLite → правила окна → outbox.
 *
 *   npm run smoke
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BOT_TOKEN ??= '123456:AAFakeTokenForSmokeTestOnly';
process.env.PANEL_TOKEN ??= 'smoke-token-0123456789abcdef';
const dir = mkdtempSync(join(tmpdir(), 'ai-support-'));
process.env.DB_PATH = join(dir, 'smoke.db');
process.env.LOG_LEVEL = 'warn';
process.env.AI_MODE = 'off';

const { createBot } = await import('../src/channels/tgdm.js');
const { Store, replyWindow, REPLY_WINDOW_MS } = await import('../src/core/store.js');
const { openDatabase } = await import('../src/core/db.js');
const { Outbox, WindowClosedError } = await import('../src/core/outbox.js');

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}`, detail ?? '');
  }
}

const db = openDatabase();
const store = new Store(db);
const bot = createBot(store, {
  botInfo: {
    id: 777,
    is_bot: true,
    first_name: 'support',
    username: 'support_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: true,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  },
});

const CONNECTION = 'biz-conn-1';
const PEER = 555001;
const now = Math.floor(Date.now() / 1000);

await bot.handleUpdate({
  update_id: 1,
  business_connection: {
    id: CONNECTION,
    user: { id: PEER, is_bot: false, first_name: 'Владислав' },
    user_chat_id: PEER,
    date: now,
    is_enabled: true,
    rights: { can_reply: true, can_read_messages: true },
  },
} as never);

check('бизнес-подключение сохранено', store.activeBusinessConnectionId() === CONNECTION);

const incoming = (messageId: number, text: string) => ({
  update_id: messageId + 100,
  business_message: {
    message_id: messageId,
    date: now,
    chat: { id: PEER, type: 'private' as const, first_name: 'Клиент' },
    from: { id: PEER, is_bot: false, first_name: 'Клиент', username: 'client' },
    business_connection_id: CONNECTION,
    text,
  },
});

await bot.handleUpdate(incoming(1, 'не подключается нода') as never);
let conversations = store.listConversations();
check('диалог создан из личного сообщения', conversations.length === 1, conversations);

const conversation = conversations[0]!;
check('канал определён как tg_dm', conversation.channel === 'tg_dm');
check('business_connection_id сохранён', conversation.business_connection_id === CONNECTION);
check('счётчик непрочитанных вырос', conversation.unread === 1);

await bot.handleUpdate(incoming(1, 'не подключается нода') as never);
check('повтор того же message_id не задублировался', store.listMessages(conversation.id).length === 1);

await bot.handleUpdate(incoming(2, 'скриншот приложу') as never);
check('второе сообщение записано', store.listMessages(conversation.id).length === 2);

// grammY не должен пускать бизнес-апдейты в обычные обработчики — мина PTB.
const before = store.listMessages(conversation.id).length;
await bot.handleUpdate({
  update_id: 900,
  message: {
    message_id: 900,
    date: now,
    chat: { id: PEER, type: 'private' as const },
    from: { id: PEER, is_bot: false, first_name: 'Клиент' },
    text: '/start',
  },
} as never);
check('прямое сообщение боту не попало в диалог', store.listMessages(conversation.id).length === before);

// Вложение обязано попасть в тот же кадр, что и сообщение: панель получает
// событие синхронно, и раньше картинка регистрировалась строкой позже —
// в интерфейс уезжал пустой пузырь без признаков файла.
let frameAttachments: Record<number, unknown[]> = {};
store.on('message', ({ message }) => {
  frameAttachments = store.attachmentsFor([message.id]) as Record<number, unknown[]>;
});
await bot.handleUpdate({
  update_id: 500,
  business_message: {
    message_id: 77, date: now,
    chat: { id: PEER, type: 'private' as const, first_name: 'Клиент' },
    from: { id: PEER, is_bot: false, first_name: 'Клиент' },
    business_connection_id: CONNECTION,
    caption: 'вот что выходит',
    photo: [{ file_id: 'photo-abc', file_unique_id: 'u1', width: 100, height: 100 }],
  },
} as never);
const photoMessage = store.listMessages(conversation.id).at(-1)!;
check('фото записано как сообщение', photoMessage.media_type === 'photo');
check('вложение есть уже в момент события', (frameAttachments[photoMessage.id] ?? []).length === 1, frameAttachments);
check('файл привязан к сообщению', store.pendingAttachments().some((a) => a.file_ref === 'tg:photo-abc'));

// Размеры нужны, чтобы панель зарезервировала место под картинку: без них
// каждая догрузившаяся фотография толкает переписку вниз.
const photoAttachment = store.attachmentsFor([photoMessage.id])[photoMessage.id]?.[0];
check('ширина картинки сохранена', photoAttachment?.width === 100, photoAttachment);
check('высота картинки сохранена', photoAttachment?.height === 100, photoAttachment);

// Ответ на конкретное сообщение: без цитаты «Да» и «Вот что выходит»
// повисают в воздухе — непонятно, к чему они относятся.
await bot.handleUpdate({
  update_id: 600,
  business_message: {
    message_id: 88, date: now,
    chat: { id: PEER, type: 'private' as const, first_name: 'Клиент' },
    from: { id: PEER, is_bot: false, first_name: 'Клиент' },
    business_connection_id: CONNECTION,
    text: 'Да',
    reply_to_message: {
      message_id: 42, date: now,
      chat: { id: PEER, type: 'private' as const },
      text: 'Получилось?',
    },
  },
} as never);
const replyMessage = store.listMessages(conversation.id).at(-1)!;
check('ответ привязан к исходному сообщению', replyMessage.reply_to_external_id === '42');
check('текст цитаты сохранён', replyMessage.reply_excerpt === 'Получилось?');

// Выделенный фрагмент важнее целого сообщения: клиент цитирует часть.
await bot.handleUpdate({
  update_id: 601,
  business_message: {
    message_id: 89, date: now,
    chat: { id: PEER, type: 'private' as const, first_name: 'Клиент' },
    from: { id: PEER, is_bot: false, first_name: 'Клиент' },
    business_connection_id: CONNECTION,
    text: 'вот это не понял',
    quote: { text: 'проверьте синхронизацию времени', position: 0 },
    reply_to_message: {
      message_id: 43, date: now,
      chat: { id: PEER, type: 'private' as const },
      text: 'Обновите список серверов и проверьте синхронизацию времени на устройстве',
    },
  },
} as never);
check('выделенный фрагмент важнее целого сообщения',
  store.listMessages(conversation.id).at(-1)!.reply_excerpt === 'проверьте синхронизацию времени');

const fresh = store.getConversation(conversation.id)!;
check('окно ответа открыто', replyWindow(fresh).open);

const stale = { ...fresh, last_inbound_at: Date.now() - REPLY_WINDOW_MS - 60_000 };
check('окно закрывается через 24 часа', !replyWindow(stale).open);

// Outbox без зарегистрированного отправителя обязан падать явно, а не молча.
const outbox = new Outbox(store);
let refusedWithoutSender = false;
try {
  await outbox.send(conversation.id, { text: 'ответ' });
} catch (err) {
  refusedWithoutSender = (err as Error).name === 'NoSenderError';
}
check('outbox отказывает без отправителя', refusedWithoutSender);

// Отправитель-заглушка: проверяем запись исходящего и блокировку по окну.
outbox.register('tg_dm', { send: async () => ({ externalMsgId: '4242' }) });
const sent = await outbox.send(conversation.id, { text: 'Проверьте порт 443' });
check('исходящее записано в историю', sent!.message.direction === 'out' && sent!.message.author === 'agent');
check('непрочитанные сброшены после ответа', store.getConversation(conversation.id)!.unread === 0);

db.prepare('UPDATE conversation SET last_inbound_at = ? WHERE id = ?').run(
  Date.now() - REPLY_WINDOW_MS - 60_000,
  conversation.id,
);
let blocked = false;
try {
  await outbox.send(conversation.id, { text: 'поздно' });
} catch (err) {
  blocked = err instanceof WindowClosedError;
}
check('outbox блокирует отправку в закрытое окно', blocked);

db.close();
rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nВсе проверки прошли' : `\nПровалено проверок: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
