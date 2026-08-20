/** Доставка уведомлений: троттлинг, содержимое, поведение при отказе. */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BOT_TOKEN = '123456:AAFakeForNotifyTests';
process.env.PANEL_TOKEN = 'notify-0123456789abcd';
process.env.AI_MODE = 'off';
process.env.ALERT_CHAT_ID = '-1001234567890';
process.env.PANEL_URL = 'https://support.example.com';
process.env.LOG_LEVEL = 'error';
const dir = mkdtempSync(join(tmpdir(), 'notify-'));
process.env.DB_PATH = join(dir, 'n.db');

const { Notifier } = await import('../src/core/notify.js');
const { Store } = await import('../src/core/store.js');
const { openDatabase } = await import('../src/core/db.js');

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`  ok    ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`, detail ?? ''); }
};

const db = openDatabase();
const store = new Store(db);

// Подставной Telegram: ловим то, что бот реально отправил бы.
const sentMessages: Record<string, unknown>[] = [];
let failNext = false;
const tg = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (failNext) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }));
    }
    sentMessages.push(JSON.parse(raw || '{}'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: { message_id: sentMessages.length } }));
  });
});
await new Promise<void>((r) => tg.listen(0, '127.0.0.1', r));
const port = (tg.address() as { port: number }).port;

const { Bot } = await import('grammy');
const bot = new Bot(process.env.BOT_TOKEN!, {
  botInfo: {
    id: 1, is_bot: true, first_name: 'b', username: 'b', can_join_groups: false,
    can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: true, has_main_web_app: false, has_topics_enabled: false,
    allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
  },
  client: { apiRoot: `http://127.0.0.1:${port}` },
});

const notifier = new Notifier(store, bot);
const conversation = store.upsertConversation({
  channel: 'tg_dm', externalId: '555', tgUserId: 555, username: 'client', displayName: 'Клиент',
});

console.log('\n[ доставка ]');
check('нотификатор видит настроенный чат', notifier.configured);

const ok = await notifier.notify('new', store.getConversation(conversation.id)!, { excerpt: 'не подключается на айфоне' });
check('уведомление отправлено', ok && sentMessages.length === 1, sentMessages.length);

const text = String(sentMessages[0]?.['text'] ?? '');
check('в тексте заголовок события', text.includes('Новое обращение'), text);
check('в тексте кто написал', text.includes('Клиент'), text);
check('в тексте суть обращения', text.includes('не подключается'), text);
check('в тексте ссылка на диалог', text.includes(`https://support.example.com/#c${conversation.id}`), text);
check('ушло именно в ALERT_CHAT_ID', String(sentMessages[0]?.['chat_id']) === '-1001234567890');

console.log('\n[ троттлинг ]');
const repeat = await notifier.notify('new', store.getConversation(conversation.id)!, { excerpt: 'ещё раз' });
check('повтор того же события подавлен', !repeat && sentMessages.length === 1);

const other = await notifier.notify('escalated', store.getConversation(conversation.id)!, { reason: 'отмечен важным' });
check('другое событие проходит', other && sentMessages.length === 2);

console.log('\n[ передача человеку не подавляется ]');
// Клиенту в этот момент говорят «передал специалисту». Если уведомление
// проглотить троттлингом, обещание окажется ложью — так и случилось в проде.
const first = await notifier.notify('handoff', store.getConversation(conversation.id)!, { reason: 'первая передача' });
const second = await notifier.notify('handoff', store.getConversation(conversation.id)!, { reason: 'вторая передача подряд' });
check('первая передача доставлена', first);
check('вторая передача тоже доставлена', second, 'троттлинг не должен её съесть');
check('обе видны в чате', sentMessages.filter((m) => String(m['text']).includes('специалиста')).length === 2);

console.log('\n[ уровень подробности ]');
{
  const { runtime } = await import('../src/core/settings.js');
  const before = sentMessages.length;

  runtime.notifyLevel = 'all';
  await notifier.notify('message', store.getConversation(conversation.id)!, { excerpt: 'ещё вопрос' });
  await notifier.notify('ai_reply', store.getConversation(conversation.id)!, { excerpt: 'ответ AI' });
  check('на уровне «всё» идут и сообщения, и ответы AI', sentMessages.length === before + 2, sentMessages.length - before);

  // Поток переписки не подавляется троттлингом — иначе разговор рвётся.
  const flood = sentMessages.length;
  for (let i = 0; i < 3; i += 1) {
    await notifier.notify('message', store.getConversation(conversation.id)!, { excerpt: `сообщение ${i}` });
  }
  check('подряд идущие сообщения не подавляются', sentMessages.length === flood + 3, sentMessages.length - flood);

  runtime.notifyLevel = 'important';
  const quiet = sentMessages.length;
  await notifier.notify('message', store.getConversation(conversation.id)!, { excerpt: 'тихо' });
  await notifier.notify('ai_reply', store.getConversation(conversation.id)!, { excerpt: 'тихо' });
  check('на уровне «важное» поток переписки молчит', sentMessages.length === quiet);
  await notifier.notify('handoff', store.getConversation(conversation.id)!, { reason: 'важное' });
  check('передача человеку проходит на любом уровне', sentMessages.length === quiet + 1);

  runtime.notifyLevel = 'minimal';
  const min = sentMessages.length;
  await notifier.notify('new', store.getConversation(conversation.id)!, { excerpt: 'новое' });
  check('на минимуме даже новое обращение молчит', sentMessages.length === min);
  await notifier.notify('sla', store.getConversation(conversation.id)!, { reason: 'ждёт' });
  check('просрочка проходит на минимуме', sentMessages.length === min + 1);

  runtime.notifyLevel = 'all';
}

console.log('\n[ длинные сообщения ]');
failNext = false;
// Отдельный диалог: событие sla троттлится на шесть часов, и в общем
// диалоге окно уже израсходовано предыдущим блоком.
const longConv = store.upsertConversation({ channel: 'tg_dm', externalId: '777', tgUserId: 777, displayName: 'Длинный' });
// Обращение на несколько тысяч символов не должно ронять уведомление:
// Telegram отбивает всё сообщение целиком, если оно длиннее 4096.
const longBefore = sentMessages.length;
const huge = await notifier.notify('sla', store.getConversation(longConv.id)!, { excerpt: 'я'.repeat(9000) });
check('длинное обращение не ломает доставку', huge);
const hugeText = String(sentMessages.at(-1)?.['text'] ?? '');
check('текст обрезан до лимита Telegram', hugeText.length <= 4096, hugeText.length);
check('уведомление всё-таки ушло', sentMessages.length === longBefore + 1);

console.log('\n[ отказ доставки ]');
failNext = true;
const failed = await notifier.notify('aggressive', store.getConversation(conversation.id)!, { excerpt: 'ругань', tone: 'агрессивный' });
check('отказ возвращает false', !failed);
check('причина отказа сохранена', (notifier.lastError ?? '').includes('chat not found'), notifier.lastError);
check('состояние показывает ошибку', notifier.state().lastError !== null);

failNext = false;
const retryAfterFailure = await notifier.notify('aggressive', store.getConversation(conversation.id)!, {
  excerpt: 'повтор после восстановления', tone: 'агрессивный',
});
check('после отказа важное уведомление можно повторить', retryAfterFailure);
const test = await notifier.test();
check('проверочное уведомление доходит', test.ok);
check('после успеха ошибка сброшена', notifier.state().lastError === null);

tg.close();
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
