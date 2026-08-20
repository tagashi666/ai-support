/** Кластеризация, разбор выгрузки Telegram и сбор пар из архива тикетов. */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BOT_TOKEN ??= '1:FakeForTests';
process.env.PANEL_TOKEN ??= 'minetest-0123456789ab';
process.env.AI_MODE = 'off';
process.env.LOG_LEVEL = 'error';
const dir = mkdtempSync(join(tmpdir(), 'mine-'));
process.env.DB_PATH = join(dir, 'm.db');
process.env.KB_DIR = join(dir, 'kb');

const { parseTelegramExport } = await import('../src/integrations/tgexport.js');
const { BedolagaClient } = await import('../src/channels/bedolaga.js');

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`  ok    ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`, detail ?? ''); }
};

console.log('\n[ выгрузка Telegram ]');
const exportPath = join(dir, 'result.json');
writeFileSync(exportPath, JSON.stringify({
  name: 'Поддержка',
  type: 'personal_chat',
  messages: [
    { type: 'message', from_id: 'user111', text: 'привет' },
    { type: 'message', from_id: 'user111', text: 'не работает на телевизоре самсунг' },
    { type: 'service', from_id: 'user111', text: 'звонок' },
    { type: 'message', from_id: 'user999', text: 'На Samsung TV нужен отдельный клиент, встроенного нет. Поставьте через Smart Hub или используйте роутер.' },
    { type: 'message', from_id: 'user111', text: 'спасибо' },
    { type: 'message', from_id: 'user999', text: 'ок' },
    // text массивом кусков с форматированием
    { type: 'message', from_id: 'user111', text: ['где взять ', { type: 'bold', text: 'ключ' }, ' подписки?'] },
    { type: 'message', from_id: 'user999', text: 'Ключ лежит в боте: Моя подписка → Показать ключ. Оттуда копируется ссылка или открывается QR.' },
  ],
}), 'utf8');

const без = await parseTelegramExport(exportPath);
check('без --me возвращает список участников', без.participants.length === 2, без.participants);
check('без --me пары не собираются', без.exchanges.length === 0);

const parsed = await parseTelegramExport(exportPath, 'user999');
check('собрано две пары', parsed.exchanges.length === 2, parsed.exchanges.length);
check('подряд идущие сообщения клиента склеены',
  parsed.exchanges[0]?.question.includes('привет') === true && parsed.exchanges[0]?.question.includes('самсунг') === true,
  parsed.exchanges[0]?.question);
check('короткий ответ «ок» отброшен', !parsed.exchanges.some((e) => e.answer === 'ок'));
check('служебные сообщения пропущены', !parsed.exchanges.some((e) => e.question.includes('звонок')));
check('текст-массив собран в строку', parsed.exchanges[1]?.question.includes('ключ подписки') === true, parsed.exchanges[1]?.question);

console.log('\n[ архив тикетов ]');
const tickets = [
  { id: 1, title: 'не подключается', status: 'closed', messages: [
    { id: 1, message_text: 'не подключается на айфоне', is_from_admin: false, created_at: '2026-01-01T10:00:00Z' },
    { id: 2, message_text: 'Обновите список серверов в приложении и попробуйте другой сервер из списка.', is_from_admin: true, created_at: '2026-01-01T10:05:00Z' },
  ]},
  { id: 2, title: 'не подключается 2', status: 'closed', messages: [
    { id: 3, message_text: 'не подключается на айфон 13', is_from_admin: false, created_at: '2026-01-02T10:00:00Z' },
    { id: 4, message_text: 'Обновите подписку в приложении, потянув список вниз, затем выберите другой сервер.', is_from_admin: true, created_at: '2026-01-02T10:05:00Z' },
  ]},
  { id: 3, title: 'лимит', status: 'closed', messages: [
    { id: 5, message_text: 'сколько устройств можно подключить одновременно', is_from_admin: false, created_at: '2026-01-03T10:00:00Z' },
    { id: 6, message_text: 'Количество устройств зависит от тарифа, лишние отключаются в боте в разделе Устройства.', is_from_admin: true, created_at: '2026-01-03T10:05:00Z' },
  ]},
];
const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://localhost');
  res.writeHead(req.headers['x-api-key'] === 'k' ? 200 : 401, { 'content-type': 'application/json' });
  if (url.pathname === '/tickets') return res.end(JSON.stringify(url.searchParams.get('status') === 'closed' ? tickets : []));
  const match = /^\/tickets\/(\d+)$/.exec(url.pathname);
  if (match) return res.end(JSON.stringify(tickets.find((t) => t.id === Number(match[1]))));
  res.end(JSON.stringify({}));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const client = new BedolagaClient(`http://127.0.0.1:${port}`, 'k');
