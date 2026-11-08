/**
 * Жизненный цикл диалога: закрытие, повторное открытие, скрытие, ответ мимо
 * панели. Проверяет, что SLA, очередь и предложки AI следуют за стадией
 * диалога, а не за первым циклом его жизни.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BOT_TOKEN = '123456:AAFakeForLifecycleTests';
process.env.PANEL_TOKEN = 'lifecycle-0123456789ab';
process.env.AI_MODE = 'off';
process.env.LOG_LEVEL = 'error';
const dir = mkdtempSync(join(tmpdir(), 'lifecycle-'));
process.env.DB_PATH = join(dir, 'l.db');

const { Store } = await import('../src/core/store.js');
const { openDatabase } = await import('../src/core/db.js');
const { SlaWatcher } = await import('../src/core/sla.js');
const { Operations } = await import('../src/core/operations.js');
type Notifier = import('../src/core/notify.js').Notifier;

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`  ok    ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`, detail ?? ''); }
};

const db = openDatabase();
const store = new Store(db);
const operations = new Operations(store);
const alerts: number[] = [];
const notifier = { notify: async (_kind: string, conversation: { id: number }) => { alerts.push(conversation.id); return true; } };
const sla = new SlaWatcher(store, notifier as unknown as Notifier);

const MIN = 60_000;
const HOUR = 60 * MIN;
let seq = 0;
const inbound = (externalId: string, at: number, text = 'вопрос') => store.recordInbound({
  channel: 'tg_bot', externalId, text, externalMsgId: `${externalId}-${++seq}`, sentAt: at,
})!;
/** Закрытие «в прошлом»: в проде между закрытием и новым письмом проходит время. */
const closeAt = (id: number, at: number) => {
  store.setStatus(id, 'resolved');
  store.db.prepare('UPDATE conversation SET resolved_at = ?, last_resolved_at = ? WHERE id = ?').run(at, at, id);
};
const overdueIds = () => store.overdueConversations(24).map((c) => c.id);

console.log('\n[ SLA: повторное открытие ]');
{
  const now = Date.now();
  const first = inbound('reopen', now - 5 * HOUR).conversation;
  store.recordOutbound({ conversationId: first.id, author: 'agent', text: 'ответ', sentAt: now - 4.5 * HOUR });
  closeAt(first.id, now - 4 * HOUR);
  inbound('reopen', now - 2 * HOUR, 'снова не работает');
  check('повторно открытый и неотвеченный диалог просрочен по SLA', overdueIds().includes(first.id));
  store.recordOutbound({ conversationId: first.id, author: 'agent', text: 'смотрю' });
  check('после ответа во втором цикле SLA молчит', !overdueIds().includes(first.id));
}

console.log('\n[ SLA: уведомление на каждый эпизод ожидания ]');
{
  const now = Date.now();
  const c = inbound('episodes', now - 5 * HOUR).conversation;
  alerts.length = 0;
  await sla.check();
  check('первое ожидание — уведомление', alerts.includes(c.id), alerts);
  await sla.check();
  check('то же ожидание повторно не уведомляется', alerts.filter((id) => id === c.id).length === 1, alerts);
  store.recordOutbound({ conversationId: c.id, author: 'ai', text: 'передал специалисту' });
  // Передача «два часа назад» относительно момента первого уведомления
  // невозможна, поэтому сдвигаем отметку уведомления в прошлое.
  store.setState(`sla:alerted:${c.id}`, String(now - 3 * HOUR));
  store.db.prepare('UPDATE conversation SET handoff_at = ? WHERE id = ?').run(now - 2 * HOUR, c.id);
  alerts.length = 0;
  await sla.check();
  check('новая передача человеку после прошлого уведомления — снова уведомление', alerts.includes(c.id), alerts);
}

console.log('\n[ скрытый диалог ]');
{
  const now = Date.now();
  const c = inbound('hidden', now - 3 * HOUR).conversation;
  check('до скрытия диалог в SLA', overdueIds().includes(c.id));
  const waitingBefore = store.waitingCount();
  check('до скрытия диалог в очереди', operations.queue().some((row) => row['id'] === c.id));
  store.hideConversation(c.id);
  check('скрытый диалог не просрочен по SLA', !overdueIds().includes(c.id));
  check('скрытый диалог не считается ждущим', store.waitingCount() === waitingBefore - 1, [waitingBefore, store.waitingCount()]);
  check('скрытого диалога нет в очереди', !operations.queue().some((row) => row['id'] === c.id));
  inbound('hidden', Date.now(), 'я тут');
  check('новое входящее возвращает диалог в очередь', operations.queue().some((row) => row['id'] === c.id));
}

