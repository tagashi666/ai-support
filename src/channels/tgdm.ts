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

export function createBot(store: Store, options: { botInfo?: UserFromGetMe } = {}): Bot {
  const bot = new Bot(process.env.BOT_TOKEN!, options.botInfo ? { botInfo: options.botInfo } : undefined);

  // Подключение/отключение бота к бизнес-аккаунту.
  bot.on('business_connection', async (ctx) => {
    const bc = ctx.update.business_connection;
    store.saveBusinessConnection({
      id: bc.id,
      userId: bc.user.id,
      userChatId: bc.user_chat_id,
      isEnabled: bc.is_enabled,
      rights: bc.rights,
      connectedAt: bc.date * 1000,
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
    if (msg.from?.is_bot) return;

    const peerId = msg.chat.id;
    const media = extractMedia(msg);

    const recorded = store.recordInbound({
      channel: 'tg_dm',
      externalId: String(peerId),
      tgUserId: msg.from?.id ?? peerId,
      businessConnectionId: msg.business_connection_id,
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

    if (!recorded) {
      log.debug(`Повторная доставка сообщения ${msg.message_id} — пропущено`);
      return;
    }
    log.info(`Входящее из лички ${peerId} → диалог ${recorded.conversation.id}`);
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

  /**
   * Явный гард. grammY не смешивает business_message с message (проверено),
   * но если кто-то напишет самому боту — это не диалог поддержки, и молча
   * попадать в общую воронку такие сообщения не должны.
   */
  bot.on('message', (ctx) => {
    log.debug(`Прямое сообщение боту от ${ctx.from?.id} — игнорируется, вход только через аккаунт`);
  });

  bot.catch((err) => {
    log.error('Ошибка обработки апдейта', err.error);
  });

  return bot;
}

export class TelegramDmSender implements ChannelSender {
  constructor(private readonly bot: Bot) {}

  async send(conversation: Conversation, payload: SendPayload): Promise<SendResult> {
    if (!conversation.business_connection_id) {
      throw new Error(`У диалога ${conversation.id} не сохранён business_connection_id`);
    }
    const sent = await this.bot.api.sendMessage(Number(conversation.external_id), payload.text, {
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

/** Помечает входящие прочитанными от имени аккаунта (право can_read_messages). */
export async function markReadInTelegram(
  bot: Bot,
  conversation: Conversation,
  lastMessageId: number,
): Promise<void> {
  if (!conversation.business_connection_id) return;
  try {
    await bot.api.readBusinessMessage(
      conversation.business_connection_id,
      Number(conversation.external_id),
      lastMessageId,
    );
  } catch (err) {
    log.debug('Не удалось отметить прочитанным', err);
  }
}

export type { Context };