const closed = await client.ticketsByStatus('closed', 100);
check('закрытые тикеты забираются', closed.length === 3, closed.length);
check('живые статусы отдельно', (await client.ticketsByStatus('open', 100)).length === 0);
server.close();

console.log('\n[ кластеризация ]');
const { clusterLexically, groupTopics } = await import('../src/ai/cluster.js');
const real = [
  'Здравствуйте, не подключается на айфоне уже второй день, всё перепробовал',
  'добрый день, на телефоне перестало подключаться, айфон 13',
  'не могу подключиться с телефона, ошибка при подключении',
  'дело в том что для моей виртуальной карты необходим испанский регион, можно ли',
  'нужен испанский сервер для карты, есть такой регион в подписке?',
  'как добавить человека в мою подписку',
  'хочу добавить второго человека к своей подписке, как это сделать',
].map((question) => ({ source: 'test', reference: 'x', question, answer: 'a'.repeat(50) }));

// Лексика — запасной путь, спрос с неё скромный: не путать явно разные темы
const assigned = clusterLexically(real);
check('близкие формулировки схлопываются', assigned[0] === assigned[1], assigned);
check('добавление человека отдельно от подключения', assigned[5] !== assigned[0], assigned);
check('регион отдельно от подключения', assigned[3] !== assigned[0], assigned);
check('лексика хоть немного сокращает список', new Set(assigned).size < real.length, new Set(assigned).size);

console.log('\n[ группировка моделью ]');
const topicServer = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ topics: [
      { name: 'не подключается', items: [1, 2, 3] },
      { name: 'региональные ограничения', items: [4, 5] },
      { name: 'общая подписка', items: [6, 7, 99] },
    ] }) } }] }));
  });
});
await new Promise<void>((r) => topicServer.listen(0, '127.0.0.1', r));
const tPort = (topicServer.address() as { port: number }).port;
const { AiProvider } = await import('../src/ai/provider.js');
const grouped = await groupTopics(real, new AiProvider(`http://127.0.0.1:${tPort}/v1`, 'k', 'm'));
check('модель дала три темы вместо семи', new Set(grouped.assignment).size === 3, grouped.assignment);
check('темы получили имена', grouped.names[0] === 'не подключается', grouped.names);
check('длинные вопросы об одном сгруппированы', grouped.assignment[3] === grouped.assignment[4]);
check('помечено, что группировала модель', grouped.byModel === true);
check('выдуманный номер 99 не сломал разбор', grouped.assignment.length === real.length);

const deadServer = createServer((_req, res) => { res.writeHead(500); res.end('boom'); });
await new Promise<void>((r) => deadServer.listen(0, '127.0.0.1', r));
const dPort = (deadServer.address() as { port: number }).port;
const fallback = await groupTopics(real, new AiProvider(`http://127.0.0.1:${dPort}/v1`, 'k', 'm'));
check('при отказе модели откат на лексику', fallback.byModel === false && fallback.assignment.length === real.length);
topicServer.close(); deadServer.close();

