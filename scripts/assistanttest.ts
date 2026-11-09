/**
 * Помощник в новой панели (план редизайна, этап 4, 10.4): пауза везде
 * (гейт, состояние строк, маршруты, право setting:aiMode, кадр settings),
 * лента «Что делал помощник» и итоги, «Это неверно», карта прав.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BOT_TOKEN = '123456:AAFakeForAssistantTests';
process.env.PANEL_TOKEN = 'assistant-0123456789abcdef';
process.env.AI_MODE = 'auto';
process.env.AI_API_KEY = 'test-key-not-used';
process.env.LOG_LEVEL = 'error';
process.env.PANEL_PORT = '8195';
const dir = mkdtempSync(join(tmpdir(), 'assistant-'));
process.env.DB_PATH = join(dir, 'a.db');
process.env.MEDIA_DIR = join(dir, 'media');

const { Store } = await import('../src/core/store.js');
const { openDatabase } = await import('../src/core/db.js');
const { Outbox } = await import('../src/core/outbox.js');
const { Operations } = await import('../src/core/operations.js');
const { startWeb } = await import('../src/panel/server.js');
const { permissionFor } = await import('../src/panel/permissions.js');
const { decide } = await import('../src/ai/gate.js');
const { runtime } = await import('../src/core/settings.js');
const pause = await import('../src/core/pause.js');
const { computeAttention } = await import('../src/shared/attention.js');
const { reasonCode } = await import('../src/panel/assistant.js');
type ActivityResponse = import('../src/shared/api-types.js').ActivityResponse;
type BootstrapResponse = import('../src/shared/api-types.js').BootstrapResponse;
type EventsResponse = import('../src/shared/api-types.js').EventsResponse;
type AssistantPauseResponse = import('../src/shared/api-types.js').AssistantPauseResponse;

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`  ok    ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`, detail ?? ''); }
};

const db = openDatabase();
const store = new Store(db);
const operations = new Operations(store);
const outbox = new Outbox(store);
outbox.register('tg_bot', { async send() { return { externalMsgId: `out-${Math.random()}` }; } });
const app = await startWeb({ store, outbox });
const B = 'http://127.0.0.1:8195';
const root = process.env.PANEL_TOKEN!;
const agent = operations.createOperator('Иван', 'agent').token;
const viewer = operations.createOperator('Наблюдатель', 'viewer').token;
const headers = (token: string, json = false): Record<string, string> => ({
  authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}),
});
const get = (path: string, token = root) => fetch(`${B}${path}`, { headers: headers(token) });
const getJson = async <T>(path: string, token = root): Promise<T> => (await get(path, token)).json() as Promise<T>;
const post = (path: string, body: unknown, token = root) =>
  fetch(`${B}${path}`, { method: 'POST', headers: headers(token, true), body: JSON.stringify(body) });
const del = (path: string, token = root) => fetch(`${B}${path}`, { method: 'DELETE', headers: headers(token) });

let n = 0;
const inbound = (externalId: string, text: string, at = Date.now()) => store.recordInbound({
  channel: 'tg_bot', externalId, text, externalMsgId: `${externalId}-${++n}`, sentAt: at, tgUserId: 8000 + n, displayName: `Клиент ${n}`,
})!;

try {
  console.log('Пауза: гейт');
  const conv = inbound('p1', 'Как подключить на телефоне?').conversation;
  const auto = store.getConversation(conv.id)!;
  const draft = { reply: 'Скачайте приложение и добавьте подписку.', confidence: 0.95, needsHuman: false, clarify: false, used: [1] } as never;
  check('без паузы уверенный ответ уходит сам', decide(store, { ...auto, ai_mode: 'auto' }, 'Как подключить?', draft, 1).action === 'auto');
  pause.setPause(store, Date.now() + 60 * 60_000, { key: 'root', name: 'Владелец' });
  const paused = decide(store, { ...auto, ai_mode: 'auto' }, 'Как подключить?', draft, 1);
  check('на паузе — только черновик', paused.action === 'suggest' && paused.reason.includes('пауза помощника'), paused);
  check('на паузе «Наблюдает» остаётся теневым', decide(store, { ...auto, ai_mode: 'shadow' }, 'x', draft, 1).action === 'shadow');
  check('«Как бы ответил» (assumeAuto) паузу не учитывает',
    decide(store, { ...auto, ai_mode: 'auto' }, 'Как подключить?', draft, 1, { assumeAuto: true }).action === 'auto');
  check('пауза не меняет настроенный режим', runtime.aiMode === 'auto');
  pause.loadPause(store);
  check('пауза переживает перезапуск (читается из базы)', pause.isPaused());
  pause.setPause(store, Date.now() - 1, { key: 'root', name: 'Владелец' });
  check('истёкшая пауза считается снятой', !pause.isPaused());
  pause.clearPause(store);
  check('validPauseUntil: прошлое и дальше месяца — нет, null — да',
    pause.validPauseUntil(Date.now() - 1) === undefined && pause.validPauseUntil(Date.now() + 40 * 86_400_000) === undefined
      && pause.validPauseUntil(null) === null && pause.validPauseUntil('x') === undefined);

  console.log('Пауза: состояние строк');
  const facts = {
    id: 1, status: 'open', priority: 'normal', escalated: false, aiMode: 'inherit', handoffAt: null, createdAt: Date.now() - 60_000,
    lastMessageAt: Date.now() - 60_000, resolvedAt: null, lastResolvedAt: null, inboundWaitingSince: Date.now() - 60_000,
    lastOut: null, lastAgentOutAt: null, draft: null, holdUntil: null, windowClosesAt: null, slaMinutes: null,
  };
  const now = Date.now();
  const free = computeAttention(facts, { now, globalAiMode: 'auto' });
  const held = computeAttention(facts, { now, globalAiMode: 'auto', paused: { until: now + 3_600_000 } });
  check('без паузы ответа ждём от помощника', free.state === 'ai_handling');
  check('на паузе диалог ждёт человека, причина — пауза', held.state === 'needs_human' && held.ai.paused_reason === 'pause'
    && held.ai.resume_at === now + 3_600_000, held);
  check('выключенный помощник паузой не помечается',
    computeAttention(facts, { now, globalAiMode: 'off', paused: { until: null } }).ai.paused_reason === null);

  console.log('Пауза: маршруты и права');
  check('агент без setting:aiMode — 403', (await post('/api/assistant/pause', { until: null }, agent)).status === 403);
  check('наблюдатель — 403', (await post('/api/assistant/pause', { until: null }, viewer)).status === 403);
  check('без until — 400', (await post('/api/assistant/pause', {})).status === 400);
  check('until в прошлом — 400', (await post('/api/assistant/pause', { until: Date.now() - 1000 })).status === 400);
  const boot0 = await getJson<BootstrapResponse>('/api/bootstrap');
  const until = Date.now() + 2 * 60 * 60_000;
  const set = await post('/api/assistant/pause', { until });
  const setBody = await set.json() as AssistantPauseResponse;
  check('пауза на 2 часа ставится', set.status === 200 && setBody.pause?.until === until && setBody.pause.by?.id === 'root', setBody);
  const boot1 = await getJson<BootstrapResponse>('/api/bootstrap');
  check('bootstrap показывает паузу', boot1.assistant.pause?.until === until && boot1.assistant.mode === 'auto');
  const events = await getJson<EventsResponse>(`/api/events?since=${boot0.live.seq}&epoch=${encodeURIComponent(boot0.live.epoch)}`);
  const frame = !events.reset ? events.events.find((event) => event.type === 'settings') : undefined;
  check('кадр settings с паузой, ключом и автором (10.4 п.7)', frame?.type === 'settings' && frame.pause?.until === until
    && frame.keys?.includes('aiPause') === true && frame.actor?.id === 'root', frame);
  const forever = await (await post('/api/assistant/pause', { until: null })).json() as AssistantPauseResponse;
  check('«пока не включу» — until null', forever.pause !== null && forever.pause.until === null);
  check('агент не снимает паузу — 403', (await del('/api/assistant/pause', agent)).status === 403);
  const off = await del('/api/assistant/pause');
  check('снять паузу', off.status === 200 && (await off.json() as AssistantPauseResponse).pause === null && !pause.isPaused());
  check('bootstrap без паузы', (await getJson<BootstrapResponse>('/api/bootstrap')).assistant.pause === null);

  console.log('Лента «Что делал помощник»');
  const t0 = Date.now() - 10 * 60_000;
  const a = inbound('a1', 'Сколько устройств можно?', t0).conversation;
  const sAuto = store.createSuggestion({ conversationId: a.id, text: 'Можно подключить до трёх устройств.', confidence: 0.9 });
  store.logEvent('ai_draft', a.id, { suggestion: sAuto.id, action: 'auto', reason: 'уверенность 0.90', confidence: 0.9 });
  const aiMsg = store.recordOutbound({ conversationId: a.id, author: 'ai', text: 'Можно подключить до трёх устройств.', suggestionId: sAuto.id });
  store.decideSuggestion(sAuto.id, 'sent');
  const b = inbound('b1', 'Не работает', t0).conversation;
  const sLow = store.createSuggestion({ conversationId: b.id, text: 'Попробуйте другой сервер.', confidence: 0.4 });
  store.logEvent('ai_draft', b.id, { suggestion: sLow.id, action: 'suggest', reason: 'уверенность 0.40 ниже порога' });
  store.logEvent('ai_handoff', b.id, { reason: 'чувствительная тема' });
  const c = inbound('c1', 'Где ссылка?', t0).conversation;
  const sEdit = store.createSuggestion({ conversationId: c.id, text: 'Ссылка в личном кабинете.' });
  store.recordOutbound({ conversationId: c.id, author: 'agent', text: 'Ссылка в личном кабинете, раздел «Подписка».', suggestionId: sEdit.id });
  store.decideSuggestion(sEdit.id, 'edited');
  const d = inbound('d1', 'Верните деньги', t0).conversation;
  const sRej = store.createSuggestion({ conversationId: d.id, text: 'Возврат невозможен.' });
  store.decideSuggestion(sRej.id, 'rejected');
  store.logEvent('suggestion_rejected', d.id, { suggestion_id: sRej.id, reason: 'tone' });
  const sGone = store.createSuggestion({ conversationId: d.id, text: 'Устаревший черновик' });
  store.decideSuggestion(sGone.id, 'superseded');
  store.logEvent('ai_skip_old', d.id, { message: 1, minutes: 300 });

  const feed = await getJson<ActivityResponse>(`/api/assistant/activity?since=${t0 - 1000}`);
  const kinds = new Map(feed.items.map((item) => [item.id, item]));
  const auto1 = kinds.get(`s${sAuto.id}`);
  check('ответил сам — с сообщением для «Это неверно»', auto1?.kind === 'auto' && auto1.message_id === aiMsg?.message?.id, auto1);
  check('черновик с причиной «ниже порога»', kinds.get(`s${sLow.id}`)?.kind === 'draft' && kinds.get(`s${sLow.id}`)?.reason === 'low_confidence');
  check('черновик, вы правили', kinds.get(`s${sEdit.id}`)?.kind === 'draft_edited');
  check('черновик отклонён с причиной', kinds.get(`s${sRej.id}`)?.kind === 'draft_rejected' && kinds.get(`s${sRej.id}`)?.reject_reason === 'tone');
  check('заменённые черновики в ленту не попадают', !kinds.has(`s${sGone.id}`));
  const sOld = store.createSuggestion({ conversationId: a.id, text: 'Ответ, потом заменённый' });
  store.recordOutbound({ conversationId: a.id, author: 'ai', text: 'Ответ, потом заменённый', suggestionId: sOld.id });
  store.decideSuggestion(sOld.id, 'superseded');
  const again = await getJson<ActivityResponse>(`/api/assistant/activity?since=${t0 - 1000}`);
  check('отправленный помощником остаётся ответом, даже если черновик потом заменён',
    again.items.find((item) => item.id === `s${sOld.id}`)?.kind === 'auto');
  check('передал вам и пропустил старое — из журнала', feed.items.some((item) => item.kind === 'handoff' && item.reason === 'sensitive')
    && feed.items.some((item) => item.kind === 'skipped_old'));
  check('новые сверху', feed.items.every((item, i, all) => i === 0 || all[i - 1]!.at >= item.at));
  check('итоги за период', feed.totals.auto === 1 && feed.totals.draftsEdited === 1 && feed.totals.draftsRejected === 1
    && feed.totals.handoffs === 1 && feed.totals.drafts >= 3, feed.totals);
  check('имя клиента, без внутренних полей', typeof auto1?.name === 'string' && !('tg_user_id' in (auto1 ?? {})));
  const page1 = await getJson<ActivityResponse>(`/api/assistant/activity?since=${t0 - 1000}&limit=2`);
  check('страница: два и курсор', page1.items.length === 2 && page1.next !== null);
  const page2 = await getJson<ActivityResponse>(`/api/assistant/activity?since=${t0 - 1000}&limit=2&before=${page1.next}`);
  check('следующая страница старше', page2.items.every((item) => item.at < page1.next!));
  check('наблюдатель видит ленту (stats:read)', (await get(`/api/assistant/activity?since=${t0}`, viewer)).status === 200);
  check('limit вне границ — 400', (await get('/api/assistant/activity?limit=1000')).status === 400);
  check('since не число — 400', (await get('/api/assistant/activity?since=abc')).status === 400);

  console.log('«Это неверно»');
  const mid = aiMsg!.message!.id;
  check('наблюдатель — 403', (await post(`/api/messages/${mid}/feedback`, { verdict: 'wrong' }, viewer)).status === 403);
  check('неизвестная причина — 400', (await post(`/api/messages/${mid}/feedback`, { verdict: 'wrong', reason: 'x' }, agent)).status === 400);
  const clientMsg = inbound('a1', 'ещё вопрос').message.id;
  check('сообщение клиента — 400', (await post(`/api/messages/${clientMsg}/feedback`, { verdict: 'wrong' }, agent)).status === 400);
  check('нет сообщения — 404', (await post('/api/messages/999999/feedback', { verdict: 'wrong' }, agent)).status === 404);
  const marked = await post(`/api/messages/${mid}/feedback`, { verdict: 'wrong', reason: 'fact', note: 'устройств пять' }, agent);
  check('агент отмечает ответ помощника', marked.status === 200);
  const after = await getJson<ActivityResponse>(`/api/assistant/activity?since=${t0 - 1000}`);
  check('отметка видна в ленте', after.items.find((item) => item.id === `s${sAuto.id}`)?.wrong === true);

  console.log('Права и причины');
  check('пауза: settings:read на входе', permissionFor('POST', '/api/assistant/pause') === 'settings:read'
    && permissionFor('DELETE', '/api/assistant/pause') === 'settings:read');
  check('настройки помощника: settings:read', permissionFor('GET', '/api/assistant/settings') === 'settings:read');
  const own = await getJson<{ runtime: Record<string, unknown>; ai: { keys: number } }>('/api/assistant/settings', agent);
  check('настройки помощника — только ключи помощника', own.runtime['aiMode'] === 'auto' && own.ai.keys === 1
    && !('notifyLevel' in own.runtime) && Array.isArray(own.runtime['customerLinks']));
  check('лента: stats:read', permissionFor('GET', '/api/assistant/activity?since=1') === 'stats:read');
  check('«Это неверно»: conversation:reply', permissionFor('POST', '/api/messages/5/feedback') === 'conversation:reply');
  check('коды причин гейта', reasonCode('пауза помощника: только предложка') === 'pause'
    && reasonCode('модель сама просит человека') === 'asked_human' && reasonCode('ответ не опирается на базу знаний') === 'no_kb'
    && reasonCode('режим suggest') === 'mode' && reasonCode(null) === null);
} finally {
  pause.clearPause(store);
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
