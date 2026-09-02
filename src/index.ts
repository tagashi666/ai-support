import { config, log, version } from './config.js';
import { syncKbFromBedolaga, syncKbFromFiles } from './ai/kb.js';
import { Responder } from './ai/responder.js';
import { BedolagaClient, BedolagaPoller, BedolagaSender } from './channels/bedolaga.js';
import { createBot, markReadInTelegram, refreshTelegramProfiles, TelegramBotRegistry, TelegramBotSender, TelegramDmSender } from './channels/tgdm.js';
import { Store } from './core/store.js';
import { detectSubLink } from './ai/sublink.js';
import { openDatabase } from './core/db.js';
import { checkWritable } from './panel/kbfiles.js';
import { MediaFetcher } from './core/media.js';
import { Outbox } from './core/outbox.js';
import { SlaWatcher } from './core/sla.js';
import { Notifier } from './core/notify.js';
import { NodeWatch } from './core/nodes.js';
import { CustomerDirectory } from './integrations/customers.js';
import { RemnawaveClient } from './integrations/remnawave.js';
import { loadSettings, runtime } from './core/settings.js';
import { seedTemplates } from './core/templates.js';
import { startWeb } from './panel/server.js';

const KB_SYNC_MS = 15 * 60 * 1000;

async function main(): Promise<void> {
  const db = openDatabase();
  const store = new Store(db);
  seedTemplates(store);
  loadSettings(store);

  const bots = new TelegramBotRegistry();
  for (const source of config.telegramBots) {
    const bot = createBot(store, source.token, { sourceId: source.id, sourceName: source.name });
    bots.add(source.id, source.name, source.token, bot);
  }
  const bot = bots.first();
  const outbox = new Outbox(store);
  if (bot) {
    outbox.register('tg_dm', new TelegramDmSender(bots));
    outbox.register('tg_bot', new TelegramBotSender(bots));
  }

  const bedolaga = config.bedolaga.enabled
    ? new BedolagaClient(config.bedolaga.url, config.bedolaga.token)
    : undefined;

  let poller: BedolagaPoller | undefined;
  if (bedolaga) {
    outbox.register('bedolaga', new BedolagaSender(bedolaga));
    poller = new BedolagaPoller(bedolaga, store, config.bedolaga.pollSeconds * 1000);
  }

  const remnawaves = config.remnawavePanels.map((panel) => ({
    id: panel.id,
    name: panel.name,
    readOnly: panel.readOnly,
    client: new RemnawaveClient(panel.url, panel.token, panel.readOnly),
  }));
  for (const panel of remnawaves) {
    store.syncSource({ id: panel.id, kind: 'remnawave', name: panel.name });
  }
  const remnawave = remnawaves[0]?.client;
  const customers = new CustomerDirectory(store, bedolaga, remnawaves);
  const media = new MediaFetcher(store, bot ? bots : undefined, bedolaga);
  const notifier = bot ? new Notifier(store, bot) : undefined;
  const sla = notifier ? new SlaWatcher(store, notifier) : undefined;
  const nodes = config.nodes.enabled && remnawaves.length ? new NodeWatch(store, remnawaves) : undefined;
  nodes?.start();
  // Responder существует даже при стартовом AI_MODE=off: runtime-режим можно
  // включить из панели без перезапуска. Сам обработчик первым делом проверяет
  // resolveMode и при off не обращается к провайдеру.
  const responder = new Responder(store, outbox, customers, notifier, nodes);

  const syncKb = async (): Promise<void> => {
    try {
      const files = await syncKbFromFiles(store);
      const faq = bedolaga ? await syncKbFromBedolaga(store, bedolaga) : 0;
      log.info(`База знаний: ${files} из файлов, ${faq} из FAQ бедолаги`);
    } catch (err) {
      log.warn('Не удалось синхронизировать базу знаний', err);
    }
  };
  // Права проверяем на старте: иначе поломка всплывёт только в момент,
  // когда оператор нажмёт «Опубликовать», и будет выглядеть как мёртвая кнопка.
  for (const problem of await checkWritable()) {
    log.error(`Каталог ${problem.dir}: ${problem.error}`);
  }

  await syncKb();
  const kbTimer = setInterval(() => void syncKb(), KB_SYNC_MS);

  // AI подписан на события хранилища, поэтому одинаково реагирует и на личку,
  // и на тикеты — канал ему знать не нужно.
  // Поток переписки в уведомлениях: первое обращение выделяем отдельно,
  // дальше идёт каждое сообщение клиента и каждый ответ AI. Оператор должен
  // видеть разговор, не открывая панель.
  store.on('message', ({ conversation, message, backfill }) => {
    if (backfill) return;

    if (message.direction === 'in') {
      // Ключ, присланный клиентом, — зацепка для поиска в панели и знак
      // оператору, что просить его повторно не нужно.
      const link = message.text ? detectSubLink(message.text) : undefined;
      if (link && !conversation.sub_link) {
        store.setSubLink(conversation.id, link.link);
        store.logEvent('sub_link', conversation.id, link);
      }

      const isFirst = store.listMessages(conversation.id, 2).length === 1;
      const excerpt = message.text ?? (message.media_type ? `[${message.media_type}]` : '[без текста]');
      void notifier?.notify(isFirst ? 'new' : 'message', conversation, { excerpt });
      return;
    }

    // Ответы оператора не дублируем: он их сам и отправил.
    if (message.direction === 'out' && message.author === 'ai') {
      void notifier?.notify('ai_reply', conversation, { excerpt: message.text ?? undefined });
    }
  });

  store.on('message', ({ conversation, message, backfill }) => {
    if (message.direction !== 'in' || backfill) return;
    responder.schedule(conversation);
  });

  const app = await startWeb({
    store,
    outbox,
    bot,
    customers,
    notifier,
    remnawave,
    remnawaves,
    bedolaga,
    nodes,
    onKbChanged: () => void syncKb(),
    onOpened: (conversation) => {
      if (conversation.channel !== 'tg_dm' || !bot) return;
      const last = store.lastInboundMessage(conversation.id);
      if (last?.external_msg_id) void markReadInTelegram(bots, conversation, Number(last.external_msg_id));
    },
  });

  media.start();
  sla?.start();
  poller?.start();

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} — останавливаюсь`);
    clearInterval(kbTimer);
    poller?.stop();
    media.stop();
    sla?.stop();
    responder.stop();
    nodes?.stop();
    await Promise.all(bots.all().map((configuredBot) => configuredBot.stop().catch(() => {})));
    await app.close().catch(() => {});
    db.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // bot.start() возвращает промис, который живёт до остановки бота.
  // Без catch неверный токен или сетевой сбой уронят процесс без внятной причины.
  if (!bot) {
    log.warn(`ai-support ${version}: BOT_TOKEN не задан — панель работает автономно, Telegram отключён`);
    return;
  }

  for (const [index, configuredBot] of bots.all().entries()) void configuredBot.start({
      allowed_updates: [
        'business_connection',
        'business_message',
        'edited_business_message',
        'deleted_business_messages',
        'message',
      ],
      onStart: (me) => {
        const source = config.telegramBots[index];
        log.info(`ai-support ${version}: ${source?.name ?? 'бот'} @${me.username} запущен, AI в режиме ${runtime.aiMode}`);
        if (source) void refreshTelegramProfiles(store, configuredBot, source.id);
        const active = store.activeBusinessConnectionId();
        if (active) {
          log.info(`Активное бизнес-подключение: ${active}`);
        } else {
          log.warn(
            'Бизнес-подключение отсутствует. Включи Business Mode в @BotFather, ' +
              'затем подключи бота: Настройки → Telegram для бизнеса → Чат-боты',
          );
        }
      },
    })
    .catch((err) => {
      log.error(`Бот ${config.telegramBots[index]?.name ?? index + 1} остановился с ошибкой; панель и остальные источники продолжают работу`, err);
    });
}

main().catch((err) => {
  log.error('Не удалось запуститься', err);
  process.exit(1);
});