console.log('\n[ очередь: повторное открытие ]');
{
  const now = Date.now();
  const c = inbound('queue-old', now - 40 * 24 * HOUR).conversation;
  store.recordOutbound({ conversationId: c.id, author: 'agent', text: 'готово', sentAt: now - 40 * 24 * HOUR + MIN });
  closeAt(c.id, now - 39 * 24 * HOUR);
  store.db.prepare('UPDATE conversation SET created_at = ? WHERE id = ?').run(now - 40 * 24 * HOUR, c.id);
  inbound('queue-old', now - 5 * MIN, 'новый вопрос');
  const row = operations.queue().find((item) => item['id'] === c.id);
  check('свежий вопрос в старом диалоге не просрочен сразу', row?.['overdue'] === false, row);
  check('срок считается от нового вопроса', Number(row?.['due_at']) > now, row);
}

console.log('\n[ предложка AI устаревает ]');
{
  const c = inbound('sugg-reply', Date.now()).conversation;
  const s = store.createSuggestion({ conversationId: c.id, text: 'черновик' });
  store.recordOutbound({ conversationId: c.id, author: 'agent', text: 'ответил сам' });
  check('ответ оператора своими словами снимает предложку', store.getSuggestion(s.id)?.status === 'superseded', store.getSuggestion(s.id)?.status);

  const c2 = inbound('sugg-send', Date.now()).conversation;
  const s2 = store.createSuggestion({ conversationId: c2.id, text: 'черновик' });
  store.recordOutbound({ conversationId: c2.id, author: 'agent', text: 'черновик', suggestionId: s2.id });
  check('отправляемая предложка не снимается до решения маршрута', store.getSuggestion(s2.id)?.status === 'pending');

  const c3 = inbound('sugg-ai', Date.now()).conversation;
  const s3 = store.createSuggestion({ conversationId: c3.id, text: 'черновик' });
  store.recordOutbound({ conversationId: c3.id, author: 'ai', text: 'сейчас посмотрю' });
  check('ответ AI предложку не трогает (ею управляет responder)', store.getSuggestion(s3.id)?.status === 'pending');

  const c4 = inbound('sugg-close', Date.now()).conversation;
  const s4 = store.createSuggestion({ conversationId: c4.id, text: 'черновик' });
  store.setStatus(c4.id, 'resolved');
  check('закрытие диалога снимает предложку', store.getSuggestion(s4.id)?.status === 'superseded', store.getSuggestion(s4.id)?.status);

  const c5 = inbound('sugg-backfill', Date.now()).conversation;
  const s5 = store.createSuggestion({ conversationId: c5.id, text: 'черновик' });
  store.recordOutbound({ conversationId: c5.id, author: 'agent', text: 'старый ответ', sentAt: Date.now() - HOUR, backfill: true, externalMsgId: 'old-1' });
  check('импорт старой истории предложку не трогает', store.getSuggestion(s5.id)?.status === 'pending');

  const recorded = store.recordInbound({ channel: 'tg_dm', externalId: '7001', tgUserId: 7001, businessConnectionId: 'bc', text: 'вопрос', externalMsgId: 'bm-1', sentAt: Date.now() })!;
  const s6 = store.createSuggestion({ conversationId: recorded.conversation.id, messageId: recorded.message.id, text: 'черновик' });
  store.recordExternalOutbound({ channel: 'tg_dm', externalId: '7001', tgUserId: 7001, businessConnectionId: 'bc', text: 'ответ из Telegram', externalMsgId: 'bm-2', sentAt: Date.now() });
  check('ответ владельца из Telegram Business снимает предложку', store.getSuggestion(s6.id)?.status === 'superseded', store.getSuggestion(s6.id)?.status);

  const del = store.recordInbound({ channel: 'tg_dm', externalId: '7002', tgUserId: 7002, businessConnectionId: 'bc', text: 'первое', externalMsgId: 'dm-1', sentAt: Date.now() - MIN })!;
  const delQuestion = store.recordInbound({ channel: 'tg_dm', externalId: '7002', tgUserId: 7002, businessConnectionId: 'bc', text: 'вопрос', externalMsgId: 'dm-2', sentAt: Date.now() })!;
  const s7 = store.createSuggestion({ conversationId: del.conversation.id, messageId: delQuestion.message.id, text: 'черновик' });
  store.deleteExternalMessages(del.conversation.id, ['dm-2']);
  check('клиент удалил вопрос — предложка к нему снята', store.getSuggestion(s7.id)?.status === 'superseded', store.getSuggestion(s7.id)?.status);
}

