import { log } from '../config.js';
import { replyWindow, type Author, type Channel, type Conversation, type Store } from './store.js';
import { runtime } from './settings.js';

export interface SendPayload {
  text: string;
  /** Ответ на конкретное сообщение клиента. */
  replyToExternalId?: string;
  /** Текст цитаты для истории: оригинал может быть не у нас. */
  replyExcerpt?: string;
}

export interface SendResult {
  externalMsgId?: string;
  mediaType?: AttachmentPayload['mediaType'];
}

export interface AttachmentPayload {
  bytes: Buffer;
  fileName: string;
  mimeType: string;
  mediaType: 'photo' | 'animation' | 'video' | 'document';
  caption?: string;
  replyToExternalId?: string;
}

export interface ChannelSender {
  send(conversation: Conversation, payload: SendPayload): Promise<SendResult>;
  sendAttachment?(conversation: Conversation, payload: AttachmentPayload): Promise<SendResult>;
}

export class WindowClosedError extends Error {
  constructor() {
    super('Окно ответа закрыто: от клиента не было сообщений более 24 часов');
    this.name = 'WindowClosedError';
  }
}

export class NoSenderError extends Error {
  constructor(channel: Channel) {
    super(`Для канала ${channel} не подключён отправитель`);
    this.name = 'NoSenderError';
  }
}

/**
 * Оператор уже открыл диалог или начал отвечать. Это штатная отмена AI,
 * а не ошибка канала: модель не должна выигрывать гонку у человека.
 */
export class OperatorActiveError extends Error {
  constructor() {
    super('Диалог ведёт или недавно вёл оператор — отправка AI отменена');
    this.name = 'OperatorActiveError';
  }
}

/**
 * Единственная точка выхода наружу. Панель, AI и автоматика ходят только сюда
 * и никогда не дёргают Telegram или API бедолаги напрямую — иначе появятся
 * пути отправки в обход окна 24 часов и без записи в историю.
 */
export class Outbox {
  private readonly senders = new Map<Channel, ChannelSender>();

  constructor(private readonly store: Store) {}

  register(channel: Channel, sender: ChannelSender): void {
    this.senders.set(channel, sender);
    log.info(`Отправитель канала ${channel} зарегистрирован`);
  }

  has(channel: Channel): boolean {
    return this.senders.has(channel);
  }

  supportsAttachments(channel: Channel): boolean {
    return typeof this.senders.get(channel)?.sendAttachment === 'function';
  }

  async send(conversationId: number, payload: SendPayload, author: Author = 'agent', suggestionId?: number) {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error(`Диалог ${conversationId} не найден`);

    const text = payload.text.trim();
    if (!text) throw new Error('Пустое сообщение');

    if (!replyWindow(conversation).open) throw new WindowClosedError();

    const sender = this.senders.get(conversation.channel);
    if (!sender) throw new NoSenderError(conversation.channel);

    // Последний общий рубеж непосредственно перед внешним API. Responder
    // тоже проверяет эту метку до и после генерации, но только Outbox может
    // гарантировать правило для всех AI-путей: автоответа, handoff и reminder.
    if (author === 'ai') {
      if (this.store.operatorIsActive(conversationId)
          || this.store.humanHoldActive(conversationId, runtime.humanHoldMinutes)) {
        throw new OperatorActiveError();
      }
    }

    // Захватываем диалог ДО сетевого запроса. Пока Telegram или Bedolaga
    // отвечает, Responder уже видит человека и не отправит конкурентный ответ.
    if (author === 'agent') this.store.markOperatorActive(conversationId);

    const result = await sender.send(conversation, {
      text,
      replyToExternalId: payload.replyToExternalId,
      replyExcerpt: payload.replyExcerpt,
    });

    // Отправка уже произошла: запись обязана состояться, поэтому ошибки
    // хранилища здесь фатальны и не должны маскироваться.
    const recorded = this.store.recordOutbound({
      conversationId,
      author,
      text,
      externalMsgId: result.externalMsgId,
      suggestionId,
      replyToExternalId: payload.replyToExternalId,
      replyExcerpt: payload.replyExcerpt,
    });
    if (!recorded) throw new Error('Сообщение отправлено, но не записано в историю');
    return recorded;
  }


  async sendAttachment(
    conversationId: number,
    payload: AttachmentPayload,
    stored: { fileRef: string; localPath: string; bytes: number; sha256: string; width?: number; height?: number },
  ) {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error(`Диалог ${conversationId} не найден`);
    if (!replyWindow(conversation).open) throw new WindowClosedError();
    const sender = this.senders.get(conversation.channel);
    if (!sender) throw new NoSenderError(conversation.channel);
    if (!sender.sendAttachment) throw new Error(`Канал ${conversation.channel} не поддерживает отправку файлов`);
    this.store.markOperatorActive(conversationId);
    const result = await sender.sendAttachment(conversation, payload);
    const recorded = this.store.recordOutbound({
      conversationId, author: 'agent', text: payload.caption, mediaType: result.mediaType ?? payload.mediaType,
      externalMsgId: result.externalMsgId, replyToExternalId: payload.replyToExternalId,
    });
    if (!recorded) throw new Error('Файл отправлен, но не записан в историю');
    this.store.addLocalAttachment(recorded.message.id, {
      ...stored, mediaType: result.mediaType ?? payload.mediaType, mimeType: payload.mimeType, originalName: payload.fileName,
    });
    return recorded;
  }
}
