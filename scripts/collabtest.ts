/**
 * Этап 7 редизайна (10.6 п.5, 6, 8): черновики на сервере без миграции,
 * кадры presence / draft / handover_request только новой панели и только
 * нужным получателям, GET /api/presence, права новых маршрутов по ролям,
 * черновики не попадают в журнал действий.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENV_FILE = '/nonexistent/.env';
process.env.BOT_TOKEN = '123456:AAFakeForCollabTests';
process.env.PANEL_TOKEN = 'collab-0123456789abcdef';
process.env.AI_MODE = 'suggest';
process.env.AI_API_KEY = 'test-key-not-used';
process.env.LOG_LEVEL = 'error';
process.env.PANEL_PORT = '8187';
process.env.UPDATE_ENABLED = 'false';
const dir = mkdtempSync(join(tmpdir(), 'collab-'));
process.env.DB_PATH = join(dir, 'c.db');
process.env.MEDIA_DIR = join(dir, 'media');
process.env.KB_DIR = join(dir, 'kb');
process.env.DRAFT_DIR = join(dir, 'draft');
process.env.SOURCE_REQUEST_FILE = join(dir, 'source-request.json');
process.env.SOURCE_STATUS_FILE = join(dir, 'source-status.json');
mkdirSync(join(dir, 'kb')); mkdirSync(join(dir, 'draft'));

const { Store } = await import('../src/core/store.js');
const { openDatabase } = await import('../src/core/db.js');
const { Outbox } = await import('../src/core/outbox.js');
const { Operations } = await import('../src/core/operations.js');
const { OperatorDrafts, DRAFT_TTL_MS } = await import('../src/core/drafts.js');
const { startWeb } = await import('../src/panel/server.js');
const { permissionFor } = await import('../src/panel/permissions.js');
const WS = (await import('ws')).default;
type DraftResponse = import('../src/shared/api-types.js').DraftResponse;
type PresenceResponse = import('../src/shared/api-types.js').PresenceResponse;

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`  ok    ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`, detail ?? ''); }
};

const db = openDatabase();
const schemaBefore = Number(db.pragma('user_version', { simple: true }));
const store = new Store(db);
const operations = new Operations(store);
const outbox = new Outbox(store);
outbox.register('tg_bot', { async send() { return { externalMsgId: `out-${Math.random()}` }; } });
const app = await startWeb({ store, outbox });
const B = 'http://127.0.0.1:8187';
const root = process.env.PANEL_TOKEN!;
const ivan = operations.createOperator('Иван', 'agent');
const maria = operations.createOperator('Мария', 'agent');
const viewer = operations.createOperator('Наблюдатель', 'viewer').token;
const call = (method: string, path: string, body?: unknown, token = root) => fetch(`${B}${path}`, {
  method,
  headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const json = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

async function socket(token: string, v2 = true): Promise<{ frames: Array<Record<string, unknown>>; close: () => void }> {
  const { ticket } = await json<{ ticket: string }>(await call('GET', '/api/ticket', undefined, token));
  const ws = new WS(`ws://127.0.0.1:8187/ws?${v2 ? 'v=2&' : ''}token=${encodeURIComponent(ticket)}`);
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
  await new Promise((resolve) => ws.once('open', resolve));
  return { frames, close: () => ws.close() };
}
const wait = async (predicate: () => boolean): Promise<boolean> => {
  for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  return predicate();
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const of = (frames: Array<Record<string, unknown>>, kind: string) => frames.filter((frame) => frame.type === 'thread' && frame.kind === kind);

try {
  const conversation = store.recordInbound({ channel: 'tg_bot', externalId: 'c-1', displayName: 'Анна К.', text: 'Не подключается', externalMsgId: 'm-1', sentAt: Date.now() })!.conversation;
  const id = conversation.id;

  console.log('Черновики без миграции (7.8, откат образа)');
  check('версия схемы не изменилась — прежний образ стартует', Number(db.pragma('user_version', { simple: true })) === schemaBefore, schemaBefore);
  check('таблица operator_draft создана', Boolean(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operator_draft'`).get()));
  new OperatorDrafts(db);
  check('повторное создание не падает', true);

  console.log('Маршруты черновика');
  const ivanWs = await socket(ivan.token);
  const ivanWs2 = await socket(ivan.token);
  const mariaWs = await socket(maria.token);
  const classic = await socket(root, false);
  let response = await call('PUT', `/api/conversations/${id}/draft`, { text: 'Здравствуйте! Проверьте', mode: 'reply', quote: null, device: 'tab-a' }, ivan.token);
  const saved = await json<DraftResponse>(response);
  check('PUT сохраняет и отдаёт черновик', response.status === 200 && saved.draft?.text === 'Здравствуйте! Проверьте' && saved.draft.device === 'tab-a', saved);
  const got = await json<DraftResponse>(await call('GET', `/api/conversations/${id}/draft`, undefined, ivan.token));
  check('GET отдаёт свой черновик', got.draft?.text === 'Здравствуйте! Проверьте' && got.draft.updated_at === saved.draft?.updated_at, got);
  const other = await json<DraftResponse>(await call('GET', `/api/conversations/${id}/draft`, undefined, maria.token));
  check('у коллеги черновика нет — он на человека', other.draft === null, other);
  await wait(() => of(ivanWs2.frames, 'draft').length > 0);
  await settle();
  check('кадр draft — обоим сокетам того же человека', of(ivanWs.frames, 'draft').length === 1 && of(ivanWs2.frames, 'draft').length === 1);
  check('коллеге и классике кадр draft не уходит', of(mariaWs.frames, 'draft').length === 0 && classic.frames.every((frame) => frame.type !== 'thread'));
  response = await call('PUT', `/api/conversations/${id}/draft`, { text: 'Заметка', mode: 'note', quote: { id: 5, quote_id: 'q5', excerpt: 'Не подключается' }, from_suggestion: 3, device: 'tab-b' }, ivan.token);
  const note = await json<DraftResponse>(response);
  check('вкладка «Заметка», цитата и источник сохраняются', note.draft?.mode === 'note' && note.draft.quote?.quote_id === 'q5' && note.draft.from_suggestion === 3
    && (note.draft.updated_at ?? 0) > (saved.draft?.updated_at ?? 0), note);
  response = await call('PUT', `/api/conversations/${id}/draft`, { text: 'x'.repeat(10_001) }, ivan.token);
  check('слишком длинный — 400 bad_request', response.status === 400 && (await json<{ code: string }>(response)).code === 'bad_request');
  response = await call('PUT', `/api/conversations/${id}/draft`, { text: 'a', mode: 'html' }, ivan.token);
  check('неизвестная вкладка — 400', response.status === 400);
  response = await call('PUT', '/api/conversations/999999/draft', { text: 'a' }, ivan.token);
  check('нет диалога — 404 not_found', response.status === 404);
  response = await call('PUT', `/api/conversations/${id}/draft`, { text: '   ', mode: 'reply', quote: null }, ivan.token);
  check('пустой ответ без цитаты — то же, что удалить', (await json<DraftResponse>(response)).draft === null
    && (await json<DraftResponse>(await call('GET', `/api/conversations/${id}/draft`, undefined, ivan.token))).draft === null);
  await call('PUT', `/api/conversations/${id}/draft`, { text: 'Ещё раз' }, ivan.token);
  response = await call('DELETE', `/api/conversations/${id}/draft`, undefined, ivan.token);
  check('DELETE удаляет', response.status === 200 && (await json<DraftResponse>(await call('GET', `/api/conversations/${id}/draft`, undefined, ivan.token))).draft === null);
  await wait(() => of(ivanWs2.frames, 'draft').some((frame) => frame.draft === null));
  check('после удаления — кадр draft с null', of(ivanWs2.frames, 'draft').some((frame) => frame.draft === null));
  const drafts = new OperatorDrafts(db);
  drafts.put('op:999', id, { text: 'старый', mode: 'reply', quote: null, from_suggestion: null, device: '' }, Date.now() - DRAFT_TTL_MS - 1000);
  check('старше 30 дней не отдаётся', drafts.get('op:999', id) === null);
  check('и удаляется чисткой', drafts.prune() === 1);
  const audited = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE '%/draft'`).get() as { n: number };
  check('черновики не пишутся в журнал действий', audited.n === 0, audited);

  console.log('Права новых маршрутов (раздел 10)');
  check('draft и handover-request — conversation:reply', ['GET', 'PUT', 'DELETE'].every((method) => permissionFor(method, '/api/conversations/1/draft') === 'conversation:reply')
    && permissionFor('POST', '/api/conversations/1/handover-request') === 'conversation:reply');
  check('GET /api/presence — conversation:read', permissionFor('GET', '/api/presence') === 'conversation:read');
  response = await call('GET', `/api/conversations/${id}/draft`, undefined, viewer);
  check('наблюдателю черновик — 403 permission', response.status === 403 && (await json<{ code: string }>(response)).code === 'permission');
  response = await call('GET', '/api/presence', undefined, viewer);
  check('наблюдателю присутствие доступно', response.status === 200);

  console.log('Присутствие (10.6 п.6)');
  const before = of(ivanWs.frames, 'presence').length;
  await call('POST', `/api/conversations/${id}/presence`, { state: 'viewing' }, maria.token);
  await wait(() => of(ivanWs.frames, 'presence').length > before);
  const presence = of(ivanWs.frames, 'presence').at(-1) as { conversation_id: number; presence: Array<{ id: string; name: string; state: string }> } | undefined;
  check('кадр presence со списком: «Мария смотрит»', presence?.conversation_id === id && presence.presence.some((entry) => entry.name === 'Мария' && entry.state === 'viewing'), presence);
  const count = of(ivanWs.frames, 'presence').length;
  await call('POST', `/api/conversations/${id}/presence`, { state: 'viewing' }, maria.token);
  await settle();
  check('повторный heartbeat без изменений кадра не шлёт', of(ivanWs.frames, 'presence').length === count);
  await call('POST', `/api/conversations/${id}/engage`, { typing: true }, maria.token);
  await wait(() => of(ivanWs.frames, 'presence').length > count);
  check('печать — новый кадр «печатает»', (of(ivanWs.frames, 'presence').at(-1) as { presence: Array<{ state: string }> }).presence.some((entry) => entry.state === 'typing'));
  check('классике кадр presence не уходит', classic.frames.every((frame) => frame.type !== 'thread'));
  const all = await json<PresenceResponse>(await call('GET', '/api/presence', undefined, ivan.token));
  check('GET /api/presence — диалог с Марией', all.items.some((item) => item.conversation_id === id && item.presence.some((entry) => entry.name === 'Мария')), all);

  console.log('«Попросить передать» (10.6 п.8)');
  response = await call('POST', `/api/conversations/${id}/handover-request`, {}, ivan.token);
  check('никто не ведёт — 409', response.status === 409);
  await call('POST', `/api/conversations/${id}/engage`, {}, maria.token);
  response = await call('POST', `/api/conversations/${id}/handover-request`, {}, ivan.token);
  check('просьба принята', response.status === 200, await response.clone().text());
  await wait(() => of(mariaWs.frames, 'handover_request').length > 0);
  const asked = of(mariaWs.frames, 'handover_request')[0] as { from: { name: string }; customer: string | null } | undefined;
  check('кадр тому, кто ведёт: от Ивана, клиент Анна К.', asked?.from.name === 'Иван' && asked.customer === 'Анна К.', asked);
  await settle();
  check('просящему и остальным кадр не уходит', of(ivanWs.frames, 'handover_request').length === 0);
  const noteRow = db.prepare(`SELECT text FROM message WHERE conversation_id = ? AND direction = 'note' ORDER BY id DESC LIMIT 1`).get(id) as { text: string } | undefined;
  check('в ленте заметка для команды', /Иван просит передать диалог/.test(noteRow?.text ?? ''), noteRow);
  response = await call('POST', `/api/conversations/${id}/handover-request`, {}, ivan.token);
  check('повтор в течение минуты не шлётся снова', (await json<{ repeated?: boolean }>(response)).repeated === true);
  response = await call('POST', `/api/conversations/${id}/handover-request`, {}, maria.token);
  check('у ведущего самому себе — 409', response.status === 409);
  response = await call('POST', `/api/conversations/${id}/handover-request`, {}, viewer);
  check('наблюдателю — 403', response.status === 403);
  check('в кадрах нет служебных полей', !/tg_user_id|sub_link|business_connection_id/.test(JSON.stringify([...ivanWs.frames, ...mariaWs.frames])));
  for (const s of [ivanWs, ivanWs2, mariaWs, classic]) s.close();
} finally {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nПровалено проверок: ${failures}`);
  process.exit(1);
}
console.log('\ncollabtest: все проверки прошли');
