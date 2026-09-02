/**
 * Предполётная проверка. Гоняется на сервере ПОСЛЕ заполнения .env и ДО
 * первого запуска: показывает, что настроено, а что молча не работает.
 *
 *   npm run selfcheck
 */
import { Bot } from 'grammy';
import { config, version } from '../config.js';
import { syncKbFromBedolaga, syncKbFromFiles } from '../ai/kb.js';
import { AiProvider } from '../ai/provider.js';
import { BedolagaClient } from '../channels/bedolaga.js';
import { Store } from '../core/store.js';
import { openDatabase } from '../core/db.js';

type Level = 'ok' | 'warn' | 'fail' | 'skip';
const MARK: Record<Level, string> = { ok: '  ok  ', warn: ' warn ', fail: ' FAIL ', skip: ' skip ' };
let failures = 0;

function report(level: Level, label: string, detail = ''): void {
  if (level === 'fail') failures += 1;
  const line = `${MARK[level]} ${label}${detail ? ` — ${detail}` : ''}`;
  (level === 'fail' ? console.error : console.log)(line);
}

async function step(label: string, run: () => Promise<string>, optional = false): Promise<void> {
  try {
    report('ok', label, await run());
  } catch (err) {
    report(optional ? 'warn' : 'fail', label, (err as Error).message);
  }
}

console.log(`\n=== ai-support ${version}: предполётная проверка ===\n`);

// --- конфигурация ------------------------------------------------------
report('ok', 'Конфигурация загружена', `AI в режиме ${config.ai.mode}`);
report(config.alertChatId ? 'ok' : 'warn', 'ALERT_CHAT_ID', config.alertChatId || 'не задан, уведомления никуда не уйдут');
report(config.panelUrl ? 'ok' : 'warn', 'PANEL_URL', config.panelUrl || 'не задан — в уведомлениях не будет ссылки на диалог');

// --- база --------------------------------------------------------------
const db = openDatabase();
const store = new Store(db);
report('ok', 'База данных', `${config.dbPath}, версия схемы ${db.pragma('user_version', { simple: true })}`);

// --- Telegram ----------------------------------------------------------
if (config.botToken) {
  const bot = new Bot(config.botToken);
  await step('Токен бота', async () => {
    const me = await bot.api.getMe();
    const business = me.can_connect_to_business ? 'Business Mode включён' : 'Business Mode выключен';
    return `@${me.username}, ${business}`;
  });

  const connection = store.activeBusinessConnectionId();
  report(
    connection ? 'ok' : 'warn',
    'Бизнес-подключение',
    connection ?? 'не подключено — обычная личка бота при этом продолжает работать',
  );
} else {
  report('skip', 'Telegram', 'BOT_TOKEN не задан — панель работает без Telegram');
}

// --- бедолага ----------------------------------------------------------
let bedolaga: BedolagaClient | undefined;
if (config.bedolaga.enabled) {
  bedolaga = new BedolagaClient(config.bedolaga.url, config.bedolaga.token);
  await step('Бедолага: тикеты', async () => {
    const tickets = await bedolaga!.activeTickets();
    return `${tickets.length} активных`;
  });
  await step('Бедолага: FAQ', async () => {
    const { items } = await bedolaga!.faqPages(config.bedolaga.language);
    return `${items?.length ?? 0} страниц`;
  }, true);
} else {
  report('skip', 'Бедолага', 'BEDOLAGA_ENABLED=false');
}

// --- Support API -------------------------------------------------------
if (config.supportApi.enabled) {
  await step('Support API', async () => {
    const response = await fetch(config.supportApi.url.replace(/\/+$/, '') + config.supportApi.userPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.supportApi.token}` },
      body: JSON.stringify({ telegram_id: 1 }),
      signal: AbortSignal.timeout(15_000),
    });
    // 404 на несуществующего клиента — нормальный ответ живого API.
    if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
    return `отвечает, HTTP ${response.status}`;
  }, true);
} else {
  report('skip', 'Support API', 'SUPPORT_API_ENABLED=false');
}

// --- Remnawave ---------------------------------------------------------
if (config.remnawave.enabled) {
  const { RemnawaveClient } = await import('../integrations/remnawave.js');
  await step('Remnawave', async () => {
    const client = new RemnawaveClient();
    const probe = await client.probe();
    if (!probe.reachable) throw new Error(probe.note);
    // Индекс строится сам при первом поиске, здесь прогреваем и считаем.
    await client.findUser(0);
    const { size } = client.indexState();
    return size ? `${size} пользователей в индексе` : probe.note;
  }, true);
} else {
  report('skip', 'Remnawave', 'REMNAWAVE_ENABLED=false');
}

// --- права на каталоги -------------------------------------------------
const { checkWritable } = await import('../panel/kbfiles.js');
const writeProblems = await checkWritable();
if (writeProblems.length) {
  for (const problem of writeProblems) report('fail', `Запись в ${problem.dir}`, problem.error);
} else {
  report('ok', 'Каталоги базы знаний', 'доступны на запись');
}

// --- база знаний -------------------------------------------------------
await step('База знаний: файлы', async () => `${await syncKbFromFiles(store)} документов из ${config.kbDir}`);
if (bedolaga) {
  await step('База знаний: FAQ бедолаги', async () => `${await syncKbFromBedolaga(store, bedolaga!)} документов`, true);
}
const kbSize = store.kbCount();
report(kbSize ? 'ok' : 'warn', 'Поиск по базе знаний', kbSize ? `${kbSize} документов, проба: ${store.searchKb('не подключается', 3).length} совпадений` : 'база пуста, AI будет отвечать вслепую');

// --- AI ----------------------------------------------------------------
if (config.ai.mode === 'off') {
  report('skip', 'AI', 'AI_MODE=off');
} else {
  await step('AI провайдер', async () => {
    const provider = new AiProvider();
    await provider.ping();
    const { total } = provider.keyState();
    return `${config.ai.model} отвечает, ключей ${total}`;
  });
  if (config.ai.fallbackModel) {
    report('ok', 'Запасная модель', `${config.ai.fallbackModel} — резерв для текстовых обращений`);
  }
  if (config.ai.reasoningEffort) {
    report('ok', 'Рассуждения модели', config.ai.reasoningEffort);
  } else {
    report('warn', 'Рассуждения модели', 'не ограничены — на бесплатном тарифе съедят дневной лимит токенов');
  }
  if (config.ai.vision) {
    const primaryVision = config.ai.visionModels.includes(config.ai.model);
    report(primaryVision ? 'ok' : 'fail', 'Распознавание изображений',
      `${primaryVision ? 'включено' : 'основная модель не в allowlist'}, до ${config.ai.visionMaxImages} фото; модели: ${config.ai.visionModels.join(', ') || 'нет'}`);
  }
  if (config.ai.mode === 'auto') {
    report('warn', 'AI_MODE=auto', 'ответы уйдут клиентам без подтверждения — начинать стоит с suggest');
  }
}

if (config.transcribe.enabled) {
  report('ok', 'Расшифровка голосовых', `${config.transcribe.model} через ${config.transcribe.baseUrl}`);
} else {
  report('skip', 'Расшифровка голосовых', 'TRANSCRIBE_ENABLED=false — голосовые останутся без текста');
}

db.close();
console.log(failures === 0 ? '\nВсё готово к запуску.\n' : `\nПроблем: ${failures}. Запускать рано.\n`);
process.exit(failures === 0 ? 0 : 1);
