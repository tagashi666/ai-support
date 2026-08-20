/** Слои защиты: билеты, заголовки, только чтение, фильтр исходящего. */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BOT_TOKEN = '1:FakeForSecurityTests';
process.env.PANEL_TOKEN = 'security-0123456789ab';
process.env.AI_MODE = 'off';
process.env.LOG_LEVEL = 'error';
process.env.PANEL_PORT = '8189';
process.env.AI_ALLOWED_DOMAINS = 'example.com';
const dir = mkdtempSync(join(tmpdir(), 'sec-'));
process.env.DB_PATH = join(dir, 'd.db');
process.env.KB_DIR = join(dir, 'kb');
process.env.DRAFT_DIR = join(dir, 'draft');
mkdirSync(join(dir, 'kb')); mkdirSync(join(dir, 'draft'));

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`  ok    ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`, detail ?? ''); }
};

console.log('\n[ фильтр исходящего ]');
{
  const { checkOutbound } = await import('../src/ai/outbound.js');
  const cases: [string, string][] = [
    ['адрес сервера', 'Попробуйте подключиться к 203.0.113.42'],
    ['внутренний домен', 'Зайдите на panel.internal-host.dev'],
    ['идентификатор', 'Ваш id 9c09b83a-859f-4f63-ac2b-22bafb5817de'],
    ['ключ подписки', 'Вот ключ vless://abc@host:443'],
    ['токен бота', 'Токен 7712345678:' + 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'],
    ['длинный секрет', 'Секрет 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'],
  ];
  for (const [name, text] of cases) {
    check(`задержан ответ: ${name}`, !checkOutbound(text).ok, text);
  }
  check('обычный ответ проходит',
    checkOutbound('Обновите список серверов в приложении и попробуйте снова').ok);
  check('разрешённый домен не мешает',
    checkOutbound('Подробности на example.com', ['example.com']).ok);
}

console.log('\n[ имена узлов ]');
{
  const { publicNodeName } = await import('../src/integrations/remnawave.js');
  check('адрес вырезан из имени', !/\d+\.\d+\.\d+\.\d+/.test(publicNodeName('DE-01 203.0.113.42')));
  check('хостнейм вырезан', !/\./.test(publicNodeName('germany node de-fra-01.internal.net')));
  check('человеческое имя сохраняется', publicNodeName('Германия Game+') === 'Германия Game+');
  check('пустое имя не ломает', publicNodeName('10.0.0.1') === 'узел');
}

console.log('\n[ только чтение ]');
{
  process.env.REMNAWAVE_READONLY = 'true';
  const { RemnawaveClient } = await import('../src/integrations/remnawave.js');
  // config уже прочитан, поэтому проверяем поведение флага напрямую
  const { config } = await import('../src/config.js');
  const wasReadOnly = config.remnawave.readOnly;
  (config.remnawave as { readOnly: boolean }).readOnly = true;
  const client = new RemnawaveClient('http://127.0.0.1:1', 'tok');

  for (const [name, run] of [
    ['сброс устройств', () => client.resetDevices('u1')],
    ['перевыпуск подписки', () => client.revoke('u1')],
    ['удаление устройства', () => client.deleteDevice('u1', 'hw')],
  ] as [string, () => Promise<unknown>][]) {
    let blocked = false;
    try { await run(); } catch (err) { blocked = String(err).includes('READONLY'); }
    check(`запрещено: ${name}`, blocked);
  }
  (config.remnawave as { readOnly: boolean }).readOnly = wasReadOnly;
}

console.log('\n[ предел вложений ]');
{
  const { readLimitedBody } = await import('../src/core/http.js');
  const small = await readLimitedBody(new Response(new Uint8Array([1, 2, 3])), 4);
  check('небольшой файл читается', small.byteLength === 3);
  let blocked = false;
  try {
    await readLimitedBody(new Response(new Uint8Array(16)), 8);
  } catch (err) {
    blocked = String(err).includes('предел');
  }
  check('слишком большой файл прерывается', blocked);
}

console.log('\n[ доступ к панели ]');
{
  const { Store } = await import('../src/core/store.js');
  const { openDatabase } = await import('../src/core/db.js');
  const { Outbox } = await import('../src/core/outbox.js');
  const { startWeb } = await import('../src/panel/server.js');
  const db = openDatabase(); const store = new Store(db);
  const app = await startWeb({ store, outbox: new Outbox(store) });
  const B = 'http://127.0.0.1:8189';
  const H = { authorization: 'Bearer security-0123456789ab' };

  const headers = (await fetch(`${B}/api/settings`, { headers: H })).headers;
  check('политика содержимого выставлена', (headers.get('content-security-policy') ?? '').includes("default-src 'none'"));
  check('запрет угадывания типа', headers.get('x-content-type-options') === 'nosniff');
  check('панель нельзя встроить в рамку', (headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"));

  const { ticket } = await (await fetch(`${B}/api/ticket`, { headers: H })).json() as { ticket: string };
  check('билет выдаётся', /^\d+\.[A-Za-z0-9_-]+$/.test(ticket), ticket);

  // Билет открывает только чтение вложений, но не изменение состояния.
  const withTicket = await fetch(`${B}/api/attachments/999?token=${encodeURIComponent(ticket)}`);
  check('по билету можно читать вложения', withTicket.status === 404, withTicket.status);

  const abuse = await fetch(`${B}/api/settings?token=${encodeURIComponent(ticket)}`);
  check('билет не заменяет токен на других маршрутах', abuse.status === 401, abuse.status);

  const forged = await fetch(`${B}/api/attachments/1?token=${encodeURIComponent('99999999999999.подделка')}`);
  check('поддельный билет отвергается', forged.status === 401, forged.status);

  await app.close(); db.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
