/**
 * Рабочее место новой панели (план редизайна, этап 3а): GET /api/thread/:id
 * с явной проекцией, ранняя история и догон, события ленты, черновик и его
 * уровень, GET /api/suggestions/:id, повтор отправки с client_msg_id без
 * дубля, автор ответа в ленте и в кадре, кадры ленты сокета ?v=2,
 * «Вернуть в список», причина «Не подходит», переключатель интерфейса, права.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BOT_TOKEN = '123456:AAFakeForThreadTests';
process.env.PANEL_TOKEN = 'thread-0123456789abcdef';
process.env.AI_MODE = 'suggest';
process.env.AI_API_KEY = 'test-key-not-used';
process.env.LOG_LEVEL = 'error';
process.env.PANEL_PORT = '8196';
const dir = mkdtempSync(join(tmpdir(), 'thread-'));
process.env.DB_PATH = join(dir, 't.db');
process.env.MEDIA_DIR = join(dir, 'media');
// Своя «сборка» новой панели: переключатель интерфейса отправляет в неё, только если она есть.
mkdirSync(join(dir, 'web'));
writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html><title>next</title>');
process.env.PANEL_WEB_DIR = join(dir, 'web');

const { Store } = await import('../src/core/store.js');
const { openDatabase } = await import('../src/core/db.js');
const { Outbox } = await import('../src/core/outbox.js');
const { Operations } = await import('../src/core/operations.js');
const { startWeb } = await import('../src/panel/server.js');
const { permissionFor } = await import('../src/panel/permissions.js');
const { RepeatGuard } = await import('../src/panel/routes/replies.js');
type ThreadResponse = import('../src/shared/api-types.js').ThreadResponse;
type ThreadSuggestion = import('../src/shared/api-types.js').ThreadSuggestion;

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`  ok    ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`, detail ?? ''); }
};

const db = openDatabase();
const store = new Store(db);
const operations = new Operations(store);
const outbox = new Outbox(store);
let delivered = 0;
let slow: (() => void) | null = null;
outbox.register('tg_bot', {
  async send() {
    delivered += 1;
    if (slow) await new Promise<void>((resolve) => { slow = resolve; });
    return { externalMsgId: `out-${delivered}` };
  },
});
const app = await startWeb({ store, outbox });
const B = 'http://127.0.0.1:8196';
const ivan = operations.createOperator('Иван', 'agent').token;
const viewer = operations.createOperator('Наблюдатель', 'viewer').token;
const as = (token: string, json = false): Record<string, string> => ({
  authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}),
});
const getJson = async <T>(path: string, token = ivan): Promise<T> => (await fetch(`${B}${path}`, { headers: as(token) })).json() as Promise<T>;
const post = (path: string, body: unknown, token = ivan) =>
  fetch(`${B}${path}`, { method: 'POST', headers: as(token, true), body: JSON.stringify(body) });

let n = 0;
const inbound = (externalId: string, text: string, at = Date.now()) => store.recordInbound({
  channel: 'tg_bot', externalId, text, externalMsgId: `${externalId}-${++n}`, sentAt: at, tgUserId: 7000 + n,
})!;

try {
  console.log('\n[ GET /api/thread: проекция ]');
  const first = inbound('t-1', 'Не подключается');
  const conversationId = first.conversation.id;
  store.addAttachment(first.message.id, 'photo', 'file-ref-secret', { width: 640, height: 480 });
  store.recordOutbound({ conversationId, author: 'ai', text: 'Пришлите ошибку' });
  store.addNote(conversationId, 'Проверить подписку');
  store.createSuggestion({ conversationId, text: 'Удалите профиль и добавьте заново', confidence: 0.95, sources: ['Подключение iOS'] });
  const thread = await getJson<ThreadResponse>(`/api/thread/${conversationId}`);
  const raw = JSON.stringify(thread);
  check('ответ без служебных полей (tg_user_id, file_ref, media_file_id, sub_link)',
    !/tg_user_id|file_ref|media_file_id|sub_link|sender_tg_user_id|business_connection_id|local_path/.test(raw), raw.slice(0, 300));
  check('голоса: клиент, помощник, заметка', thread.messages.map((m) => m.voice).join(',') === 'client,assistant,note', thread.messages);
  check('вложение в проекции: тип, размер, состояние «скачивается»', thread.messages[0]?.attachments[0]?.kind === 'photo'
    && thread.messages[0].attachments[0].width === 640 && thread.messages[0].attachments[0].state === 'pending', thread.messages[0]);
  check('входящее Telegram можно цитировать (quote_id), исходящее — нет', Boolean(thread.messages[0]?.quote_id) && thread.messages[1]?.quote_id === null);
  check('шапка: строка списка для получателя; у бота окна 24 ч нет', thread.head.item.id === conversationId
    && /^[0-4]\|/.test(thread.head.item.rank) && !thread.head.window.applies, thread.head.window);
  const business = store.recordInbound({ channel: 'tg_dm', externalId: 'b-1', text: 'привет', externalMsgId: 'b-1-1', sentAt: Date.now() - 23 * 3600_000,
    tgUserId: 8001, businessConnectionId: 'bc' })!;
  const businessThread = await getJson<ThreadResponse>(`/api/thread/${business.conversation.id}`);
  check('у Business окно 24 ч: открыто, конец ≈ через час', businessThread.head.window.applies && businessThread.head.window.open
    && Math.abs((businessThread.head.window.closes_at ?? 0) - (Date.now() + 3600_000)) < 60_000, businessThread.head.window);
  check('черновик: уровень словами от порога, источники массивом', thread.suggestion?.level === 'check' || thread.suggestion?.level === 'sure', thread.suggestion);
  check('источники черновика', thread.suggestion?.sources[0] === 'Подключение iOS');
  check('канал с отправителем; файлы этот отправитель не умеет', thread.head.sender && !thread.head.attachments);

  console.log('\n[ история и догон ]');
  for (let i = 0; i < 205; i += 1) store.recordOutbound({ conversationId, author: 'ai', text: `сообщение ${i}`, sentAt: Date.now() + i });
  const page = await getJson<ThreadResponse>(`/api/thread/${conversationId}`);
  check('первая страница — 200 последних, has_more', page.messages.length === 200 && page.has_more);
  const earlier = await getJson<ThreadResponse>(`/api/thread/${conversationId}?before=${page.messages[0]!.id}`);
  check('before — ранние до первого, без черновика', earlier.messages.length > 0 && earlier.messages.at(-1)!.id < page.messages[0]!.id
    && earlier.suggestion === null);
  const lastId = page.messages.at(-1)!.id;
  inbound('t-1', 'ещё вопрос');
  const after = await getJson<ThreadResponse>(`/api/thread/${conversationId}?after=${lastId}`);
  check('after — только новые', after.messages.length === 1 && after.messages[0]!.text === 'ещё вопрос', after.messages);
  const bad = await fetch(`${B}/api/thread/${conversationId}?before=abc`, { headers: as(ivan) });
  check('некорректный параметр — 400 bad_request', bad.status === 400 && (await bad.json() as { code?: string }).code === 'bad_request');
  const missing = await fetch(`${B}/api/thread/999999`, { headers: as(ivan) });
  check('нет диалога — 404 not_found', missing.status === 404 && (await missing.json() as { code?: string }).code === 'not_found');

  console.log('\n[ события ленты ]');
  await post(`/api/conversations/${conversationId}/state`, { handoff: true });
  await post(`/api/conversations/${conversationId}/state`, { aiMode: 'off' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const withEvents = await getJson<ThreadResponse>(`/api/thread/${conversationId}?after=${lastId}`);
  const kinds = withEvents.events.map((event) => event.kind);
  check('«Взяли себе» и смена режима — события с автором', kinds.includes('took') && kinds.includes('mode')
    && withEvents.events.every((event) => event.actor?.name === 'Иван'), withEvents.events);

  console.log('\n[ отправка: client_msg_id и автор ]');
  const before = delivered;
  const body = { text: 'Здравствуйте!', clientMsgId: 'cm-abcdef12' };
  const [one, two] = await Promise.all([post(`/api/conversations/${conversationId}/reply`, body), post(`/api/conversations/${conversationId}/reply`, body)]);
  const oneBody = await one.json() as { thread?: { id: number; author?: { name: string } }; repeated?: boolean; client_msg_id?: string };
  const twoBody = await two.json() as { thread?: { id: number }; repeated?: boolean };
  check('два одинаковых запроса — одно сообщение клиенту', delivered - before === 1, delivered - before);
  check('повтор отдаёт то же сообщение с repeated', oneBody.thread?.id === twoBody.thread?.id && Boolean(oneBody.repeated || twoBody.repeated), [oneBody, twoBody]);
  check('ответ несёт проекцию с автором «Иван»', oneBody.thread?.author?.name === 'Иван' && oneBody.client_msg_id === 'cm-abcdef12', oneBody);
  const third = await post(`/api/conversations/${conversationId}/reply`, body);
  check('повтор позже — тоже без дубля', third.status === 200 && delivered - before === 1);
  const fresh = await getJson<ThreadResponse>(`/api/thread/${conversationId}?after=${lastId}`);
  check('в ленте автор ответа — имя из команды', fresh.messages.some((m) => m.voice === 'operator' && m.author?.name === 'Иван'), fresh.messages.at(-1));

  const guard = new RepeatGuard();
  let runs = 0;
  const failing = async () => { runs += 1; return { status: 502, body: { code: 'upstream' } }; };
  await guard.run('k', failing);
  await guard.run('k', failing);
  check('неудача ключ не занимает: «Повторить» отправляет снова', runs === 2);

  console.log('\n[ кадры ленты сокета ?v=2 ]');
  {
    const WS = (await import('ws')).default;
    const { ticket } = await getJson<{ ticket: string }>('/api/ticket');
    const socket = new WS(`ws://127.0.0.1:8196/ws?v=2&token=${encodeURIComponent(ticket)}`);
    const frames: Array<Record<string, unknown>> = [];
    socket.on('message', (rawFrame) => frames.push(JSON.parse(String(rawFrame))));
    await new Promise((resolve) => socket.once('open', resolve));
    const wait = async (predicate: () => boolean): Promise<boolean> => {
      for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      return predicate();
    };
    await post(`/api/conversations/${conversationId}/reply`, { text: 'Проверьте ещё раз', clientMsgId: 'cm-second01' });
    const got = await wait(() => frames.some((frame) => frame.type === 'thread' && frame.kind === 'message'));
    const frame = frames.find((item) => item.type === 'thread' && item.kind === 'message') as
      { conversation_id: number; message: { voice: string; author: { name: string } | null; text: string } } | undefined;
    check('кадр thread/message с проекцией и автором', got && frame?.conversation_id === conversationId
      && frame.message.voice === 'operator' && frame.message.author?.name === 'Иван', frame);
    check('в кадре ленты нет служебных полей', !/tg_user_id|file_ref|sub_link/.test(JSON.stringify(frames)));
    check('кадр ленты без seq: догон списка не ломается', frames.filter((item) => item.type === 'thread').every((item) => item.seq === undefined));
    store.createSuggestion({ conversationId, text: 'Новый черновик', confidence: 0.3 });
    await wait(() => frames.some((item) => item.type === 'thread' && item.kind === 'suggestion'));
    const suggestion = frames.find((item) => item.type === 'thread' && item.kind === 'suggestion') as { suggestion: ThreadSuggestion | null } | undefined;
    check('кадр черновика с уровнем «Не уверен»', suggestion?.suggestion?.level === 'unsure', suggestion);
    const byId = await getJson<{ suggestion: ThreadSuggestion }>(`/api/suggestions/${suggestion?.suggestion?.id ?? 0}`, viewer);
    check('GET /api/suggestions/:id доступен наблюдателю', byId.suggestion?.text === 'Новый черновик', byId);
    const reject = await post(`/api/suggestions/${byId.suggestion.id}/decide`, { status: 'rejected', reason: 'tone' });
    const logged = db.prepare(`SELECT payload FROM event WHERE kind = 'suggestion_rejected'`).get() as { payload: string } | undefined;
    check('«Не подходит» с причиной — в журнал событий', reject.status === 200 && /"tone"/.test(logged?.payload ?? ''), logged);
    await wait(() => frames.filter((item) => item.type === 'thread' && item.kind === 'suggestion').length >= 2);
    const cleared = frames.filter((item) => item.type === 'thread' && item.kind === 'suggestion').at(-1) as { suggestion: unknown } | undefined;
    check('после отклонения кадр черновика пустой', cleared?.suggestion === null, cleared);

    await post(`/api/conversations/${conversationId}/state`, { hidden: true });
    await wait(() => frames.some((item) => item.type === 'thread' && item.kind === 'deleted'));
    check('убрали из списка — кадр thread/deleted', frames.some((item) => item.type === 'thread' && item.kind === 'deleted'));
    const hidden = await getJson<ThreadResponse>(`/api/thread/${conversationId}`);
    check('убранный диалог открывается, шапка знает об этом', hidden.head.hidden === true);
    await post(`/api/conversations/${conversationId}/state`, { hidden: false });
    const back = store.getConversation(conversationId);
    check('«Вернуть в список»: hidden_at снят', back?.hidden_at === null);
    await wait(() => frames.some((item) => item.type === 'inbox_item' && (item.item as { id: number }).id === conversationId
      && frames.indexOf(item) > frames.findIndex((other) => other.kind === 'deleted')));
    check('после возврата строка снова приходит кадром inbox_item', frames.some((item, index) => item.type === 'inbox_item'
      && (item.item as { id: number }).id === conversationId && index > frames.findIndex((other) => other.kind === 'deleted')));
    socket.close();
  }

  console.log('\n[ права ]');
  check('GET /api/thread/:id — conversation:read', permissionFor('GET', '/api/thread/1') === 'conversation:read');
  check('GET /api/suggestions/:id — conversation:read, решение — conversation:reply',
    permissionFor('GET', '/api/suggestions/1') === 'conversation:read' && permissionFor('POST', '/api/suggestions/1/decide') === 'conversation:reply');
  const viewerThread = await fetch(`${B}/api/thread/${conversationId}`, { headers: as(viewer) });
  const viewerReply = await post(`/api/conversations/${conversationId}/reply`, { text: 'нельзя' }, viewer);
  check('наблюдатель читает диалог и не может ответить (403 permission)', viewerThread.status === 200 && viewerReply.status === 403
    && (await viewerReply.json() as { code?: string }).code === 'permission');
  const anonymous = await fetch(`${B}/api/thread/${conversationId}`);
  check('без ключа — 401', anonymous.status === 401);

  console.log('\n[ переключатель интерфейса ]');
  const toNext = await fetch(`${B}/?ui=next`, { redirect: 'manual' });
  check('?ui=next — cookie ui=next и переход в /next/', toNext.status === 302 && toNext.headers.get('location') === '/next/'
    && /ui=next/.test(toNext.headers.get('set-cookie') ?? ''), [toNext.status, toNext.headers.get('location')]);
  const saved = await fetch(`${B}/`, { redirect: 'manual', headers: { cookie: 'ui=next' } });
  check('сохранённый выбор отправляет с / в новую панель', saved.status === 302 && saved.headers.get('location') === '/next/');
  const classic = await fetch(`${B}/?ui=classic`, { redirect: 'manual', headers: { cookie: 'ui=next' } });
  check('?ui=classic — классика и cookie ui=classic', classic.status === 200 && /ui=classic/.test(classic.headers.get('set-cookie') ?? ''));
  const plain = await fetch(`${B}/`, { redirect: 'manual' });
  check('без выбора — классика как раньше', plain.status === 200);
  const back2 = await fetch(`${B}/next/chats?ui=classic`, { redirect: 'manual' });
  check('из новой панели ?ui=classic — в классику', back2.status === 302 && back2.headers.get('location') === '/?ui=classic');
} finally {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\nthreadtest: ${failures} провал(ов)`);
  process.exit(1);
}
console.log('\nthreadtest: всё зелёное');