console.log('\n[ удержание диалога оператором ]');
{
  const c = inbound('claim', Date.now()).conversation;
  const first = operations.authenticate(operations.createOperator('Первый', 'agent').token)!;
  const second = operations.authenticate(operations.createOperator('Второй', 'agent').token)!;
  check('первый оператор взял диалог', operations.claim(c.id, first).ok);
  check('второй не может перехватить живой диалог', !operations.claim(c.id, second).ok);
  store.setStatus(c.id, 'resolved');
  check('после закрытия в карточке нет владельца', operations.collaboration(c.id)['owner'] === null, operations.collaboration(c.id));
  inbound('claim', Date.now(), 'ещё вопрос');
  check('вернувшегося клиента может взять другой оператор', operations.claim(c.id, second).ok);
}

console.log('\n[ миграция: передача в закрытых диалогах ]');
{
  const path = join(dir, 'migrate.db');
  const legacy = openDatabase(path);
  const version = Number(legacy.pragma('user_version', { simple: true }));
  check('миграция 025 есть в схеме', version >= 25, version);
  const insert = legacy.prepare(`INSERT INTO conversation (channel, external_id, status, handoff_at, created_at, updated_at)
                                  VALUES ('tg_bot', ?, ?, ?, ?, ?)`);
  const now = Date.now();
  const closedId = Number(insert.run('m-closed', 'resolved', now - HOUR, now, now).lastInsertRowid);
  const openId = Number(insert.run('m-open', 'open', now - HOUR, now, now).lastInsertRowid);
  const stale = Number(legacy.prepare(`INSERT INTO ai_suggestion (conversation_id, text, created_at) VALUES (?, 'черновик', ?)`)
    .run(closedId, now).lastInsertRowid);
  const live = Number(legacy.prepare(`INSERT INTO ai_suggestion (conversation_id, text, created_at) VALUES (?, 'черновик', ?)`)
    .run(openId, now).lastInsertRowid);
  legacy.pragma('user_version = 24');
  legacy.close();
  const migrated = openDatabase(path);
  const handoff = (id: number) => (migrated.prepare('SELECT handoff_at FROM conversation WHERE id = ?').get(id) as { handoff_at: number | null }).handoff_at;
  check('старая передача в закрытом диалоге снята', handoff(closedId) === null);
  check('передача в открытом диалоге сохранена', handoff(openId) === now - HOUR);
  const suggestionStatus = (id: number) => (migrated.prepare('SELECT status FROM ai_suggestion WHERE id = ?').get(id) as { status: string }).status;
  check('предложка закрытого диалога снята', suggestionStatus(stale) === 'superseded');
  check('предложка открытого диалога осталась', suggestionStatus(live) === 'pending');
  check('версия схемы восстановлена', Number(migrated.pragma('user_version', { simple: true })) === version);
  migrated.close();
}

// Эскалация и заметки (найдено охотой на баги, 2026-11-09).
{
  const esc = store.upsertConversation({ channel:'tg_dm', externalId:'esc-1', tgUserId: 99001, businessConnectionId:'b1' });
  store.recordInbound({ channel:'tg_dm', externalId:'esc-1', text:'вы издеваетесь', externalMsgId:'e1', sentAt: Date.now() - 5000 });
  store.setEscalated(esc.id, true);
  store.setStatus(esc.id, 'resolved');
  check('закрытие снимает эскалацию по тону', store.getConversation(esc.id)!.escalated === 0);
  store.recordInbound({ channel:'tg_dm', externalId:'esc-1', text:'новый вопрос', externalMsgId:'e2', sentAt: Date.now() - 2000 });
  store.addNote(esc.id, 'внутренняя заметка');
  check('заметка оператора не считается ответом клиенту', store.pendingInbound(esc.id).some((m) => m.text === 'новый вопрос'));
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAIL` : '\nвсе проверки жизненного цикла прошли');
process.exit(failures ? 1 : 0);
