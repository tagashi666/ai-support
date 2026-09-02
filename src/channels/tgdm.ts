import { Bot, type Context } from 'grammy';
import type { Message as TgMessage, UserFromGetMe } from 'grammy/types';
import { log } from '../config.js';
import type { Conversation, Store } from '../core/store.js';
import type { ChannelSender, SendPayload, SendResult } from '../core/outbox.js';

/** Достаёт из сообщения тип вложения и file_id. Скачивание — этап P2. */
function extractMedia(msg: TgMessage): { mediaType?: string; mediaFileId?: string; mediaWidth?: number; mediaHeight?: number } {
  // Размеры сохраняем для картинок и видео: по ним панель резервирует место
  // до загрузки, иначе догрузившееся вложение толкает переписку вниз.
  if (msg.photo?.length) {
    const best = msg.photo.at(-1)!;
    return { mediaType: 'photo', mediaFileId: best.file_id, mediaWidth: best.width, mediaHeight: best.height };
  }
  if (msg.video) {
    return { mediaType: 'video', mediaFileId: msg.video.file_id, mediaWidth: msg.video.width, mediaHeight: msg.video.height };
  }
  if (msg.voice) return { mediaType: 'voice', mediaFileId: msg.voice.file_id };
  if (msg.audio) return { mediaType: 'audio', mediaFileId: msg.audio.file_id };
  if (msg.document) return { mediaType: 'document', mediaFileId: msg.document.file_id };
  if (msg.video_note) return { mediaType: 'video_note', mediaFileId: msg.video_note.file_id };
  if (msg.sticker) return { mediaType: 'sticker', mediaFileId: msg.sticker.file_id };
  if (msg.animation) return { mediaType: 'animation', mediaFileId: msg.animation.file_id };
  return {};
}

/**
 * Что клиент процитировал. Telegram отдаёт три варианта: выделенный фрагмент
 * (quote), сообщение целиком (reply_to_message) и ответ на сообщение из
 * другого чата (external_reply). Без этого «Да» и «Вот что выходит»
 * повисают в воздухе — непонятно, к чему они относятся.
 */
function extractReply(msg: TgMessage): { replyToExternalId?: string; replyExcerpt?: string } {
  const quote = msg.quote?.text?.trim();
  const replied = msg.reply_to_message;

  if (replied) {
    const excerpt = quote
      ?? replied.text?.trim()
      ?? replied.caption?.trim()
      ?? (extractMedia(replied as TgMessage).mediaType ? `[${extractMedia(replied as TgMessage).mediaType}]` : undefined);
    return { replyToExternalId: String(replied.message_id), replyExcerpt: excerpt };
  }
  if (quote) return { replyExcerpt: quote };
  return {};
}

function displayName(from: { first_name?: string; last_name?: string } | undefined): string | undefined {
  if (!from) return undefined;
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || undefined;
}

type BotOptions = { botInfo?: UserFromGetMe; syncAvatars?: boolean; sourceId?: string; sourceName?: string };

/**
 * Telegram Business не имеет отдельного update-типа для ручного ответа
 * владельца. В private-чате входящее всегда имеет `from.id === chat.id`, а
 * у исходящего `chat.id` остаётся id собеседника, тогда как `from.id` — id
 * бизнес-аккаунта. Это свойство работает даже сразу после рестарта, когда
 * новый update `business_connection` ещё не был доставлен и локальная запись
 * владельца отсутствует.
 */
export function isBusinessMessageOutgoing(message: {
  chat: { id: number; type?: string };
  from?: { id: number };
  sender_business_bot?: unknown;
}, businessOwnerId?: number): boolean {
  if (message.sender_business_bot) return true;
  if (message.from?.id === undefined) return false;
  if (businessOwnerId !== undefined && message.from.id === businessOwnerId) return true;
  return message.chat.type === 'private' && message.from.id !== message.chat.id;
}

/**
 * Явный token нужен автономному старту: config больше не обязан его иметь.
 * Вариант с options оставлен для локальных интеграционных тестов и старых
 * импортов, где токен уже лежал в BOT_TOKEN.
 */
