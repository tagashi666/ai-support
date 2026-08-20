/**
 * Сбор базы знаний из переписки — консольный вход.
 * То же самое доступно кнопкой в панели; здесь удобнее гонять большие архивы.
 *
 *   npm run kb:mine -- --archive --dry-run
 *   npm run kb:mine -- --archive --status resolved --limit 300
 *   npm run kb:mine -- --export ~/result.json --me user123456789
 *   npm run kb:mine                     диалоги из базы панели
 */
import { pathToFileURL } from 'node:url';
import { config, version } from '../config.js';
import { Store } from '../core/store.js';
import { openDatabase } from '../core/db.js';
import { runMining } from '../ai/mining.js';
import { parseTelegramExport } from '../integrations/tgexport.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  console.log(`ai-support ${version} — майнинг базы знаний`);
  const db = openDatabase();
  const store = new Store(db);

  let exchanges;
  if (flag('export')) {
    const path = arg('export');
    if (!path) throw new Error('Укажи путь: --export ~/result.json');
    const me = arg('me');
    const parsed = await parseTelegramExport(path, me);
    if (!me) {
      console.log(`Чат: ${parsed.chatName}`);
      console.log('Не указано, какие сообщения твои. Участники выгрузки:');
      for (const id of parsed.participants) console.log(`  ${id}`);
      console.log('\nПовтори с нужным: --me user123456789');
      db.close();
      return;
    }
    exchanges = parsed.exchanges;
    console.log(`Из выгрузки «${parsed.chatName}»: пар ${exchanges.length}`);
  }

  const report = await runMining(
    store,
    {
      source: exchanges ? 'export' : flag('archive') ? 'archive' : 'panel',
      status: arg('status'),
      limit: Number(arg('limit') ?? 200),
      all: flag('all'),
      exchanges,
      dryRun: flag('dry-run'),
    },
    (message) => console.log(message),
  );

  if (!report.pairs && !report.topics.length) {
    console.log('Пригодных пар «вопрос-ответ» не нашлось.');
    db.close();
    return;
  }

  console.log(`\nТем: ${report.topics.filter((t) => !t.skipped).length}, запросов на синтез: ${report.requests}`);
  if (report.skipped) console.log(`Пропущено как «прочее»: ${report.skipped} пар — статей из них не бывает.`);
  console.log('--- самые крупные темы ---');
  for (const topic of report.topics.slice(0, 10)) {
    console.log(`  ${String(topic.size).padStart(3)} × ${topic.name}${topic.skipped ? '  [пропускается]' : ''}`);
  }

  if (report.dryRun) {
    console.log(`\nСухой прогон. Потрачен один запрос на группировку, синтез не запускался.`);
    console.log(`Полный проход: ${report.requests} запросов, примерно ${Math.round(report.estimatedTokens / 1000)}K токенов на вход.`);
    console.log(`С паузой ${config.ai.minePaceMs / 1000} с между запросами это займёт около ${Math.ceil(report.requests * config.ai.minePaceMs / 60000)} мин.`);
    db.close();
    return;
  }

  const weak = report.articles.filter((a) => a.confidence < 0.5).length;
  console.log(`\nГотово: ${report.articles.length} статей в ${config.draftDir}`);
  if (weak) console.log(`Из них ${weak} с низкой уверенностью — читай особенно внимательно.`);
  console.log('\nВ ответы клиентам они пока НЕ идут. Проверь их в панели, раздел «База знаний».');
  db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Майнинг не удался:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
