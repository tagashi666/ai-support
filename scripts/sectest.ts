/** Слои защиты: билеты, заголовки, только чтение, фильтр исходящего. */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
process.env.MEDIA_DIR = join(dir, 'media');
mkdirSync(join(dir, 'kb')); mkdirSync(join(dir, 'draft')); mkdirSync(join(dir, 'media'));

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
    ['токен бота', 'Токен 7712345678:' + 'A'.repeat(35)],
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

console.log('\n[ версии обновлений ]');
{
  const { isNewer, isSameVersion } = await import('../src/core/update.js');
  check('следующий RC новее', isNewer('v2.0.0-rc.2', '2.0.0-rc.1'));
  check('стабильный релиз новее RC', isNewer('v2.0.0', '2.0.0-rc.9'));
  check('RC не новее стабильного', !isNewer('v2.0.0-rc.10', '2.0.0'));
  check('старая версия не считается обновлением', !isNewer('v1.16.0', '2.0.0-rc.1'));
  check('произвольный тег отвергается', !isNewer('latest', '2.0.0-rc.1'));
  check('тот же RC можно безопасно переустановить', isSameVersion('v2.0.0-rc.1', '2.0.0-rc.1'));
  check('старый RC нельзя выдать за переустановку', !isSameVersion('v2.0.0-rc.1', '2.0.0-rc.2'));
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

console.log('\n[ файлы базы знаний ]');
{
  const { readDoc, writeDoc } = await import('../src/panel/kbfiles.js');
  const outside = join(dir, 'outside-secret.txt');
  writeFileSync(outside, 'outside-secret');
  symlinkSync(outside, join(dir, 'kb', 'leak.md'));
  let symlinkReadBlocked = false;
  try { await readDoc('kb', 'leak.md'); } catch { symlinkReadBlocked = true; }
  check('симлинк нельзя прочитать как статью', symlinkReadBlocked);

  symlinkSync(outside, join(dir, 'draft', 'replace.md'));
  await writeDoc('draft', 'replace.md', '# безопасный файл');
  check('атомарная запись не меняет цель симлинка', readFileSync(outside, 'utf8') === 'outside-secret');
  check('симлинк заменён обычным документом', await readDoc('draft', 'replace.md') === '# безопасный файл');

  let oversizedBlocked = false;
  try { await writeDoc('draft', 'large.md', 'x'.repeat(1_048_577)); } catch { oversizedBlocked = true; }
  check('документ больше лимита отклонён', oversizedBlocked);

  writeFileSync(join(dir, 'kb', 'safe.md'), '# Безопасная\n\nРазрешённый текст');
  let indexed: { extId: string; title: string; body: string }[] = [];
  const fakeStore = {
    syncKb: (_source: string, docs: typeof indexed) => { indexed = docs; },
  };
  const { syncKbFromFiles } = await import('../src/ai/kb.js');
  await syncKbFromFiles(fakeStore as never, join(dir, 'kb'));
  check('AI индексирует обычный документ', indexed.some((doc) => doc.extId === 'safe.md'));
  check('AI не индексирует документ-симлинк', !indexed.some((doc) => doc.extId === 'leak.md'));
  check('секрет за симлинком не попал в AI', !indexed.some((doc) => doc.body.includes('outside-secret')));
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
  const csp = headers.get('content-security-policy') ?? '';
  check('политика содержимого выставлена', csp.includes("default-src 'none'"));
  check('inline-script разрешён только точным хешем', /script-src[^;]*'sha256-[^']+'/u.test(csp)
    && !/script-src[^;]*'unsafe-inline'/u.test(csp), csp);
  check('запрет угадывания типа', headers.get('x-content-type-options') === 'nosniff');
  check('панель нельзя встроить в рамку', csp.includes("frame-ancestors 'none'"));
  check('API нельзя кешировать', headers.get('cache-control')?.includes('no-store') === true);

  const { ticket } = await (await fetch(`${B}/api/ticket`, { headers: H })).json() as { ticket: string };
  check('билет выдаётся', /^\d+\.[A-Za-z0-9_-]+$/.test(ticket), ticket);

  // Билет открывает только чтение вложений, но не изменение состояния.
  const withTicket = await fetch(`${B}/api/attachments/999?token=${encodeURIComponent(ticket)}`);
  check('по билету можно читать вложения', withTicket.status === 404, withTicket.status);

  const abuse = await fetch(`${B}/api/settings?token=${encodeURIComponent(ticket)}`);
  check('билет не заменяет токен на других маршрутах', abuse.status === 401, abuse.status);

  const forged = await fetch(`${B}/api/attachments/1?token=${encodeURIComponent('99999999999999.подделка')}`);
  check('поддельный билет отвергается', forged.status === 401, forged.status);

  // Даже при подмене local_path в БД endpoint обязан вычислить разрешённое
  // имя из file_ref, а не читать указанный атакующим файл.
  const inbound = store.recordInbound({
    channel: 'bedolaga', externalId: 'sec-file', text: 'фото', mediaType: 'photo',
    mediaFileId: 'remote-photo', externalMsgId: 'sec-photo-1', sentAt: Date.now(),
  })!;
  const attachmentId = store.attachmentsFor([inbound.message.id])[inbound.message.id]?.[0]?.id;
  const outside = join(dir, 'attachment-secret.txt');
  writeFileSync(outside, 'attachment-secret');
  store.markAttachmentDownloaded(attachmentId!, outside, 17);
  const poisonedPath = await fetch(`${B}/api/attachments/${attachmentId}`, { headers: H });
  check('подмена local_path не раскрывает произвольный файл', poisonedPath.status === 404
    && !(await poisonedPath.text()).includes('attachment-secret'));

  const { mediaPath, readMediaFile, saveMediaFile } = await import('../src/core/media.js');
  const expectedPath = mediaPath('bedolaga:remote-photo');
  symlinkSync(outside, expectedPath);
  check('симлинк вместо вложения не читается',
    (await fetch(`${B}/api/attachments/${attachmentId}`, { headers: H })).status === 404);
  let aiSymlinkBlocked = false;
  try { await readMediaFile('bedolaga:remote-photo'); } catch { aiSymlinkBlocked = true; }
  check('AI не читает вложение через симлинк', aiSymlinkBlocked);
  unlinkSync(expectedPath);
  await saveMediaFile('bedolaga:remote-photo', Buffer.from('safe-photo'));
  const safeAttachment = await fetch(`${B}/api/attachments/${attachmentId}`, { headers: H });
  check('валидное вложение по вычисленному пути отдаётся', safeAttachment.status === 200
    && await safeAttachment.text() === 'safe-photo');

  const WS = (await import('ws')).default;
  const crossOrigin = new WS(`ws://127.0.0.1:8189/ws?token=${encodeURIComponent(ticket)}`, {
    headers: { origin: 'https://evil.example' },
  });
  const crossOriginCode = await new Promise<number>((resolve) => {
    const timeout = setTimeout(() => resolve(-1), 3_000);
    crossOrigin.once('close', (code) => { clearTimeout(timeout); resolve(code); });
    crossOrigin.once('error', () => { clearTimeout(timeout); resolve(1008); });
  });
  check('WebSocket отвергает чужой Origin', crossOriginCode === 1008, crossOriginCode);

  await app.close(); db.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