export function createBot(store: Store, token: string, options?: BotOptions): Bot;
export function createBot(store: Store, options?: BotOptions): Bot;
export function createBot(store: Store, tokenOrOptions: string | BotOptions = {}, maybeOptions: BotOptions = {}): Bot {
  const token = typeof tokenOrOptions === 'string' ? tokenOrOptions : process.env.BOT_TOKEN;
  const options = typeof tokenOrOptions === 'string' ? maybeOptions : tokenOrOptions;
  if (!token) throw new Error('BOT_TOKEN не задан');
  const bot = new Bot(token, options.botInfo ? { botInfo: options.botInfo } : undefined);
  const botSourceId = options.sourceId ?? 'telegram-default';
  const botSourceName = options.sourceName ?? 'Telegram';
  store.syncSource({ id: botSourceId, kind: 'telegram_bot', name: botSourceName });

  const syncAvatar = async (conversationId: number, userId: number): Promise<void> => {
    try {
      const photos = await bot.api.getUserProfilePhotos(userId, { limit: 1 });
      const fileId = photos.photos[0]?.at(-1)?.file_id;
      if (fileId) store.setConversationAvatar(conversationId, fileId, botSourceId);
    } catch (err) {
      log.debug(`Не удалось получить аватар Telegram ${userId}`, err);
    }
  };

  // Подключение/отключение бота к бизнес-аккаунту.
  bot.on('business_connection', async (ctx) => {
    const bc = ctx.update.business_connection;
    const businessSourceId = `${botSourceId}:business:${bc.id}`;
    const businessName = displayName(bc.user) ?? bc.user.username ?? `${botSourceName} Business`;
    store.syncSource({ id: businessSourceId, kind: 'telegram_business', name: businessName,
      metadata: { botSourceId, userId: bc.user.id, username: bc.user.username ?? null } });
    store.saveBusinessConnection({
      id: bc.id,
      userId: bc.user.id,
      userChatId: bc.user_chat_id,
      isEnabled: bc.is_enabled,
      rights: bc.rights,
      connectedAt: bc.date * 1000,
      sourceId: botSourceId,
      displayName: businessName,
      username: bc.user.username,
    });
    store.logEvent('business_connection', null, { id: bc.id, is_enabled: bc.is_enabled });

    if (!bc.is_enabled) {
      log.warn(`Бизнес-подключение ${bc.id} отключено владельцем аккаунта`);
      return;
    }
    if (!bc.rights?.can_reply) {
      log.warn(
        `Бизнес-подключение ${bc.id} активно, но право can_reply не выдано — отвечать из панели не получится`,
      );
    }
    log.info(`Бизнес-подключение ${bc.id} активно для аккаунта ${bc.user.id}`);
  });

  // Входящие из личных чатов аккаунта.
  bot.on('business_message', async (ctx) => {
    const msg = ctx.msg;
    const peerId = msg.chat.id;
    const media = extractMedia(msg);
    const businessSourceId = `${botSourceId}:business:${msg.business_connection_id}`;
    const connection = store.sourceAccount(businessSourceId);
    if (!connection) store.syncSource({ id: businessSourceId, kind: 'telegram_business', name: `${botSourceName} Business`, metadata: { botSourceId } });

    // Business API присылает одним и тем же типом события и сообщение
    // клиента, и сообщение, которое владелец аккаунта отправил вручную из
    // Telegram. У владельца id совпадает с user_id Business Connection;
    // sender_business_bot дополнительно отмечает ответы подключённого бота.
    // Важно определить направление до проверки is_bot: иначе собственный
    // ответ либо становился «клиентским», либо бесследно пропадал.
    const business = store.businessConnection(msg.business_connection_id);
    const outgoing = isBusinessMessageOutgoing(msg, business?.user_id);
    if (!outgoing && msg.from?.is_bot) return;

    // «Избранное»/самодиалог владельца не является обращением клиента. В
    // старом обработчике именно такие апдейты могли создать карточку, где
    // саппорт выглядел одновременно клиентом и оператором.
    if (outgoing && business?.user_id === peerId) {
      log.debug(`Самодиалог Telegram Business ${peerId} — пропущено`);
      return;
    }

    // Для исходящего msg.from — владелец саппорт-аккаунта, а клиент живёт в
    // msg.chat. Нельзя перезаписывать карточку клиента именем оператора.
    const peer = outgoing ? msg.chat : msg.from;
    const payload = {
      channel: 'tg_dm' as const,
      externalId: String(peerId),
      sourceId: businessSourceId,
      sourceName: connection?.name ?? `${botSourceName} Business`,
      sourceKind: 'telegram_business' as const,
      avatarSourceId: botSourceId,
      tgUserId: outgoing ? peerId : (msg.from?.id ?? peerId),
      senderTgUserId: msg.from?.id,
      businessConnectionId: msg.business_connection_id,
      username: peer && 'username' in peer ? peer.username : undefined,
      displayName: displayName(peer),
      text: msg.text ?? msg.caption ?? undefined,
      mediaType: media.mediaType,
      mediaFileId: media.mediaFileId,
      mediaWidth: media.mediaWidth,
      mediaHeight: media.mediaHeight,
      externalMsgId: String(msg.message_id),
      ...extractReply(msg),
      sentAt: msg.date * 1000,
    };

    const recorded = outgoing
      ? store.recordExternalOutbound(payload)
      : store.recordInbound(payload);

    if (!recorded) {
      log.debug(`Повторная доставка сообщения ${msg.message_id} — пропущено`);
      return;
    }
    if (!outgoing && options.syncAvatars !== false && !recorded.conversation.avatar_file_id && msg.from?.id) {
      void syncAvatar(recorded.conversation.id, msg.from.id);
    }
    log.info(`${outgoing ? 'Исходящее вне панели' : 'Входящее из лички'} ${peerId} → диалог ${recorded.conversation.id}`);
  });

  bot.on('edited_business_message', (ctx) => {
    store.logEvent('business_message_edited', null, {
      chat_id: ctx.msg.chat.id,
      message_id: ctx.msg.message_id,
    });
  });

  bot.on('deleted_business_messages', (ctx) => {
    store.logEvent('business_messages_deleted', null, {
      chat_id: ctx.update.deleted_business_messages.chat.id,
      message_ids: ctx.update.deleted_business_messages.message_ids,
    });
  });

  /** Обычная личка бота — отдельный канал, независимо от Business Mode. */
  bot.on('message', (ctx) => {
    const msg = ctx.msg;
    if (msg.chat.type !== 'private' || msg.from?.is_bot) return;
    const peerId = msg.chat.id;
    const media = extractMedia(msg);
    const recorded = store.recordInbound({
      channel: 'tg_bot',
      externalId: String(peerId),
      sourceId: botSourceId,
      sourceName: botSourceName,
      sourceKind: 'telegram_bot',
      avatarSourceId: botSourceId,
      tgUserId: msg.from?.id ?? peerId,
      senderTgUserId: msg.from?.id,
      username: msg.from?.username,
      displayName: displayName(msg.from),
      text: msg.text ?? msg.caption ?? undefined,
      mediaType: media.mediaType,
      mediaFileId: media.mediaFileId,
      mediaWidth: media.mediaWidth,
      mediaHeight: media.mediaHeight,
      externalMsgId: String(msg.message_id),
      ...extractReply(msg),
      sentAt: msg.date * 1000,
    });
    if (!recorded) return;
    if (options.syncAvatars !== false && !recorded.conversation.avatar_file_id && msg.from?.id) {
      void syncAvatar(recorded.conversation.id, msg.from.id);
    }
    log.info(`Входящее боту ${peerId} → диалог ${recorded.conversation.id}`);
  });

  bot.catch((err) => {
    log.error('Ошибка обработки апдейта', err.error);
  });

  return bot;
}

