import { log } from '../config.js';
import { replyWindow, type Author, type Channel, type Conversation, type Store } from './store.js';

export interface SendPayload {
  text: string;
  /** Ответ на конкретное сообщение клиента. */
  replyToExternalId?: string;
  /** Текст цитаты для истории: оригинал может быть не у нас. */
  replyExcerpt?: string;
}

export interface SendResult {
  externalMsgId?: string;
}

export interface ChannelSender {
  send(conversation: Conversation, payload: SendPayload): Promise<SendResult>;
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

  async send(conversationId: number, payload: SendPayload, author: Author = 'agent', suggestionId?: number) {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error(`Диалог ${conversationId} не найден`);

    const text = payload.text.trim();
    if (!text) throw new Error('Пустое сообщение');

    if (!replyWindow(conversation).open) throw new WindowClosedError();

    const sender = this.senders.get(conversation.channel);
    if (!sender) throw new NoSenderError(conversation.channel);

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
}