// Повторяем алгоритм майнера на тех же данных
const STOP = new Set(['что','как','для','это','мне','можно','подскажите','здравствуйте']);
const toks = (t: string) => new Set(t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3 && !STOP.has(w)).map((w) => w.slice(0, 5)));
const sim = (a: Set<string>, b: Set<string>) => {
  let s = 0; for (const w of a) if (b.has(w)) s += 1;
  return a.size && b.size ? s / (a.size + b.size - s) : 0;
};
const T = 0.34;
const qs = [
  'не подключается на айфоне',
  'не подключается на айфон 13',
  'сколько устройств можно подключить одновременно',
  'не работает на телевизоре самсунг',
];
check('похожие вопросы схлопываются в одну тему', sim(toks(qs[0]!), toks(qs[1]!)) >= T, sim(toks(qs[0]!), toks(qs[1]!)));
check('общий корень не сливает разные темы', sim(toks(qs[0]!), toks(qs[2]!)) < T, sim(toks(qs[0]!), toks(qs[2]!)));
check('совсем разные темы далеки', sim(toks(qs[0]!), toks(qs[3]!)) < T, sim(toks(qs[0]!), toks(qs[3]!)));

console.log('\n[ потолок ответа при майнинге ]');
{
  let seenMaxTokens = 0;
  const capServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seenMaxTokens = JSON.parse(raw).max_tokens;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"reply":"x","confidence":1}' } }] }));
    });
  });
  await new Promise<void>((r) => capServer.listen(0, '127.0.0.1', r));
  const cPort = (capServer.address() as { port: number }).port;
  const { AiProvider: P } = await import('../src/ai/provider.js');
  const prov = new P(`http://127.0.0.1:${cPort}/v1`, 'k', 'm');

  await prov.complete([{ role: 'user', content: 'x' }]);
  check('обычный ответ идёт с базовым потолком', seenMaxTokens === 700, seenMaxTokens);

  await prov.complete([{ role: 'user', content: 'x' }], 3, 3500);
  check('майнинг просит больше места под пачку статей', seenMaxTokens === 3500, seenMaxTokens);
  capServer.close();
}

console.log('\n[ каталог черновиков ]');
{
  const { config } = await import('../src/config.js');
  check('черновики лежат вне каталога базы знаний',
    !config.draftDir.startsWith(config.kbDir), `${config.draftDir} vs ${config.kbDir}`);
}

console.log('\n[ разбивка на запросы по бюджету ]');
const { batch } = await import('../src/ai/mining.js');
type P = { source: string; reference: string; question: string; answer: string; n: number; cluster: number };
const mk = (n: number, cluster: number, chars: number): P => ({
  source: 't', reference: `r${n}`, n, cluster,
  question: 'в'.repeat(Math.floor(chars / 3)),
  answer: 'о'.repeat(Math.floor((chars * 2) / 3)),
});

// Крупная тема: 19 пар примерно по 1500 символов ≈ 600 токенов каждая
const big = Array.from({ length: 19 }, (_, i) => mk(i + 1, 0, 1500));
const budget = 4500;
const split = batch(big, budget);
const totalIn = split.flat().length;
check('ни одна пара не потеряна при разрезании темы', totalIn === 19, totalIn);
const worst = Math.max(...split.map((g) => g.reduce((s, i) => s + Math.ceil(i.question.length / 2.5) + Math.ceil(i.answer.length / 2.5) + 30, 0)));
check('ни один запрос не превышает бюджет', worst <= budget, worst);
check('крупная тема разбита на несколько запросов', split.length > 1, split.length);

// Мелкие темы едут вместе, пока влезают
const small = [mk(1, 1, 300), mk(2, 2, 300), mk(3, 3, 300)];
check('мелкие темы объединяются в один запрос', batch(small, budget).length === 1);

// Порядок: частые темы первыми
const mixed = [mk(1, 5, 300), ...Array.from({ length: 6 }, (_, i) => mk(i + 2, 9, 300))];
check('крупная тема идёт первой', batch(mixed, budget)[0]![0]!.cluster === 9, batch(mixed, budget)[0]![0]!.cluster);

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
