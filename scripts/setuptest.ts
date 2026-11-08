/** Мастер настройки: .env без потерь, override, факты хоста, сетевая диагностика, 409. */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseError, diagnoseResponse, netDeps, probeUrl } from '../src/core/netdiag.js';
import {
  nearestFreePort, parseEnv, parseFacts, parseOurOverride, parseSsLine, portOwner, renderOverride, updateEnvText,
} from '../src/cli/setupfiles.js';
import { explainConflict, findChats, runSetup } from '../src/cli/setup.js';

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`  ok    ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`, detail ?? ''); }
};
const coded = (code: string, message = code) => Object.assign(new Error(message), { code });
const fetchFailed = (cause: unknown) => new TypeError('fetch failed', { cause });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const nativeFetch = globalThis.fetch;
const nativeDeps = { ...netDeps };
type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
let route: Route = () => json({}, 404);
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
  route(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init)) as typeof fetch;

const dir = mkdtempSync(join(tmpdir(), 'setup-'));
try {
  console.log('\n[ netdiag: классификация ]');
  const eaiAgain = diagnoseError(fetchFailed(coded('EAI_AGAIN', 'getaddrinfo EAI_AGAIN bot.example.com')), 'https://bot.example.com/api');
  check('EAI_AGAIN → dns и совет про dns в override', eaiAgain.kind === 'dns' && /1\.1\.1\.1/.test(eaiAgain.hint ?? ''), eaiAgain);
  const notFound = diagnoseError(fetchFailed(coded('ENOTFOUND')), 'https://typo.example.com');
  check('ENOTFOUND → имя не найдено', notFound.kind === 'dns' && /не найдено/.test(notFound.message) && /typo\.example\.com/.test(notFound.message), notFound);
  const refused = diagnoseError(fetchFailed(new AggregateError([coded('ECONNREFUSED')], 'connect')), 'http://203.0.113.5:8080');
  check('ECONNREFUSED внутри AggregateError → refused', refused.kind === 'refused', refused);
  const timeout = diagnoseError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  check('TimeoutError → timeout', timeout.kind === 'timeout', timeout);
  const undiciTimeout = diagnoseError(fetchFailed(coded('UND_ERR_CONNECT_TIMEOUT')));
  check('UND_ERR_CONNECT_TIMEOUT → timeout', undiciTimeout.kind === 'timeout', undiciTimeout);
  const auth = diagnoseError(new Error('GET /tickets → HTTP 401'));
  check('сообщение клиента «HTTP 401» → auth', auth.kind === 'auth' && auth.status === 401, auth);
  check('403 ответ → auth', diagnoseResponse(403)?.kind === 'auth');
  check('HTML вместо JSON → html', diagnoseResponse(200, 'text/html; charset=utf-8', '<!doctype html><html>')?.kind === 'html');
  check('HTML без content-type распознаётся по телу', diagnoseResponse(200, '', '  <html><body>')?.kind === 'html');
  check('JSON 200 → годный ответ', diagnoseResponse(200, 'application/json', '{}') === null);
  check('TLS-ошибка → tls', diagnoseError(fetchFailed(coded('DEPTH_ZERO_SELF_SIGNED_CERT'))).kind === 'tls');

  console.log('\n[ netdiag: пошаговая проверка ]');
  netDeps.lookup = async () => { throw coded('EAI_AGAIN'); };
  netDeps.lookupPublic = async () => '198.51.100.7';
  const dockerDns = await probeUrl('https://bot.example.com/api/tickets');
  check('системный DNS молчит, 1.1.1.1 резолвит → dns-docker', dockerDns.diagnosis?.kind === 'dns-docker' && dockerDns.publicDnsWorks === true, dockerDns);
  netDeps.lookupPublic = async () => { throw coded('ENOTFOUND'); };
  const noName = await probeUrl('https://bot.example.com/api');
  check('публичный DNS тоже не знает имя → dns', noName.diagnosis?.kind === 'dns', noName);
  netDeps.lookup = async () => '198.51.100.7';
  netDeps.connect = async () => { throw coded('ECONNREFUSED'); };
  const closed = await probeUrl('http://bot.example.com:8080');
  check('порт закрыт → refused на шаге TCP', closed.diagnosis?.kind === 'refused' && closed.steps.some((s) => s.startsWith('TCP')), closed);
  netDeps.connect = async () => {};
  route = (url, init) => {
    const key = (init?.headers as Record<string, string> | undefined)?.['X-API-Key'];
    if (url.includes('/tickets')) return key === 'good' ? json({ items: [], total: 0 }) : json({ detail: 'bad' }, 401);
    return new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html' } });
  };
  const okProbe = await probeUrl('http://bot.example.com/tickets', { headers: { 'X-API-Key': 'good' } });
  check('DNS → TCP → HTTP 200 JSON', okProbe.ok && okProbe.steps.length === 3, okProbe);
  const badKey = await probeUrl('http://bot.example.com/tickets', { headers: { 'X-API-Key': 'bad' } });
  check('401 → «токен не подходит»', badKey.diagnosis?.kind === 'auth' && /токен/.test(badKey.diagnosis.message), badKey);
  const htmlPage = await probeUrl('http://bot.example.com/');
  check('страница сайта вместо API → html', htmlPage.diagnosis?.kind === 'html', htmlPage);

  console.log('\n[ факты хоста и порт ]');
  const ss = [
    'LISTEN 0 4096 127.0.0.1:9090 0.0.0.0:* users:(("mtproxy-metric",pid=812,fd=7))',
    'LISTEN 0 4096 0.0.0.0:9091 0.0.0.0:* users:(("docker-proxy",pid=900,fd=4))',
    'LISTEN 0 511 [::]:443 [::]:* users:(("nginx",pid=55,fd=6))',
  ];
  const listener = parseSsLine(ss[0]!);
  check('строка ss разбирается', listener?.port === 9090 && listener.process === 'mtproxy-metric' && listener.pid === 812, listener);
  const factsRaw = {
    ss,
    containers: [
      { name: '/cloudflared', image: 'cloudflare/cloudflared:2026.1.0', networkMode: 'tunnel_default', networks: { tunnel_default: {} }, ports: {}, exposed: {} },
      { name: '/bedolaga_bot', image: 'example/remnawave-bedolaga-telegram-bot:latest', networkMode: 'bot_default', networks: { bot_default: {} }, ports: { '8080/tcp': null }, exposed: { '8080/tcp': {} } },
      { name: '/metrics', image: 'example/exporter', networkMode: 'bridge', networks: { bridge: {} }, ports: { '9100/tcp': [{ HostIp: '0.0.0.0', HostPort: '9091' }] }, exposed: {} },
      { name: '/ai-support', image: 'ai-support-ai-support', networkMode: 'ai-support_default', networks: { 'ai-support_default': {} }, ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] }, exposed: {} },
    ],
  };
  const facts = parseFacts(factsRaw);
  const owner9090 = portOwner(facts, 9090);
  check('занятый порт показывает процесс', /mtproxy-metric \(pid 812\)/.test(owner9090?.owner ?? '') && owner9090?.ours === false, owner9090);
  const owner9091 = portOwner(facts, 9091);
  check('опубликованный порт показывает контейнер, а не docker-proxy', /контейнер metrics/.test(owner9091?.owner ?? ''), owner9091);
  check('порт нашего ai-support — не конфликт', portOwner(facts, 8080)?.ours === true);
  check('ближайший свободный после 9090 — 9092', nearestFreePort(facts, 9090) === 9092, nearestFreePort(facts, 9090));
  check('нет фактов → missing', parseFacts(null).missing && !facts.missing);

  console.log('\n[ .env без потерь ]');
  const template = [
    '# шапка',
    'PANEL_TOKEN=keep-me-0123456789abcdef',
    'BOT_TOKEN=',
    'CUSTOM_FOO=bar # чужой ключ',
    '# --- Bedolaga ---',
    '# BEDOLAGA_ENABLED=true',
    'BOT_TOKEN=duplicate',
    'PANEL_PORT=9090',
    '',
  ].join('\n');
  const updated = updateEnvText(template, { BOT_TOKEN: '1:new', BEDOLAGA_ENABLED: 'true', NEW_KEY: 'a b', PANEL_PORT: null }, '2026-01-01');
  const lines = updated.split('\n');
  check('заменено на месте', lines[2] === 'BOT_TOKEN=1:new', lines);
  check('чужие ключи и комментарии сохранены', updated.includes('CUSTOM_FOO=bar # чужой ключ') && lines[0] === '# шапка' && updated.includes('PANEL_TOKEN=keep-me-0123456789abcdef'));
  check('ключ из образца вписан под образцом', lines[lines.indexOf('# BEDOLAGA_ENABLED=true') + 1] === 'BEDOLAGA_ENABLED=true', lines);
  check('повтор того же ключа закомментирован', updated.includes('# BOT_TOKEN=duplicate'));
  check('null комментирует ключ', updated.includes('# PANEL_PORT=9090') && parseEnv(updated)['PANEL_PORT'] === undefined);
  check('новый ключ дописан в конец с кавычками', updated.includes("# --- мастер настройки 2026-01-01 ---\nNEW_KEY='a b'") && parseEnv(updated)['NEW_KEY'] === 'a b');

  console.log('\n[ override ]');
  const override = renderOverride({ dns: true, networks: [{ name: 'tunnel_default', external: true }, { name: 'ai-support-shared', external: false }] });
  check('dns и сети с default', /dns: \[1\.1\.1\.1, 8\.8\.8\.8\]/.test(override) && /- default/.test(override) && /external: true/.test(override));
  const reparsed = parseOurOverride(override);
  check('свой override читается обратно', reparsed.dns && reparsed.networks.length === 2 && reparsed.networks[0]!.external && !reparsed.networks[1]!.external, reparsed);

  console.log('\n[ Telegram: getUpdates ]');
  const token = '123456789:AAFakeTokenForSetupTests_0123456789ab';
  route = (url) => url.endsWith('/getUpdates')
    ? json({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running' }, 409)
    : json({}, 404);
  const conflict = await findChats(token, 100, 10);
  check('409 объясняется человеческим текстом', /docker compose stop ai-support/.test(conflict.error ?? ''), conflict);
  check('409 с webhook — свой текст', /deleteWebhook/.test(explainConflict("Conflict: can't use getUpdates method while webhook is active")));

  console.log('\n[ мастер: --answers ]');
  writeFileSync(join(dir, '.env'), [
    '# Мой .env',
    'PANEL_TOKEN=existing-token-0123456789',
    'BOT_TOKEN=',
    'ALERT_CHAT_ID=',
    'PANEL_URL=',
    'PANEL_PORT=9090',
    'PANEL_HOST=127.0.0.1',
    '# --- Bedolaga ---',
    '# BEDOLAGA_ENABLED=true',
    '# BEDOLAGA_API_URL=https://bot.example.com/api',
    'CUSTOM_FOO=bar',
    '',
  ].join('\n'));
  writeFileSync(join(dir, '.setup-facts.json'), JSON.stringify(factsRaw));
  const original = readFileSync(join(dir, '.env'), 'utf8');
  process.env['SETUP_CHAT_WAIT_MS'] = '50';
  route = (url) => {
    if (url.endsWith('/getMe')) return json({ ok: true, result: { username: 'example_support_bot' } });
    if (url.endsWith('/getUpdates')) return json({ ok: true, result: [{ update_id: 1, message: { chat: { id: -100123, type: 'supergroup', title: 'Дежурные' } } }] });
    return json({}, 404);
  };
  netDeps.lookup = async () => { throw coded('EAI_AGAIN'); };
  netDeps.lookupPublic = async () => '198.51.100.7';
  const output: string[] = [];
  const code = await runSetup({
    dir, factsPath: join(dir, '.setup-facts.json'), out: (line) => output.push(line), now: new Date(2026, 0, 2, 3, 4, 5),
    answers: {
      botToken: token, alertChatMode: 1, alertChatPick: 1,
      aiProvider: 4,
      panelAccess: 2, cloudflaredJoin: true, panelUrl: 'https://support.example.com',
      bedolaga: true, bedolagaUrl: 'https://bot.example.com/api', bedolagaToken: 'bedolaga-secret', dnsOverride: true,
      remnawave: false, confirm: true,
    },
  });
  const text = output.join('\n');
  const env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'));
  check('мастер завершился успешно', code === 0, text);
  check('getMe показал бота', text.includes('@example_support_bot'));
  check('чат найден через getUpdates', env['ALERT_CHAT_ID'] === '-100123', env);
  check('занятый 9090 показан и выбран свободный 9092', text.includes('mtproxy-metric') && env['PANEL_PUBLISH_PORT'] === '9092', env);
  check('PANEL_PORT/PANEL_HOST закомментированы', env['PANEL_PORT'] === undefined && env['PANEL_HOST'] === undefined);
  check('PANEL_TOKEN не перегенерирован', env['PANEL_TOKEN'] === 'existing-token-0123456789');
  check('чужой ключ сохранён', env['CUSTOM_FOO'] === 'bar' && readFileSync(join(dir, '.env'), 'utf8').startsWith('# Мой .env'));
  check('Bedolaga записана', env['BEDOLAGA_ENABLED'] === 'true' && env['BEDOLAGA_API_URL'] === 'https://bot.example.com/api' && env['BEDOLAGA_API_TOKEN'] === 'bedolaga-secret', env);
  check('PANEL_URL записан', env['PANEL_URL'] === 'https://support.example.com');
  const backup = join(dir, '.env.bak-20260102-030405');
  check('бэкап с исходным содержимым', existsSync(backup) && readFileSync(backup, 'utf8') === original, readdirSync(dir));
  const written = readFileSync(join(dir, 'docker-compose.override.yml'), 'utf8');
  check('override: dns и сеть cloudflared', written.includes('dns: [1.1.1.1, 8.8.8.8]') && written.includes('name: tunnel_default') && written.includes('external: true'), written);
  check('токены в выводе замаскированы', !text.includes('bedolaga-secret') && !text.includes(token));

  console.log('\n[ мастер: чужой override и прямое подключение к Bedolaga ]');
  writeFileSync(join(dir, 'docker-compose.override.yml'), 'services:\n  ai-support:\n    mem_limit: 512m\n');
  const output2: string[] = [];
  await runSetup({
    dir, factsPath: join(dir, '.setup-facts.json'), out: (line) => output2.push(line),
    answers: { aiProvider: 4, alertChatMode: 3, panelAccess: 1, bedolaga: true, bedolagaUrl: 'http://bedolaga_bot:8080', remnawave: false, confirm: true },
  });
  check('чужой override не перезаписан', readFileSync(join(dir, 'docker-compose.override.yml'), 'utf8').includes('mem_limit'));
  check('показано, что добавить вручную (сеть Bedolaga)', output2.join('\n').includes('вручную') && output2.join('\n').includes('name: bot_default'), output2.join('\n'));
  check('URL контейнера Bedolaga сохранён', parseEnv(readFileSync(join(dir, '.env'), 'utf8'))['BEDOLAGA_API_URL'] === 'http://bedolaga_bot:8080');

  console.log('\n[ мастер: --check ]');
  netDeps.lookup = async () => '198.51.100.7';
  netDeps.connect = async () => { throw coded('ECONNREFUSED'); };
  writeFileSync(join(dir, '.env'), 'PANEL_TOKEN=existing-token-0123456789\nPANEL_PORT=9090\nBEDOLAGA_ENABLED=true\nBEDOLAGA_API_URL=http://bot.example.com:8080\nBEDOLAGA_API_TOKEN=x\n');
  const before = readFileSync(join(dir, '.env'), 'utf8');
  const output3: string[] = [];
  const checkCode = await runSetup({ dir, factsPath: join(dir, '.setup-facts.json'), check: true, out: (line) => output3.push(line) });
  const text3 = output3.join('\n');
  check('--check: закрытый порт Бедолаги → провал и совет про WEB_API_BIND', checkCode === 1 && text3.includes('WEB_API_BIND') && text3.includes('DOCKER-USER'), text3);
  check('--check: предупреждение про PANEL_PORT в .env', text3.includes('PANEL_PORT=9090'));
  check('--check ничего не пишет', readFileSync(join(dir, '.env'), 'utf8') === before);
} finally {
  globalThis.fetch = nativeFetch;
  Object.assign(netDeps, nativeDeps);
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\nМастер настройки: провалов ${failures}` : '\nМастер настройки: все проверки прошли.');
process.exit(failures ? 1 : 0);
