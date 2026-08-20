/**
 * Разбор связки с Remnawave по конкретному клиенту.
 *
 *   node dist/rwprobe.js 123456789
 *   node dist/rwprobe.js 123456789 example_user
 *
 * Печатает, что панель отвечает на каждый способ поиска, сколько записей
 * попало в индекс и как выглядят похожие записи. Нужен, чтобы не гадать,
 * почему клиент «есть в бедолаге, но не найден в панели».
 */
import { pathToFileURL } from 'node:url';
import { config, version } from '../config.js';
import { RemnawaveClient } from '../integrations/remnawave.js';

async function main(): Promise<void> {
  console.log(`ai-support ${version} — разбор связки с Remnawave\n`);
  if (!config.remnawave.enabled) {
    console.error('REMNAWAVE_ENABLED=false — включи в .env');
    process.exit(1);
  }

  const telegramId = Number(process.argv[2]);
  const username = process.argv[3];
  if (!Number.isFinite(telegramId) && !username) {
    console.error('Укажи telegram id и, если есть, ник:  node dist/rwprobe.js 123456789 example_user');
    process.exit(1);
  }

  const client = new RemnawaveClient();
  console.log(`Панель: ${config.remnawave.url}\n`);

  const result = await client.explain(Number.isFinite(telegramId) ? telegramId : undefined, username);

  for (const step of result.steps) console.log(`  ${step}`);
  console.log(`\nЗаписей в индексе: ${result.indexSize}`);

  if (result.near.length) {
    console.log('\nПохожие записи в панели:');
    for (const item of result.near) console.log(`  ${item}`);
  }

  if (result.ref) {
    console.log(`\nНайден: ${result.ref}`);
    const profile = await client.profile(result.ref);
    console.log(profile ? `Профиль читается: статус ${profile.status ?? '—'}, до ${profile.expiresAt ?? '—'}`
      : 'Профиль по этому id не читается — путь к записи в этой версии панели другой');
  } else {
    console.log('\nНе найден. Если клиент точно есть в панели — покажи любую его запись:');
    console.log(`  curl -s -H "Authorization: Bearer $REMNAWAVE_TOKEN" "${config.remnawave.url}/api/users?start=0&size=1"`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Разбор не удался:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
