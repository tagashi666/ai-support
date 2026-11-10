/**
 * Основа нового списка (план редизайна, этап 2): состояние внимания и ранг из
 * src/shared, GET /api/inbox, счётчики «Ждут вас» и «Ждут человека»,
 * AttentionWatcher, seq/epoch и догон GET /api/events, bootstrap, коды ошибок,
 * печать без закрепления, права новых маршрутов, форма ответов.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BOT_TOKEN = '123456:AAFakeForInboxTests';
process.env.PANEL_TOKEN = 'inbox-0123456789abcdef';
process.env.AI_MODE = 'suggest';
process.env.AI_API_KEY = 'test-key-not-used';
process.env.AI_HUMAN_HOLD_MINUTES = '30';
process.env.ALERT_CHAT_ID = '-1001234567890';
process.env.LOG_LEVEL = 'error';
process.env.PANEL_PORT = '8193';
const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
process.env.DB_PATH = join(dir, 'i.db');
process.env.MEDIA_DIR = join(dir, 'media');

const { Store } = await import('../src/core/store.js');
const { openDatabase } = await import('../src/core/db.js');
const { Outbox } = await import('../src/core/outbox.js');
const { Operations } = await import('../src/core/operations.js');
const { Notifier } = await import('../src/core/notify.js');
const { runtime } = await import('../src/core/settings.js');
const { startWeb } = await import('../src/panel/server.js');
const shared = await import('../src/shared/attention.js');
const order = await import('../src/shared/conversation-order.js');
const { openFactsRows, factsOf, attentionContext, countNeedsHuman } = await import('../src/core/attention.js');
const { listInbox, openProjections, materialize } = await import('../src/panel/inbox.js');
const { AttentionWatcher, EventLog } = await import('../src/panel/live.js');
type InboxItem = import('../src/shared/api-types.js').InboxItem;
type InboxResponse = import('../src/shared/api-types.js').InboxResponse;
type BootstrapResponse = import('../src/shared/api-types.js').BootstrapResponse;
type EventsResponse = import('../src/shared/api-types.js').EventsResponse;
type StoredFrame = import('../src/panel/live.js').StoredFrame;

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`  ok    ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`, detail ?? ''); }
};

const MIN = 60_000;
const db = openDatabase();
const store = new Store(db);
const operations = new Operations(store);
let seq = 0;
const inbound = (externalId: string, at: number, text = 'вопрос', channel: 'bedolaga' | 'tg_bot' | 'tg_dm' = 'bedolaga') =>
  store.recordInbound({
    channel, externalId, text, externalMsgId: `${externalId}-${++seq}`, sentAt: at,
    ...(channel === 'tg_dm' ? { tgUserId: 9000 + seq, businessConnectionId: 'bc' } : {}),
  })!;
const out = (conversationId: number, author: 'ai' | 'agent', at: number, text = 'ответ') =>
  store.recordOutbound({ conversationId, author, text, sentAt: at });

// ─── 1. Чистые функции ──────────────────────────────────────────────────
console.log('\n[ состояние внимания: чистые функции ]');
{
  const now = 10_000_000_000;
  const base: import('../src/shared/attention.js').AttentionFacts = {
    id: 1, status: 'open', priority: 'normal', escalated: false, aiMode: 'inherit', handoffAt: null,
    createdAt: now - 60 * MIN, lastMessageAt: now - MIN, resolvedAt: null, lastResolvedAt: null,
    inboundWaitingSince: now - MIN, lastOut: null, lastAgentOutAt: null, draft: null, holdUntil: null,
    windowClosesAt: null, slaMinutes: 60,
  };
  const at = (facts: Partial<typeof base>, mode: 'off' | 'shadow' | 'suggest' | 'auto' = 'auto') =>
    shared.computeAttention({ ...base, ...facts }, { now, globalAiMode: mode });
  check('«Отвечает сам», клиент ждёт меньше 3 мин — помощник ведёт', at({}).state === 'ai_handling'
    && at({}).reason.code === 'ai_replying');
  const silent = at({ inboundWaitingSince: now - 3 * MIN - 1 });
  check('помощник молчит дольше 3 мин — «Помощник не ответил»', silent.state === 'needs_human' && silent.reason.code === 'ai_silent', silent);
  check('режим «Подсказывает» — нужен человек', at({}, 'suggest').state === 'needs_human' && at({}, 'suggest').reason.code === 'waiting');
  check('общий «Выключен» гасит режим диалога', at({ aiMode: 'auto' }, 'off').ai.effective === 'off' && at({ aiMode: 'auto' }, 'off').state === 'needs_human');
  check('режим диалога сильнее общего', at({ aiMode: 'suggest' }, 'auto').state === 'needs_human');
  const handoff = at({ handoffAt: now - 5 * MIN, inboundWaitingSince: null, lastOut: { at: now - 5 * MIN, author: 'ai' } });
  check('передан человеку — ярус 0, причина handoff, ожидание с момента передачи', handoff.state === 'needs_human'
    && handoff.tier === 0 && handoff.reason.code === 'handoff' && handoff.waiting_since === now - 5 * MIN, handoff);
  check('ответ человека после передачи снимает передачу', !at({ handoffAt: now - 5 * MIN, lastAgentOutAt: now - 4 * MIN,
    inboundWaitingSince: null, lastOut: { at: now - 4 * MIN, author: 'agent' } }).handoff);
  check('черновик неуверенный — draft_unsure', at({ draft: { createdAt: now - 30_000, unsure: true } }).reason.code === 'draft_unsure');
  check('черновик уверенный — draft_ready', at({ draft: { createdAt: now - 30_000, unsure: false } }).reason.code === 'draft_ready');
  check('важное — ярус 0 и причина important', at({ escalated: true }).tier === 0 && at({ escalated: true }).reason.code === 'important');
  check('заявка высокой срочности — ярус 0, «Срочная заявка»', at({}, 'suggest').tier === 1
    && at({ priority: 'high' }, 'suggest').tier === 0 && at({ priority: 'high' }, 'suggest').reason.code === 'urgent');
  const overdue = at({ inboundWaitingSince: now - 61 * MIN }, 'suggest');
  check('срок вышел — sla_overdue, since = срок', overdue.reason.code === 'sla_overdue' && overdue.reason.since === now - MIN && overdue.sla?.overdue === true, overdue);
  check('срок скоро (меньше 25%) — sla_soon', at({ inboundWaitingSince: now - 50 * MIN }, 'suggest').reason.code === 'sla_soon');
  check('пауза после ответа человека — нужен человек, помощник на паузе', (() => {
    const a = at({ holdUntil: now + 10 * MIN, lastAgentOutAt: now - 20 * MIN });
    return a.state === 'needs_human' && a.ai.paused_reason === 'human_hold' && a.ai.resume_at === now + 10 * MIN;
  })());
  check('последним ответил помощник — помощник ведёт', at({ inboundWaitingSince: null, lastOut: { at: now - MIN, author: 'ai' } }).state === 'ai_handling');
  check('последним ответил человек — ждём клиента', at({ inboundWaitingSince: null, lastOut: { at: now - MIN, author: 'agent' } }).state === 'waiting_client');
  check('окно ответа закрыто — ждём клиента, «Ответить уже нельзя»', at({ windowClosesAt: now - 1 }, 'suggest').state === 'waiting_client'
    && at({ windowClosesAt: now - 1 }, 'suggest').reason.code === 'window_closed');
  check('решён — done', at({ status: 'resolved', resolvedAt: now - MIN }).state === 'done');
  check('секция: чужое живое закрепление — «Ведут коллеги», своё — «Ждут вас»',
    shared.sectionFor('needs_human', 'op:2', 'op:1') === 'colleagues' && shared.sectionFor('needs_human', 'op:1', 'op:1') === 'mine'
    && shared.sectionFor('needs_human', null, 'op:1') === 'mine' && shared.sectionFor('ai_handling', 'op:2', 'op:1') === 'ai');
  check('закрепление живёт 15 минут', shared.liveOwner('op:2', now - 14 * MIN, now) !== null && shared.liveOwner('op:2', now - 15 * MIN, now) === null);
  check('неизвестное состояние — в «Ждут вас» с причиной «Проверьте»', shared.unknownAttention(base, { now, globalAiMode: 'auto' }).reason.code === 'check');
  const r = order.rankOf({ id: 42, section: 'mine', tier: 1, waitingSince: 123, activityAt: 456, doneAt: 0 });
  const parsed = order.parseRank(r);
  check('ранг разбирается обратно', parsed?.section === 'mine' && parsed.id === 42 && parsed.tier === 1 && parsed.key === 123, r);
  check('ранг: при равном времени выше более новый id',
    order.rankOf({ id: 2, section: 'ai', tier: 0, waitingSince: null, activityAt: 5, doneAt: 0 })
      < order.rankOf({ id: 1, section: 'ai', tier: 0, waitingSince: null, activityAt: 5, doneAt: 0 }));
}

// ─── 2. Сервер ───────────────────────────────────────────────────────────
const app = await startWeb({ store, outbox: new Outbox(store) });
const B = 'http://127.0.0.1:8193';
const root = { authorization: `Bearer ${process.env.PANEL_TOKEN}` };
const ivanToken = operations.createOperator('Иван', 'agent').token;
const mariaToken = operations.createOperator('Мария', 'agent').token;
const viewerToken = operations.createOperator('Наблюдатель', 'viewer').token;
const ivan = operations.authenticate(ivanToken)!;
const maria = operations.authenticate(mariaToken)!;
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const getJson = async <T>(path: string, headers: Record<string, string>): Promise<T> =>
  await (await fetch(`${B}${path}`, { headers })).json() as T;

console.log('\n[ «Ждут человека» и «Ждут вас»: одно определение ]');
{
  const now = Date.now();
  const a = inbound('w-a', now - 10 * MIN).conversation;
  const b = inbound('w-b', now - 9 * MIN).conversation;
  const c = inbound('w-c', now - 8 * MIN).conversation;
  const hidden = inbound('w-hidden', now - 7 * MIN).conversation;
  const aiDone = inbound('w-ai', now - 6 * MIN).conversation;
  out(aiDone.id, 'ai', now - 5 * MIN);
  const agentDone = inbound('w-agent', now - 6 * MIN).conversation;
  out(agentDone.id, 'agent', now - 5 * MIN);
  operations.claim(c.id, maria);
  store.hideConversation(hidden.id);

  const stats = await getJson<{ totals: { waiting: number } }>('/api/stats', root);
  const forIvan = await getJson<InboxResponse>('/api/inbox', as(ivanToken));
  const forMaria = await getJson<InboxResponse>('/api/inbox', as(mariaToken));
  check('Store.waitingCount = 3', store.waitingCount() === 3, store.waitingCount());
  check('totals.waiting в /api/stats = 3', stats.totals.waiting === 3, stats.totals);
  check('counts.waiting = 3 для любого получателя', forIvan.counts.waiting === 3 && forMaria.counts.waiting === 3,
    [forIvan.counts, forMaria.counts]);
  check('у Ивана «Ждут вас» = 2, «Ведут коллеги» = 1', forIvan.counts.sections.mine === 2 && forIvan.counts.sections.colleagues === 1, forIvan.counts);
  check('у Марии «Ждут вас» = 3, «Ведут коллеги» = 0', forMaria.counts.sections.mine === 3 && forMaria.counts.sections.colleagues === 0, forMaria.counts);
  const waitingView = await getJson<InboxResponse>('/api/inbox?view=waiting', as(ivanToken));
  check('вид «Ждут вас» = секция mine: длина = counts.sections.mine', waitingView.items.length === 2
    && waitingView.items.every((item) => item.section === 'mine') && !waitingView.items.some((item) => item.id === c.id));
  check('скрытый не входит ни в одно число и не виден в списке',
    ![...forIvan.items, ...forMaria.items].some((item) => item.id === hidden.id));
  const bootstrap = await getJson<BootstrapResponse>('/api/bootstrap', as(ivanToken));
  check('bootstrap: «Ждут вас» = counts.sections.mine, «Ждут человека» = counts.waiting',
    bootstrap.counts.mine === 2 && bootstrap.counts.waiting === 3, bootstrap.counts);
  check('секции помощника и клиента посчитаны', forIvan.counts.sections.ai === 1 && forIvan.counts.sections.client === 1, forIvan.counts.sections);

  const notifier = new Notifier(store, {} as never);
  let text = '';
  (notifier as unknown as { deliver(html: string): Promise<boolean> }).deliver = async (html: string) => { text = html; return true; };
  await notifier.notify('handoff', a);
  check('строка уведомления — «Ждут человека: 3»', text.includes('Ждут человека: 3') && !text.includes('без ответа'), text);

  // Убираем набор, чтобы он не мешал сверке порядка ниже.
  for (const conversation of [a, b, c, aiDone, agentDone]) store.setStatus(conversation.id, 'resolved');
}

console.log('\n[ порядок /api/inbox = сортировка функцией из src/shared ]');
{
  const now = Date.now();
  const same = now - 20 * MIN;
  const ids: number[] = [];
  for (let i = 0; i < 24; i += 1) {
    // Равные времена у каждой пары, все сочетания флагов по кругу.
    const at = same + Math.floor(i / 2) * 1000;
    const conversation = inbound(`o-${i}`, at, `вопрос ${i}`, i % 5 === 0 ? 'tg_dm' : 'bedolaga').conversation;
    ids.push(conversation.id);
    if (i % 3 === 0) store.setEscalated(conversation.id, true, 'high');
    if (i % 4 === 1) store.setHandoff(conversation.id, at + 500);
    if (i % 6 === 2) out(conversation.id, 'ai', at + 100);
    if (i % 7 === 3) out(conversation.id, 'agent', at + 100);
    if (i % 5 === 4) store.setSuspicious(conversation.id, true);
    if (i % 8 === 5) store.createSuggestion({ conversationId: conversation.id, text: 'черновик', confidence: 0.4 });
    if (i % 9 === 6) store.setAiMode(conversation.id, 'auto');
    if (i % 10 === 7) operations.claim(conversation.id, maria);
  }
  store.hideConversation(ids[11]!);
  for (const i of [20, 21, 22, 23]) store.setStatus(ids[i]!, 'resolved');
  // Равное время решения у двух решённых.
  db.prepare('UPDATE conversation SET resolved_at = ? WHERE id IN (?, ?)').run(now - MIN, ids[20], ids[21]);

  for (const [name, token, key] of [['Иван', ivanToken, ivan.key], ['Мария', mariaToken, maria.key]] as const) {
    const open = await getJson<InboxResponse>('/api/inbox?view=open&limit=200', as(token));
    const expected = openFactsRows(db).map((row) => {
      const attention = shared.computeAttention(factsOf(row), attentionContext());
      const owner = shared.liveOwner(row.assignee, row.claimed_at, Date.now());
      const section = shared.sectionFor(attention.state, owner?.key ?? null, key);
      return order.rankOf({ id: row.id, section, tier: attention.tier, waitingSince: attention.waiting_since,
        activityAt: shared.activityAt({ lastMessageAt: row.last_message_at, createdAt: row.created_at }), doneAt: 0 });
    }).sort(order.compareRank);
    check(`${name}: порядок выдачи = ранги из src/shared`, JSON.stringify(open.items.map((item) => item.rank)) === JSON.stringify(expected),
      { got: open.items.map((item) => item.rank), expected });
    check(`${name}: ранг строки пересчитывается панелью из её же полей`, open.items.every((item) => item.rank === order.rankOf({
      id: item.id, section: shared.sectionFor(item.state, item.owner?.id ?? null, key), tier: item.tier,
      waitingSince: item.waiting_since, activityAt: item.activity_at, doneAt: 0 })));
    check(`${name}: скрытого нет`, !open.items.some((item) => item.id === ids[11]));

    // Страницы по 5: курсор — ранг последней строки.
    const pages: InboxItem[] = [];
    let cursor: string | null = null;
    do {
      const page: InboxResponse = await getJson<InboxResponse>(`/api/inbox?view=open&limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, as(token));
      pages.push(...page.items);
      cursor = page.next;
    } while (cursor);
    check(`${name}: страницы склеиваются в тот же порядок`, JSON.stringify(pages.map((i) => i.id)) === JSON.stringify(open.items.map((i) => i.id)));
    const mine = await getJson<InboxResponse>('/api/inbox?section=mine&limit=200', as(token));
    check(`${name}: секция mine отдаётся отдельно и целиком`, mine.items.length === open.counts.sections.mine
      && mine.items.every((item) => item.section === 'mine'));
  }

  const resolved = await getJson<InboxResponse>('/api/inbox?view=resolved&limit=200', as(ivanToken));
  const sorted = [...resolved.items].sort((x, y) => order.compareRank(x.rank, y.rank));
  check('решённые: порядок SQL = сортировка рангом', resolved.items.length >= 4
    && JSON.stringify(resolved.items.map((i) => i.id)) === JSON.stringify(sorted.map((i) => i.id)), resolved.items.map((i) => i.rank));
  const r1 = await getJson<InboxResponse>('/api/inbox?view=resolved&limit=3', as(ivanToken));
  const r2 = await getJson<InboxResponse>(`/api/inbox?view=resolved&limit=200&cursor=${encodeURIComponent(r1.next ?? '')}`, as(ivanToken));
  check('решённые: курсор по времени решения и id без пропусков и повторов',
    JSON.stringify([...r1.items, ...r2.items].map((i) => i.id)) === JSON.stringify(resolved.items.map((i) => i.id)));
  const important = await getJson<InboxResponse>('/api/inbox?only=important&limit=200', as(ivanToken));
  check('фильтр «важные»', important.items.length > 0 && important.items.every((item) => item.flags.important));
  const notFound = await getJson<InboxResponse>('/api/inbox?only=not_found&limit=200', as(ivanToken));
  check('фильтр «нет в базе подписчиков»', notFound.items.length > 0 && notFound.items.every((item) => item.flags.not_found));
  const byMaria = await getJson<InboxResponse>(`/api/inbox?assignee=${maria.key}&limit=200`, as(ivanToken));
  check('фильтр по ответственному', byMaria.items.length > 0 && byMaria.items.every((item) => item.assignee?.id === maria.key));
  const q = await getJson<InboxResponse>('/api/inbox?q=o-1&limit=200', as(ivanToken));
  void q;
  const bad = await fetch(`${B}/api/inbox?view=everything`, { headers: as(ivanToken) });
  check('неизвестный вид — 400 с кодом bad_request', bad.status === 400 && (await bad.json() as { code?: string }).code === 'bad_request');
}

console.log('\n[ форма ответа (контракт api-types.ts) ]');
{
  const ITEM_KEYS = ['id', 'rank', 'section', 'state', 'tier', 'reason', 'waiting_since', 'sla', 'last', 'unread', 'owner',
    'assignee', 'ai', 'window', 'flags', 'priority', 'status', 'source', 'channel', 'folder_ids', 'customer', 'activity_at', 'updated_at'] as const;
  type Missing = Exclude<keyof InboxItem, (typeof ITEM_KEYS)[number]>;
  const exhaustive: [Missing] extends [never] ? true : never = true;
  void exhaustive;
  const page = await getJson<InboxResponse>('/api/inbox?limit=200', as(ivanToken));
  const item = page.items[0]!;
  check('ответ /api/inbox: items, next, counts, seq, epoch', ['items', 'next', 'counts', 'seq', 'epoch'].every((key) => key in page)
    && typeof page.seq === 'number' && typeof page.epoch === 'string');
  check('строка списка — ровно поля InboxItem', JSON.stringify(Object.keys(item).sort()) === JSON.stringify([...ITEM_KEYS].sort()), Object.keys(item));
  const raw = JSON.stringify(page);
  check('в список не попадают sub_link, tg_user_id, business_connection_id',
    !/sub_link|tg_user_id|business_connection_id|external_id/.test(raw));
  check('превью последнего сообщения ≤ 140 символов', page.items.every((row) => !row.last || row.last.text.length <= 140));
  check('у причины код и время', page.items.every((row) => typeof row.reason.code === 'string' && 'since' in row.reason));
  const tg = page.items.find((row) => row.source?.kind === 'telegram_business');
  check('окно ответа есть только у каналов с окном', page.items.every((row) => (row.window === null) === (row.source?.kind !== 'telegram_business'))
    && tg?.window?.open === true, tg?.window);
  const bootstrap = await getJson<BootstrapResponse>('/api/bootstrap', as(ivanToken));
  check('bootstrap: me, version, capabilities, assistant, counts, live', bootstrap.me.id === ivan.key && bootstrap.me.role === 'agent'
    && bootstrap.me.permissions.includes('conversation:reply') && typeof bootstrap.version === 'string'
    && bootstrap.capabilities.inbox && bootstrap.assistant.mode === runtime.aiMode
    && bootstrap.assistant.minConfidence === runtime.minConfidence && bootstrap.assistant.keys === true
    && typeof bootstrap.live.seq === 'number' && Array.isArray(bootstrap.folders), bootstrap);
  check('bootstrap: признак новой версии только при праве settings:update', bootstrap.update === null
    && (await getJson<BootstrapResponse>('/api/bootstrap', root)).update !== null);
  check('bootstrap: идеи на проверке — только при праве knowledge:review', bootstrap.counts.ideas === null);
}

console.log('\n[ права новых маршрутов ]');
{
  for (const path of ['/api/inbox', '/api/bootstrap', '/api/events?since=0&epoch=x']) {
    const agent = await fetch(`${B}${path}`, { headers: as(ivanToken) });
    const viewer = await fetch(`${B}${path}`, { headers: as(viewerToken) });
    const anonymous = await fetch(`${B}${path}`);
    check(`${path.split('?')[0]}: оператор и наблюдатель получают ответ, без ключа — 401 с кодом`,
      agent.status === 200 && viewer.status === 200 && anonymous.status === 401
      && (await anonymous.json() as { code?: string }).code === 'unauthorized', [agent.status, viewer.status, anonymous.status]);
  }
  const forbidden = await fetch(`${B}/api/roles`, { headers: as(ivanToken) });
  check('403 несёт код permission', forbidden.status === 403 && (await forbidden.json() as { code?: string }).code === 'permission');
}

console.log('\n[ печать без закрепления и коды ошибок ]');
{
  const conversation = inbound('typing', Date.now() - MIN).conversation;
  const typing = await fetch(`${B}/api/conversations/${conversation.id}/engage`, {
    method: 'POST', headers: { ...as(ivanToken), 'content-type': 'application/json' }, body: JSON.stringify({ typing: true }),
  });
  const typed = await typing.json() as { collaboration: { owner: unknown } };
  check('engage {typing} не закрепляет диалог', typing.status === 200 && typed.collaboration.owner === null
    && store.getConversation(conversation.id)?.claimed_at === null, typed);
  check('после печати помощник молчит 45 с', store.operatorIsActive(conversation.id));
  const take = await fetch(`${B}/api/conversations/${conversation.id}/engage`, {
    method: 'POST', headers: { ...as(mariaToken), 'content-type': 'application/json' }, body: '{}',
  });
  check('коллега может взять диалог после чужой печати', take.status === 200);
  const replyLocked = await fetch(`${B}/api/conversations/${conversation.id}/reply`, {
    method: 'POST', headers: { ...as(ivanToken), 'content-type': 'application/json' }, body: JSON.stringify({ text: 'привет' }),
  });
  const lockedBody = await replyLocked.json() as { code?: string; error?: string };
  check('ответ в чужой диалог — 409 locked_by_other, текст для классики остаётся', replyLocked.status === 409
    && lockedBody.code === 'locked_by_other' && typeof lockedBody.error === 'string', lockedBody);
  const release = await fetch(`${B}/api/conversations/${conversation.id}/release`, {
    method: 'POST', headers: { ...as(ivanToken), 'content-type': 'application/json' }, body: '{}',
  });
  check('освободить чужой — 409 locked_by_other', release.status === 409 && (await release.json() as { code?: string }).code === 'locked_by_other');
  const missing = await fetch(`${B}/api/conversations/999999/state`, {
    method: 'POST', headers: { ...as(ivanToken), 'content-type': 'application/json' }, body: JSON.stringify({ status: 'open' }),
  });
  check('нет диалога — 404 not_found', missing.status === 404 && (await missing.json() as { code?: string }).code === 'not_found');
  const noSender = await fetch(`${B}/api/conversations/${conversation.id}/reply`, {
    method: 'POST', headers: { ...as(mariaToken), 'content-type': 'application/json' }, body: JSON.stringify({ text: 'привет' }),
  });
  const noSenderBody = await noSender.json() as { code?: string };
  check('канал без отправителя — no_sender', noSender.status === 501 && noSenderBody.code === 'no_sender', [noSender.status, noSenderBody]);
}

console.log('\n[ AttentionWatcher: отправленная проекция = свежий расчёт ]');
{
  let clock = Date.now();
  const frames: StoredFrame[] = [];
  const watcher = new AttentionWatcher(db, (frame) => frames.push(frame), () => clock);
  const agree = (label: string): void => {
    const fresh = openProjections(db, clock);
    const mismatch = fresh.filter((item) => JSON.stringify(watcher.sentProjection(item.id)) !== JSON.stringify(item));
    check(`${label}: проекция совпадает для всех открытых`, mismatch.length === 0 && watcher.size === fresh.length,
      mismatch.map((item) => item.id));
    // Для двух получателей: того, кто ведёт, и другого — секция и ранг как в /api/inbox.
    for (const key of [maria.key, ivan.key]) {
      const listed = listInbox(db, { view: 'open', limit: 200 }, key, clock).items;
      const ok = listed.every((item) => {
        const sent = watcher.sentProjection(item.id);
        return sent && JSON.stringify(materialize(sent, key)) === JSON.stringify(item);
      });
      check(`${label}: секция и ранг для ${key === maria.key ? 'ведущей' : 'другого'} = /api/inbox`, ok);
    }
  };
  agree('старт');

  const auto = inbound('watch-auto', clock - 30_000).conversation;
  store.setAiMode(auto.id, 'auto');
  watcher.touch([auto.id]); watcher.flush();
  const first = frames.at(-1);
  check('новая строка — кадр inbox_item', first?.type === 'inbox_item' && first.item.id === auto.id && first.item.state === 'ai_handling', first);
  agree('после сообщения и смены режима диалога');

  const before = frames.length;
  watcher.step();
  check('шаг без изменений кадров не даёт', frames.length === before);

  clock += 3 * MIN;
  watcher.step();
  const silent = frames.filter((frame) => frame.type === 'inbox_item' && frame.item.id === auto.id).at(-1);
  check('через 3 мин шаг переводит в «Ждут вас» с причиной «Помощник не ответил»', silent?.type === 'inbox_item'
    && silent.item.state === 'needs_human' && silent.item.reason.code === 'ai_silent', silent);
  agree('после перехода по времени');

  operations.claim(auto.id, maria);
  watcher.touch([auto.id]); watcher.flush();
  agree('после закрепления');
  clock += 16 * MIN;
  watcher.step();
  agree('после конца закрепления');

  const previous = runtime.aiMode;
  runtime.aiMode = 'off';
  watcher.touch(); watcher.flush();
  agree('после смены режима везде (выключен)');
  runtime.aiMode = 'auto';
  watcher.touch(); watcher.flush();
  agree('после смены режима везде (отвечает сам)');
  runtime.aiMode = previous;
  watcher.touch(); watcher.flush();

  store.setStatus(auto.id, 'resolved');
  watcher.touch([auto.id]); watcher.flush();
  const done = frames.at(-1);
  check('решённый — последний кадр со state done', done?.type === 'inbox_item' && done.item.id === auto.id && done.item.state === 'done', done);
  const hidden = inbound('watch-hide', clock - MIN).conversation;
  watcher.touch([hidden.id]); watcher.flush();
  store.hideConversation(hidden.id);
  watcher.touch([hidden.id]); watcher.flush();
  check('скрытый — кадр inbox_remove', frames.at(-1)?.type === 'inbox_remove');
  agree('после решения и скрытия');
}

console.log('\n[ журнал кадров: seq, epoch, буфер ]');
{
  const log = new EventLog(3, 60_000, 'e1');
  for (let i = 0; i < 5; i += 1) log.push({ type: 'inbox_remove', id: i }, 1000);
  check('seq растёт на 1', log.seq === 5);
  check('догон в пределах буфера', log.since(3, 'e1', 1000)?.map((entry) => entry.seq).join(',') === '4,5');
  check('пропуск старше буфера — перечитать', log.since(1, 'e1', 1000) === null);
  check('другая эпоха — перечитать', log.since(4, 'e2', 1000) === null);
  check('seq из будущего — перечитать', log.since(9, 'e1', 1000) === null);
  check('кадры старше часа выбрасываются', log.since(4, 'e1', 1000 + 61_000) === null);
}

console.log('\n[ WebSocket ?v=2 и GET /api/events ]');
{
  const WS = (await import('ws')).default;
  const { ticket } = await getJson<{ ticket: string }>('/api/ticket', as(ivanToken));
  const v2 = new WS(`ws://127.0.0.1:8193/ws?v=2&token=${encodeURIComponent(ticket)}`);
  const classic = new WS(`ws://127.0.0.1:8193/ws?token=${encodeURIComponent(ticket)}`);
  const v2Frames: Array<Record<string, unknown>> = [];
  const classicFrames: Array<Record<string, unknown>> = [];
  v2.on('message', (raw) => v2Frames.push(JSON.parse(String(raw))));
  classic.on('message', (raw) => classicFrames.push(JSON.parse(String(raw))));
  await Promise.all([new Promise((r) => v2.once('open', r)), new Promise((r) => classic.once('open', r))]);
  const wait = async (predicate: () => boolean): Promise<boolean> => {
    for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 20));
    return predicate();
  };
  await wait(() => v2Frames.length > 0);
  const hello = v2Frames[0] as { type: string; seq: number; epoch: string };
  check('новый сокет получает hello с seq и epoch', hello?.type === 'hello' && typeof hello.seq === 'number' && typeof hello.epoch === 'string', hello);

  const fresh = inbound('ws-new', Date.now() - 10_000).conversation;
  await wait(() => v2Frames.some((frame) => frame.type === 'inbox_item'));
  const item = v2Frames.find((frame) => frame.type === 'inbox_item') as { seq: number; epoch: string; item: InboxItem } | undefined;
  check('новое сообщение — кадр inbox_item с seq = hello + 1', item?.item.id === fresh.id && item.seq === hello.seq + 1 && item.epoch === hello.epoch, item);
  check('секция и ранг посчитаны для получателя', item?.item.section === 'mine' && /^0\|/.test(item.item.rank));
  const live = item as { counts?: { waiting: number; sections: { mine: number } } } | undefined;
  const snapshot = await getJson<InboxResponse>('/api/inbox?limit=1', as(ivanToken));
  check('кадр несёт счётчики получателя = счётчики /api/inbox', live?.counts?.sections.mine === snapshot.counts.sections.mine
    && live.counts.waiting === snapshot.counts.waiting, [live?.counts, snapshot.counts]);
  await wait(() => classicFrames.some((frame) => frame.type === 'message'));
  check('классика получает свои кадры и не получает inbox_item', classicFrames.some((frame) => frame.type === 'message')
    && !classicFrames.some((frame) => frame.type === 'inbox_item'));
  check('новая панель не получает старые кадры с сырыми полями диалога', !v2Frames.some((frame) => frame.type === 'message'));

  const caught = await getJson<EventsResponse>(`/api/events?since=${hello.seq}&epoch=${hello.epoch}`, as(ivanToken));
  check('догон возвращает те же кадры', !caught.reset && caught.events.some((frame) => frame.type === 'inbox_item' && frame.seq === item?.seq)
    && caught.events.every((frame, index) => frame.seq === hello.seq + 1 + index), caught);
  check('догон несёт текущие счётчики', !caught.reset && caught.counts.waiting === (await getJson<InboxResponse>('/api/inbox?limit=1', as(ivanToken))).counts.waiting);
  const reset = await getJson<EventsResponse>(`/api/events?since=0&epoch=other`, as(ivanToken));
  check('чужая эпоха — reset', reset.reset === true && reset.epoch === hello.epoch);

  const settings = await fetch(`${B}/api/settings`, {
    method: 'POST', headers: { ...root, 'content-type': 'application/json' }, body: JSON.stringify({ aiMode: 'auto' }),
  });
  await wait(() => v2Frames.some((frame) => frame.type === 'settings'));
  const settingsFrame = v2Frames.find((frame) => frame.type === 'settings');
  check('смена режима везде — кадр settings', settings.status === 200 && settingsFrame?.aiMode === 'auto', settingsFrame);
  await wait(() => v2Frames.filter((frame) => frame.type === 'inbox_item' && (frame as { item: InboxItem }).item.id === fresh.id).length >= 2);
  const changed = v2Frames.filter((frame) => frame.type === 'inbox_item' && (frame as { item: InboxItem }).item.id === fresh.id).at(-1) as { item: InboxItem } | undefined;
  check('смена режима везде пересчитывает строки сразу', changed?.item.ai.effective === 'auto' && changed.item.state === 'ai_handling', changed?.item);
  const seqs = v2Frames.filter((frame) => typeof frame.seq === 'number' && frame.type !== 'hello' && frame.type !== 'tick').map((frame) => frame.seq as number);
  check('seq без пропусков', seqs.every((value, index) => index === 0 || value === seqs[index - 1]! + 1), seqs);
  await fetch(`${B}/api/settings`, { method: 'POST', headers: { ...root, 'content-type': 'application/json' }, body: JSON.stringify({ aiMode: 'suggest' }) });

  // --- Шаг 3: кадры по правам получателя (L-2…L-6, L-11) ---
  const listen = async (headers: Record<string, string>): Promise<{ frames: Array<Record<string, unknown>>; close(): void }> => {
    const { ticket: own } = await getJson<{ ticket: string }>('/api/ticket', headers);
    const socket = new WS(`ws://127.0.0.1:8193/ws?v=2&token=${encodeURIComponent(own)}`);
    const frames: Array<Record<string, unknown>> = [];
    socket.on('message', (raw) => frames.push(JSON.parse(String(raw))));
    await new Promise((r) => socket.once('open', r));
    await wait(() => frames.length > 0);
    return { frames, close: () => socket.close() };
  };
  const owner = await listen(root);
  const mariaWs = await listen(as(mariaToken));
  const send = (path: string, headers: Record<string, string>, body: unknown, method = 'POST') =>
    fetch(`${B}${path}`, { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const of = (frames: Array<Record<string, unknown>>, type: string) => frames.filter((frame) => frame.type === type);

  // L-5 + L-4: права роли agent изменились — сокетам Ивана и Марии кадр me; владельцу — нет.
  // roles/team: владелец получает invalidate, агент (без roles:manage и team:read) — noop.
  const agentRights = (await getJson<BootstrapResponse>('/api/bootstrap', as(ivanToken))).me.permissions;
  const roleSaved = await send('/api/roles/agent', root, { permissions: agentRights.filter((item) => item !== 'stats:read') }, 'PUT');
  await wait(() => of(v2Frames, 'me').length > 0 && of(owner.frames, 'invalidate').length >= 2);
  check('смена прав роли — кадр me её людям', roleSaved.status === 200 && of(v2Frames, 'me').length === 1 && of(mariaWs.frames, 'me').length === 1, [roleSaved.status, await roleSaved.clone().text()]);
  check('у кого права не менялись — без кадра me', of(owner.frames, 'me').length === 0);
  check('invalidate roles и team — тем, кто их читает', ['roles', 'team'].every((scope) => owner.frames.some((frame) => frame.type === 'invalidate' && frame.scope === scope)), owner.frames);
  check('без права на раздел — noop без scope', !v2Frames.some((frame) => frame.type === 'invalidate' && (frame.scope === 'roles' || frame.scope === 'team'))
    && of(v2Frames, 'noop').length >= 2 && of(v2Frames, 'noop').every((frame) => !('scope' in frame)), v2Frames.slice(-4));
  await send('/api/roles/agent', root, { permissions: agentRights }, 'PUT');
  await wait(() => of(v2Frames, 'me').length === 2);
  check('права вернули — снова кадр me', of(v2Frames, 'me').length === 2);

  // L-5: роль одного человека — кадр me только ему.
  const mariaMe = of(mariaWs.frames, 'me').length;
  const ivanMe = of(v2Frames, 'me').length;
  const roleChanged = await send(`/api/operators/${maria.id}`, root, { role: 'viewer' });
  await wait(() => of(mariaWs.frames, 'me').length > mariaMe);
  check('роль человека сменилась — кадр me ему, не соседу', roleChanged.status === 200 && of(mariaWs.frames, 'me').length === mariaMe + 1 && of(v2Frames, 'me').length === ivanMe, [roleChanged.status, mariaWs.frames.slice(-3)]);
  await send(`/api/operators/${maria.id}`, root, { role: 'agent' });

  // L-4: шаблоны — templates:read есть у агента: кадр со scope, без данных.
  const before = v2Frames.length;
  const template = await send('/api/templates', root, { shortcut: 'live-test', title: 'Кадр', body: 'текст' });
  await wait(() => v2Frames.slice(before).some((frame) => frame.type === 'invalidate'));
  const templateFrame = v2Frames.slice(before).find((frame) => frame.type === 'invalidate');
  check('invalidate templates — только scope, без содержимого', template.status === 200 && templateFrame?.scope === 'templates'
    && Object.keys(templateFrame).sort().join(',') === 'epoch,scope,seq,type', templateFrame);

  // L-6: любая настройка — кадр settings с её именем.
  const hold = await send('/api/settings', root, { humanHoldMinutes: 31 });
  await wait(() => owner.frames.some((frame) => frame.type === 'settings' && (frame.keys as string[] | undefined)?.includes('humanHoldMinutes')));
  check('humanHoldMinutes — кадр settings с keys', hold.status === 200
    && owner.frames.some((frame) => frame.type === 'settings' && (frame.keys as string[]).includes('humanHoldMinutes')));

  // L-2: намерение «Решено» коллегам сразу; без conversation:status — 403.
  const target = inbound('ws-intent', Date.now() - 5_000).conversation;
  const intent = await send(`/api/conversations/${target.id}/intent`, as(ivanToken), { action: 'resolve' });
  await wait(() => mariaWs.frames.some((frame) => frame.kind === 'intent'));
  const intentFrame = mariaWs.frames.find((frame) => frame.kind === 'intent') as { conversation_id: number; intent: { action: string; by: { name: string } } } | undefined;
  check('intent — коллеге кадр «Иван закрывает»', intent.status === 200 && intentFrame?.conversation_id === target.id
    && intentFrame.intent.action === 'resolve' && intentFrame.intent.by.name === 'Иван', intentFrame);
  await send(`/api/conversations/${target.id}/intent`, as(ivanToken), { action: null });
  await wait(() => mariaWs.frames.filter((frame) => frame.kind === 'intent').length === 2);
  check('отмена — кадр intent: null', (mariaWs.frames.filter((frame) => frame.kind === 'intent').at(-1) as { intent: unknown } | undefined)?.intent === null);
  check('intent без conversation:status — 403', (await send(`/api/conversations/${target.id}/intent`, as(viewerToken), { action: 'resolve' })).status === 403);

  // L-1 на сервере: клиент написал после `seen` — «Решено»/«Убрать» не применяются (409).
  const lastAt = Date.now() - 5_000;
  const conflict = await send(`/api/conversations/${target.id}/state`, as(ivanToken), { hidden: true, seen: lastAt - 60_000 });
  const conflictBody = await conflict.json() as { code?: string };
  check('seen старше сообщения клиента — 409 client_wrote', conflict.status === 409 && conflictBody.code === 'client_wrote', conflictBody);
  check('диалог не скрыт', store.getConversation(target.id)?.hidden_at == null);
  const agreed = await send(`/api/conversations/${target.id}/state`, as(ivanToken), { hidden: true, seen: lastAt + 1 });
  check('seen не старше — действие проходит', agreed.status === 200);
  await send(`/api/conversations/${target.id}/state`, as(ivanToken), { hidden: false });

  // L-11: «ушёл» снимает присутствие сразу кадром presence.
  await send(`/api/conversations/${target.id}/presence`, as(ivanToken), { state: 'viewing' });
  await wait(() => mariaWs.frames.some((frame) => frame.kind === 'presence' && (frame.presence as unknown[]).length === 1));
  await send(`/api/conversations/${target.id}/presence`, as(ivanToken), { state: 'left' });
  await wait(() => (mariaWs.frames.filter((frame) => frame.kind === 'presence').at(-1)?.presence as unknown[] | undefined)?.length === 0);
  check('presence left — кадр без ушедшего', (mariaWs.frames.filter((frame) => frame.kind === 'presence').at(-1)?.presence as unknown[] | undefined)?.length === 0);
  const seqsAll = v2Frames.filter((frame) => typeof frame.seq === 'number' && frame.type !== 'hello' && frame.type !== 'tick').map((frame) => frame.seq as number);
  check('seq без пропусков и с noop', seqsAll.every((value, index) => index === 0 || value === seqsAll[index - 1]! + 1), seqsAll);
  owner.close(); mariaWs.close();
  v2.close(); classic.close();
}

console.log('\n[ Кадры по правам: frameFor и неполадки ]');
{
  const { createLiveHub, frameFor } = await import('../src/panel/live.js');
  const none = { key: 'op:x', can: (permission: string) => permission === 'conversation:read' };
  const all = { key: 'root', can: () => true };
  const problem = { code: 'job_failed' as const, severity: 'warn' as const, count: 1, subject: 'auto-learn', at: 1 };
  const problemsFrame = { seq: 1, frame: { type: 'problems' as const, problems: [problem], at: 5 } };
  check('problems — с diagnostics:read список', JSON.stringify(frameFor(problemsFrame, 'e', all)) === JSON.stringify({ type: 'problems', seq: 1, epoch: 'e', problems: [problem], at: 5 }));
  check('problems без diagnostics:read — noop', JSON.stringify(frameFor(problemsFrame, 'e', none)) === JSON.stringify({ type: 'noop', seq: 1, epoch: 'e' }));
  const settingsEntry = (keys: string[]) => ({ seq: 2, frame: { type: 'settings' as const, aiMode: 'suggest' as const, minConfidence: 0.7, keys } });
  check('settings прочих ключей без settings:read — noop', frameFor(settingsEntry(['brand']), 'e', none).type === 'noop');
  const mixed = frameFor(settingsEntry(['brand', 'aiMode']), 'e', none) as { keys?: string[] };
  check('settings без settings:read — только общие ключи', mixed.keys?.join(',') === 'aiMode', mixed);
  check('settings с settings:read — все ключи', (frameFor(settingsEntry(['brand', 'aiMode']), 'e', all) as { keys?: string[] }).keys?.length === 2);
  check('invalidate ideas без knowledge:review — noop', frameFor({ seq: 3, frame: { type: 'invalidate', scope: 'ideas' } }, 'e', none).type === 'noop');

  const sent: Array<{ seq: number; frame: { type: string } }> = [];
  const hub = createLiveHub(db, (batch) => { sent.push(...batch); });
  hub.watcher.stop();
  hub.problems([]);
  hub.problems([]);
  hub.problems([problem]);
  hub.problems([problem]);
  hub.invalidate(['kb', 'ideas']);
  hub.invalidate(['kb']);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  check('неполадки: первый замер — точка отсчёта, кадр только при изменении', sent.filter((entry) => entry.frame.type === 'problems').length === 1, sent);
  check('invalidate в одном шаге склеивается по scope', sent.filter((entry) => entry.frame.type === 'invalidate').length === 2, sent);
}

console.log('\n[ 500 диалогов ]');
{
  const now = Date.now();
  const insert = db.transaction(() => {
    for (let i = 0; i < 500; i += 1) {
      const conversation = inbound(`load-${i}`, now - (i % 90) * MIN, `сообщение ${i}`).conversation;
      if (i % 3 === 0) out(conversation.id, 'ai', now - (i % 90) * MIN + 1000);
    }
  });
  insert();
  listInbox(db, { view: 'open', limit: 50 }, ivan.key);
  const started = performance.now();
  const page = listInbox(db, { view: 'open', limit: 50 }, ivan.key);
  const ms = performance.now() - started;
  console.log(`        /api/inbox на ${page.counts.open} открытых: ${ms.toFixed(1)} мс`);
  check('список на 500+ диалогах считается быстро (цель локально < 100 мс)', ms < 400, ms);
  check('счётчики по всей базе, а не по странице', page.counts.open >= 500 && page.items.length === 50);
  check('countNeedsHuman = counts.waiting', countNeedsHuman(db) === page.counts.waiting);
}

await app.close();
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
