/**
 * Этап 6 редизайна (6.8–6.11, 10.6): неполадки в bootstrap и /api/system/problems,
 * подключения без секретов и без Telegram, уведомления, имена команды для
 * всех, GET /api/nodes по settings:read, owner_live в очереди сроков,
 * права новых маршрутов по ролям; изоляция локальной панели (devseed).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENV_FILE = '/nonexistent/.env';
process.env.BOT_TOKEN = '123456:AAFakeForSystemTests';
process.env.PANEL_TOKEN = 'system-0123456789abcdef';
process.env.AI_MODE = 'suggest';
process.env.AI_API_KEY = 'test-key-not-used';
process.env.LOG_LEVEL = 'error';
process.env.PANEL_PORT = '8188';
process.env.UPDATE_ENABLED = 'false';
const dir = mkdtempSync(join(tmpdir(), 'system-'));
process.env.DB_PATH = join(dir, 's.db');
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
const { startWeb } = await import('../src/panel/server.js');
const { permissionFor } = await import('../src/panel/permissions.js');
const { systemProblems } = await import('../src/panel/problems.js');
const { configEnvNames } = await import('./devseed.js');
const { fakeNodes } = await import('./devfakes.js');
type BootstrapResponse = import('../src/shared/api-types.js').BootstrapResponse;
type ProblemsResponse = import('../src/shared/api-types.js').ProblemsResponse;
type ConnectionsResponse = import('../src/shared/api-types.js').ConnectionsResponse;
type TeamNamesResponse = import('../src/shared/api-types.js').TeamNamesResponse;

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
const nodes = fakeNodes(Date.now());
let telegramCalls = 0;
const bot = { api: { getBusinessConnection: async () => { telegramCalls += 1; throw new Error('сеть недоступна'); } } };
const app = await startWeb({ store, outbox, nodes: nodes as never, bot: bot as never });
const B = 'http://127.0.0.1:8188';
const root = process.env.PANEL_TOKEN!;
const agentOp = operations.createOperator('Иван', 'agent');
const agent = agentOp.token;
const viewer = operations.createOperator('Наблюдатель', 'viewer').token;
const lead = operations.createOperator('Мария', 'lead').token;
const call = (method: string, path: string, body?: unknown, token = root) => fetch(`${B}${path}`, {
  method,
  headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const json = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

try {
  console.log('Неполадки (6.1, 6.9)');
  const problems = systemProblems({ nodes: nodes as never, operations, store });
  check('сервер не отвечает — error с именем, выключенный не считается', problems.length === 1 && problems[0]!.code === 'nodes_offline'
    && problems[0]!.count === 1 && problems[0]!.subject === 'Франкфурт-2' && problems[0]!.severity === 'error', problems);
  store.db.prepare(`INSERT INTO job (kind, status, error, started_at, ended_at) VALUES ('mine', 'failed', 'x', ?, ?)`).run(Date.now() - 1000, Date.now());
  operations.recordUpdate('update', '9.9.9', 'failed', operations.rootActor());
  const more = systemProblems({ nodes: nodes as never, operations, store });
  check('сбой задачи и обновления — warn, после error', more.map((p) => p.code).join() === 'nodes_offline,update_failed,job_failed', more);
  let response = await call('GET', '/api/system/problems');
  const listed = await json<ProblemsResponse>(response);
  check('GET /api/system/problems — тот же список', response.status === 200 && listed.problems.length === 3 && typeof listed.checkedAt === 'number', listed);
  check('агенту /api/system/problems — 403', (await call('GET', '/api/system/problems', undefined, agent)).status === 403);
  const boot = await json<BootstrapResponse>(await call('GET', '/api/bootstrap'));
  check('bootstrap: counts.problems и список у администратора', boot.counts.problems === 3 && boot.problems?.length === 3, boot.counts);
  const bootAgent = await json<BootstrapResponse>(await call('GET', '/api/bootstrap', undefined, agent));
  check('bootstrap агента: problems null', bootAgent.counts.problems === null && bootAgent.problems === null, bootAgent.counts);

  console.log('Подключения и уведомления (6.11, 6.9)');
  store.syncSource({ id: 'telegram-x', kind: 'telegram_bot', name: 'Поддержка', enabled: true });
  telegramCalls = 0;
  response = await call('GET', '/api/connections');
  const connections = await json<ConnectionsResponse>(response);
  check('GET /api/connections — источники, без запроса в Telegram', response.status === 200
    && connections.sources.some((s) => s.id === 'telegram-x') && telegramCalls === 0, { connections, telegramCalls });
  check('в ответе нет ключей и токенов', !/token|secret|BOT_TOKEN|AAFake/i.test(JSON.stringify(connections)));
  check('наблюдателю подключения видны (settings:read)', (await call('GET', '/api/connections', undefined, viewer)).status === 200);
  check('агенту — как /api/settings (settings:read)', (await call('GET', '/api/connections', undefined, agent)).status
    === (operations.can(operations.authenticate(agent)!, 'settings:read') ? 200 : 403));
  const notifications = await json<{ configured: boolean; level: string }>(await call('GET', '/api/system/notifications'));
  check('уведомления: не настроены, уровень по умолчанию', notifications.configured === false && ['all', 'important', 'minimal'].includes(notifications.level), notifications);

  console.log('Имена команды (10.6 п.4)');
  response = await call('GET', '/api/team/names', undefined, agent);
  const names = await json<TeamNamesResponse>(response);
  check('агент видит имена команды', response.status === 200 && names.people.some((p) => p.name === 'Мария') && names.people[0]!.id === 'root', names);
  check('без ролей-прав и ключей', !JSON.stringify(names).includes('permissions') && !JSON.stringify(names).includes('token'));
  check('/api/operators агенту по-прежнему 403', (await call('GET', '/api/operators', undefined, agent)).status === 403);
  operations.setOperatorActive(Number(agentOp.operator.id), false);
  const after = await json<TeamNamesResponse>(await call('GET', '/api/team/names'));
  check('отключённый не в списке', !after.people.some((p) => p.name === 'Иван'), after);

  console.log('Серверы (10.6 п.1)');
  check('наблюдатель читает /api/nodes', (await call('GET', '/api/nodes', undefined, viewer)).status === 200);
  check('наблюдателю переименовать — 403', (await call('POST', '/api/nodes/alias', { name: 'de-fra-2', alias: 'Германия' }, viewer)).status === 403);
  check('наблюдателю обновить — 403', (await call('POST', '/api/nodes/refresh', {}, viewer)).status === 403);
  check('руководителю переименовать — по праву settings:nodes', (await call('POST', '/api/nodes/alias', { name: 'de-fra-2', alias: 'Германия' }, lead)).status
    === (operations.can(operations.authenticate(lead)!, 'settings:nodes') ? 200 : 403));

  console.log('Сроки ответа: owner_live (10.6 п.8)');
  const conv = store.recordInbound({ channel: 'tg_bot', externalId: 'c1', displayName: 'Анна', text: 'Привет', externalMsgId: 'm1', sentAt: Date.now() })!.conversation;
  operations.claim(conv.id, operations.authenticate(lead)!);
  let queue = await json<{ conversations: Array<{ id: number; owner_name: string | null; owner_live: boolean }> }>(await call('GET', '/api/queue'));
  check('ведёт сейчас — owner_live: true', queue.conversations.find((c) => c.id === conv.id)?.owner_live === true, queue.conversations);
  store.db.prepare('UPDATE conversation SET claimed_at = ? WHERE id = ?').run(Date.now() - 3_600_000, conv.id);
  queue = await json(await call('GET', '/api/queue'));
  const row = queue.conversations.find((c) => c.id === conv.id);
  check('закрепление истекло — «вёл»: owner_name есть, owner_live false', row?.owner_live === false && row.owner_name === 'Мария', row);

  console.log('Карта прав');
  for (const [method, url, expected] of [
    ['GET', '/api/system/problems', 'diagnostics:read'], ['GET', '/api/system/notifications', 'settings:read'],
    ['GET', '/api/connections', 'settings:read'], ['GET', '/api/team/names', 'conversation:read'],
    ['GET', '/api/nodes', 'settings:read'], ['POST', '/api/nodes/refresh', 'settings:nodes'], ['POST', '/api/nodes/alias', 'settings:nodes'],
  ] as const) check(`${method} ${url} → ${expected}`, permissionFor(method, url) === expected, permissionFor(method, url));

  console.log('Изоляция локальной панели');
  const envNames = configEnvNames();
  check('devseed знает переменные интеграций из config.ts', ['REMNAWAVE_URL', 'BEDOLAGA_API_TOKEN', 'ALERT_CHAT_ID', 'UPDATE_ENABLED', 'AI_BASE_URL', 'REMNAWAVE_PANELS_JSON']
    .every((name) => envNames.includes(name)), envNames.length);
} finally {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} проверок не прошло`);
  process.exit(1);
}
console.log('\nsystemtest: всё прошло');
