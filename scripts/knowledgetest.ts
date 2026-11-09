/**
 * «Знания» в новой панели (план редизайна, этап 5, 10.5): «Новая статья» —
 * черновик, версия статьи и 409 при чужой правке с именем из журнала,
 * прежний текст в ответах для «Отменить», публикация закрывает идею,
 * решение по идее до публикации и 409 с тем, кто решил, причина отклонения,
 * идея из «Это неверно» без неверного ответа, права ролей.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BOT_TOKEN = '123456:AAFakeForKnowledgeTests';
process.env.PANEL_TOKEN = 'knowledge-0123456789abcdef';
process.env.AI_MODE = 'suggest';
process.env.AI_API_KEY = 'test-key-not-used';
process.env.LOG_LEVEL = 'error';
process.env.PANEL_PORT = '8193';
const dir = mkdtempSync(join(tmpdir(), 'knowledge-'));
process.env.DB_PATH = join(dir, 'k.db');
process.env.MEDIA_DIR = join(dir, 'media');
process.env.KB_DIR = join(dir, 'kb');
process.env.DRAFT_DIR = join(dir, 'draft');
mkdirSync(join(dir, 'kb')); mkdirSync(join(dir, 'draft'));

const { Store } = await import('../src/core/store.js');
const { openDatabase } = await import('../src/core/db.js');
const { Outbox } = await import('../src/core/outbox.js');
const { Operations } = await import('../src/core/operations.js');
const { startWeb } = await import('../src/panel/server.js');
const { permissionFor } = await import('../src/panel/permissions.js');
const { excerptOf } = await import('../src/panel/kbfiles.js');
type KbDocResponse = import('../src/shared/api-types.js').KbDocResponse;
type KbWriteResponse = import('../src/shared/api-types.js').KbWriteResponse;
type KbConflict = import('../src/shared/api-types.js').KbConflict;
type KbListResponse = import('../src/shared/api-types.js').KbListResponse;
type IdeaDecided = import('../src/shared/api-types.js').IdeaDecided;
type IdeasResponse = import('../src/shared/api-types.js').IdeasResponse;

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
const B = 'http://127.0.0.1:8193';
const root = process.env.PANEL_TOKEN!;
const lead = operations.createOperator('Мария', 'lead').token;
const lead2 = operations.createOperator('Пётр', 'lead').token;
const agent = operations.createOperator('Иван', 'agent').token;
const viewer = operations.createOperator('Наблюдатель', 'viewer').token;
const call = (method: string, path: string, body?: unknown, token = root) => fetch(`${B}${path}`, {
  method,
  headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const json = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;
const kbFile = (name: string): string => join(dir, 'kb', name);
const draftFile = (name: string): string => join(dir, 'draft', name);

try {
  console.log('«Новая статья» — черновик (10.5 п.1)');
  let response = await call('POST', '/api/kb', { title: 'Подключение iOS', text: 'Установите приложение.', draft: true }, lead);
  const created = await json<KbWriteResponse & { draft: boolean }>(response);
  check('ответ 200 с именем, версией и previous=null', response.status === 200 && created.name === 'podklyuchenie-ios.md'
    && /^[0-9a-f]{16}$/.test(created.version) && created.previous === null && created.draft === true, created);
  check('файл лёг в черновики, а не в базу', existsSync(draftFile(created.name)) && !existsSync(kbFile(created.name)));
  const second = await json<KbWriteResponse>(await call('POST', '/api/kb', { title: 'Подключение iOS', text: 'Другой текст.', draft: true }, lead));
  check('то же название — новое имя, чужой черновик не перезаписан', second.name === 'podklyuchenie-ios-2.md'
    && readFileSync(draftFile(created.name), 'utf8').includes('Установите'), second);
  response = await call('POST', '/api/kb', { title: 'Классика', text: 'Сразу в базу.' });
  check('без draft — по-старому, сразу опубликована (классика)', response.status === 200 && existsSync(kbFile('klassika.md')));

  console.log('Версия и чужая правка (10.5 п.5)');
  const doc = await json<KbDocResponse>(await call('GET', `/api/kb/draft/${created.name}`, undefined, lead));
  check('GET отдаёт version и changed_at', doc.version === created.version && doc.changed_at > 0, doc);
  response = await call('PUT', `/api/kb/draft/${created.name}`, { text: '# Подключение iOS\n\nШаг 1.\n', expectedVersion: doc.version }, lead);
  const saved = await json<KbWriteResponse>(response);
  check('PUT с верной версией — 200, previous = прежний текст', response.status === 200 && saved.previous === doc.text && saved.version !== doc.version, saved);
  response = await call('PUT', `/api/kb/draft/${created.name}`, { text: '# Подключение iOS\n\nМоё.\n', expectedVersion: doc.version }, lead2);
  const conflict = await json<KbConflict>(response);
  check('PUT со старой версией — 409 version_conflict', response.status === 409 && conflict.code === 'version_conflict', conflict);
  check('409 несёт текущий текст, версию и время', conflict.text === '# Подключение iOS\n\nШаг 1.\n' && conflict.version === saved.version && Number(conflict.changed_at) > 0);
  check('409 называет того, кто правил (журнал действий)', conflict.changed_by === 'Мария', conflict.changed_by);
  check('чужой текст не записан', readFileSync(draftFile(created.name), 'utf8').includes('Шаг 1.'));
  // Файл правили на диске позже последней записи журнала — имени нет.
  writeFileSync(draftFile(created.name), '# Подключение iOS\n\nС диска.\n');
  const later = (Date.now() + 60_000) / 1000;
  utimesSync(draftFile(created.name), later, later);
  const disk = await json<KbConflict>(await call('PUT', `/api/kb/draft/${created.name}`, { text: 'x', expectedVersion: saved.version }, lead2));
  check('правка с диска — 409 без имени', disk.code === 'version_conflict' && disk.changed_by === null, disk);
  response = await call('PUT', `/api/kb/draft/${created.name}`, { text: '# Подключение iOS\n\nПоверх.\n' }, lead2);
  check('PUT без версии — молча перезаписывает (классика)', response.status === 200);
  response = await call('PUT', '/api/kb/draft/novaya.md', { text: '# Новая\n\nтекст\n', expectedVersion: null }, lead);
  check('expectedVersion=null: файла нет — запись проходит', response.status === 200);
  response = await call('PUT', '/api/kb/draft/novaya.md', { text: '# Новая\n\nдругое\n', expectedVersion: null }, lead2);
  check('expectedVersion=null: файл уже есть — 409', response.status === 409);

  console.log('Публикация: прежний текст и закрытие идеи (10.5 п.2–3)');
  writeFileSync(kbFile('oplata.md'), '# Оплата\n\nСтарый текст.\n');
  writeFileSync(draftFile('oplata.md'), '# Оплата\n\nНовый текст.\n');
  const [ideaForDraft] = operations.registerCandidates([{ title: 'Оплата', file: 'oplata.md' }], 'auto-learn');
  const draftDoc = await json<KbDocResponse>(await call('GET', '/api/kb/draft/oplata.md', undefined, lead));
  response = await call('POST', '/api/kb/publish/oplata.md', { expectedVersion: 'ffffffffffffffff' }, lead);
  check('публикация со старой версией черновика — 409', response.status === 409);
  response = await call('POST', '/api/kb/publish/oplata.md', { expectedVersion: draftDoc.version }, lead);
  const published = await json<KbWriteResponse>(response);
  check('публикация — 200, previous = прежний опубликованный', response.status === 200 && published.previous === '# Оплата\n\nСтарый текст.\n', published);
  check('черновик удалён, база обновлена', !existsSync(draftFile('oplata.md')) && readFileSync(kbFile('oplata.md'), 'utf8').includes('Новый'));
  check('связанная идея закрыта', published.closed_ideas?.includes(ideaForDraft!) === true && operations.candidate(ideaForDraft!)?.status === 'approved', published.closed_ideas);
  writeFileSync(draftFile('svezhaya.md'), '# Свежая\n\nтекст\n');
  const fresh = await json<KbWriteResponse>(await call('POST', '/api/kb/publish/svezhaya.md', {}, lead));
  check('новая статья: previous = null', fresh.previous === null, fresh);
  const list = await json<KbListResponse>(await call('GET', '/api/kb', undefined, lead));
  const listed = list.kb.find((item) => item.name === 'oplata.md');
  check('в списке есть начало текста без заголовка', listed?.excerpt === 'Новый текст.', listed);
  check('начало текста без служебного комментария', excerptOf('# Т\n\nТекст\n\n<!--\nчерновик, собран\n-->\n') === 'Текст');

  console.log('Удаление с версией');
  const kbDoc = await json<KbDocResponse>(await call('GET', '/api/kb/kb/svezhaya.md', undefined, lead));
  response = await call('DELETE', '/api/kb/kb/svezhaya.md', { expectedVersion: '0000000000000000' }, lead);
  check('DELETE со старой версией — 409, файл на месте', response.status === 409 && existsSync(kbFile('svezhaya.md')));
  response = await call('DELETE', '/api/kb/kb/svezhaya.md', { expectedVersion: kbDoc.version }, lead);
  check('DELETE с верной версией — 200 и previous', response.status === 200 && (await json<{ previous?: string }>(response)).previous === kbDoc.text);

  console.log('Идеи: решение до публикации (10.5 п.4, п.6)');
  writeFileSync(draftFile('idea-a.md'), '# Идея А\n\nтекст\n');
  const [ideaA] = operations.registerCandidates([{ title: 'Идея А', file: 'idea-a.md' }], 'auto-learn');
  const [first, late] = await Promise.all([
    call('POST', `/api/learning/candidates/${ideaA}`, { decision: 'approved' }, lead),
    call('POST', `/api/learning/candidates/${ideaA}`, { decision: 'approved' }, lead2),
  ]);
  const statuses = [first.status, late.status].sort();
  check('двое одновременно: один 200, другой 409', statuses[0] === 200 && statuses[1] === 409, statuses);
  const loser = await json<IdeaDecided>(first.status === 409 ? first : late);
  check('409 already_decided с решением и именем', loser.code === 'already_decided' && loser.decision === 'approved'
    && ['Мария', 'Пётр'].includes(String(loser.decided_by)), loser);
  check('статья опубликована один раз и черновик ушёл', existsSync(kbFile('idea-a.md')) && !existsSync(draftFile('idea-a.md')));
  const [ideaMissing] = operations.registerCandidates([{ title: 'Нет файла', file: 'net-fayla.md' }], 'archive');
  response = await call('POST', `/api/learning/candidates/${ideaMissing}`, { decision: 'approved' }, lead);
  check('публикация не удалась — 400 и идея снова ждёт', response.status === 400 && operations.candidate(ideaMissing!)?.status === 'pending');
  writeFileSync(draftFile('idea-b.md'), '# Идея Б\n\nтекст\n');
  const [ideaB] = operations.registerCandidates([{ title: 'Идея Б', file: 'idea-b.md' }], 'auto-learn');
  response = await call('POST', `/api/learning/candidates/${ideaB}`, { decision: 'rejected', reason: 'кривая' }, lead);
  check('неизвестная причина — 400', response.status === 400 && operations.candidate(ideaB!)?.status === 'pending');
  response = await call('POST', `/api/learning/candidates/${ideaB}`, { decision: 'rejected', reason: 'duplicate', discardDraft: true }, lead);
  const left = await json<IdeasResponse>(response);
  check('отклонение с причиной — 200, в очереди её нет', response.status === 200 && !left.candidates.some((row) => row.id === ideaB));
  const event = db.prepare(`SELECT payload FROM event WHERE kind = 'kb_candidate_decided' ORDER BY id DESC LIMIT 1`).get() as { payload: string };
  check('причина хранится с решением', JSON.parse(event.payload).reason === 'duplicate', event);
  check('discardDraft убрал черновик отклонённой идеи', !existsSync(draftFile('idea-b.md')));
  writeFileSync(draftFile('idea-c.md'), '# Идея В\n\nтекст\n');
  const [ideaC] = operations.registerCandidates([{ title: 'Идея В', file: 'idea-c.md' }], 'auto-learn');
  await call('POST', `/api/learning/candidates/${ideaC}`, { decision: 'rejected' });
  check('классика: отклонение без причины оставляет черновик', existsSync(draftFile('idea-c.md')) && operations.candidate(ideaC!)?.status === 'rejected');

  console.log('Идея из «Это неверно»');
  const conv = store.recordInbound({ channel: 'tg_bot', externalId: 'k1', text: 'Как сменить карту для оплаты?', externalMsgId: 'k1-1', sentAt: Date.now(), tgUserId: 9001, displayName: 'Клиент' })!.conversation;
  const ai = store.recordOutbound({ conversationId: conv.id, author: 'ai', text: 'Неверный ответ помощника про карту.', sentAt: Date.now() });
  const aiId = Number((ai as { id?: number }).id ?? (db.prepare(`SELECT id FROM message WHERE author='ai' ORDER BY id DESC LIMIT 1`).get() as { id: number }).id);
  response = await call('POST', `/api/messages/${aiId}/feedback`, { verdict: 'wrong', reason: 'fact', correct: 'Откройте «Оплата» и нажмите «Сменить карту».' }, agent);
  const feedback = await json<{ ok: boolean; idea_id: number | null }>(response);
  check('ответ с id идеи', response.status === 200 && typeof feedback.idea_id === 'number', feedback);
  const idea = operations.candidate(Number(feedback.idea_id));
  check('идея ждёт проверки с источником feedback', idea?.status === 'pending' && idea?.source === 'feedback', idea);
  const ideaText = readFileSync(draftFile(String(idea?.file_name)), 'utf8');
  check('черновик идеи: вопрос клиента и как правильно', ideaText.startsWith('# Как сменить карту для оплаты?') && ideaText.includes('Сменить карту'), ideaText);
  check('неверный ответ помощника в черновик не попал', !ideaText.includes('Неверный ответ'));
  response = await call('POST', `/api/messages/${aiId}/feedback`, { verdict: 'wrong' }, agent);
  check('без «как правильно» идея не создаётся', response.status === 200 && !('idea_id' in await json<object>(response)));

  console.log('Права');
  check('агент: POST /api/kb — 403', (await call('POST', '/api/kb', { title: 'А', text: 'б', draft: true }, agent)).status === 403);
  check('агент: PUT — 403', (await call('PUT', '/api/kb/kb/oplata.md', { text: 'x' }, agent)).status === 403);
  check('агент: публикация — 403', (await call('POST', '/api/kb/publish/x.md', {}, agent)).status === 403);
  check('агент: решение по идее — 403', (await call('POST', `/api/learning/candidates/${ideaMissing}`, { decision: 'rejected' }, agent)).status === 403);
  check('агент: читает опубликованные', (await call('GET', '/api/kb/kb/oplata.md', undefined, agent)).status === 200);
  check('агент: черновик — 403', (await call('GET', `/api/kb/draft/${created.name}`, undefined, agent)).status === 403);
  check('наблюдатель: идеи — 403', (await call('GET', '/api/learning/candidates', undefined, viewer)).status === 403);
  check('наблюдатель: шаблоны правит — 403', (await call('POST', '/api/templates', { shortcut: 'x', title: 'x', body: 'x' }, viewer)).status === 403);
  check('карта: POST /api/kb → knowledge:manage', permissionFor('POST', '/api/kb') === 'knowledge:manage');
  check('карта: GET /api/kb/draft/x → knowledge:review', permissionFor('GET', '/api/kb/draft/x.md') === 'knowledge:review');
  check('карта: решение по идее → knowledge:review', permissionFor('POST', '/api/learning/candidates/1') === 'knowledge:review');
} finally {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} проверок не прошло`);
  process.exit(1);
}
console.log('\nknowledgetest: всё прошло');