/**
 * Восстанавливает профиль независимо от новых сообщений. Это важно после
 * миграций и для давно молчащих клиентов: имя и аватар должны появиться
 * сразу после запуска, а не когда человек напишет ещё раз.
 */
export async function refreshTelegramProfiles(store: Store, bot: Bot, sourceId: string): Promise<void> {
  for (const conversation of store.telegramProfilesForRefresh(sourceId)) {
    const userId = conversation.tg_user_id;
    if (!userId) continue;
    let username: string | undefined;
    let name: string | undefined;
    let avatarFileId: string | undefined;
    try {
      const chat = await bot.api.getChat(userId) as {
        type: string;
        username?: string;
        first_name?: string;
        last_name?: string;
      };
      if (chat.type === 'private') {
        username = chat.username;
        name = displayName(chat);
      }
    } catch (err) {
      log.debug(`Не удалось обновить имя Telegram ${userId}`, err);
    }
    try {
      const photos = await bot.api.getUserProfilePhotos(userId, { limit: 1 });
      avatarFileId = photos.photos[0]?.at(-1)?.file_id;
    } catch (err) {
      log.debug(`Не удалось обновить аватар Telegram ${userId}`, err);
    }
    if (username || name || avatarFileId) {
      store.setTelegramProfile(conversation.id, {
        tgUserId: userId,
        username,
        displayName: name,
        avatarFileId,
        avatarSourceId: sourceId,
      });
    }
  }
}

export class TelegramBotRegistry {
  private readonly entries = new Map<string, { bot: Bot; token: string; name: string }>();

  add(id: string, name: string, token: string, bot: Bot): void {
    this.entries.set(id, { bot, token, name });
  }

  first(): Bot | undefined { return this.entries.values().next().value?.bot; }
  all(): Bot[] { return [...this.entries.values()].map((entry) => entry.bot); }
  botBySource(sourceId?: string | null): Bot | undefined {
    if (sourceId && this.entries.has(sourceId)) return this.entries.get(sourceId)?.bot;
    const botId = sourceId?.includes(':business:') ? sourceId.split(':business:')[0] : undefined;
    return (botId ? this.entries.get(botId) : undefined)?.bot ?? this.first();
  }

  botFor(conversation: Conversation): Bot {
    const sourceId = conversation.avatar_source_id ?? conversation.source_id ?? 'telegram-default';
    const bot = this.botBySource(sourceId);
    if (!bot) throw new Error('Для Telegram-диалога не настроен бот');
    return bot;
  }

  tokenFor(sourceId?: string | null): string | undefined {
    if (sourceId && this.entries.has(sourceId)) return this.entries.get(sourceId)?.token;
    const botId = sourceId?.includes(':business:') ? sourceId.split(':business:')[0] : undefined;
    return (botId ? this.entries.get(botId) : undefined)?.token ?? this.entries.values().next().value?.token;
  }
}

export class TelegramDmSender implements ChannelSender {
  constructor(private readonly bots: Bot | TelegramBotRegistry) {}

  async send(conversation: Conversation, payload: SendPayload): Promise<SendResult> {
    if (!conversation.business_connection_id) {
      throw new Error(`У диалога ${conversation.id} не сохранён business_connection_id`);
    }
    const bot = this.bots instanceof TelegramBotRegistry ? this.bots.botFor(conversation) : this.bots;
    const sent = await bot.api.sendMessage(Number(conversation.remote_external_id ?? conversation.external_id), payload.text, {
      business_connection_id: conversation.business_connection_id,
      // allow_sending_without_reply: цитируемое сообщение могли удалить,
      // и терять из-за этого ответ оператора нельзя.
      ...(payload.replyToExternalId
        ? { reply_parameters: { message_id: Number(payload.replyToExternalId), allow_sending_without_reply: true } }
        : {}),
    });
    return { externalMsgId: String(sent.message_id) };
  }
}

export class TelegramBotSender implements ChannelSender {
  constructor(private readonly bots: Bot | TelegramBotRegistry) {}

  async send(conversation: Conversation, payload: SendPayload): Promise<SendResult> {
    const bot = this.bots instanceof TelegramBotRegistry ? this.bots.botFor(conversation) : this.bots;
    const sent = await bot.api.sendMessage(Number(conversation.remote_external_id ?? conversation.external_id), payload.text, {
      ...(payload.replyToExternalId
        ? { reply_parameters: { message_id: Number(payload.replyToExternalId), allow_sending_without_reply: true } }
        : {}),
    });
    return { externalMsgId: String(sent.message_id) };
  }
}

/** Помечает входящие прочитанными от имени аккаунта (право can_read_messages). */
export async function markReadInTelegram(
  bots: Bot | TelegramBotRegistry,
  conversation: Conversation,
  lastMessageId: number,
): Promise<void> {
  if (!conversation.business_connection_id) return;
  try {
    const bot = bots instanceof TelegramBotRegistry ? bots.botFor(conversation) : bots;
    await bot.api.readBusinessMessage(
      conversation.business_connection_id,
      Number(conversation.remote_external_id ?? conversation.external_id),
      lastMessageId,
    );
  } catch (err) {
    log.debug('Не удалось отметить прочитанным', err);
  }
}

export type { Context };
