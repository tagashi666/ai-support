import type { Channel, SourceAccount } from './store/types.js';

/**
 * Описание канала: всё, чем каналы различаются для ядра и панели. Набор
 * каналов закрыт (CHECK в SQL), поэтому вместо ветвлений `channel === …`
 * по коду — один справочник.
 */
export interface ChannelInfo {
  readonly id: Channel;
  /** Подпись для людей: в уведомлениях оператору. */
  readonly label: string;
  /** Префикс file_ref вложений; по нему MediaFetcher выбирает MediaSource. */
  readonly mediaPrefix: string;
  /** Диалог Telegram: профиль клиента (имя, аватарка) берётся через Bot API. */
  readonly telegram: boolean;
  /** Действует 24-часовое окно ответа (Telegram Business). */
  readonly replyWindow: boolean;
  /** Источник, к которому относим диалог, если вход не указал свой. */
  readonly defaultSource: { readonly id: string; readonly kind: SourceAccount['kind'] };
}

// Порядок ключей — порядок каналов в ответах API (`channels: {…}`).
export const CHANNELS: Readonly<Record<Channel, ChannelInfo>> = {
  tg_dm: {
    id: 'tg_dm',
    label: 'личка Business',
    mediaPrefix: 'tg',
    telegram: true,
    replyWindow: true,
    defaultSource: { id: 'telegram-default', kind: 'telegram_business' },
  },
  tg_bot: {
    id: 'tg_bot',
    label: 'личка бота',
    mediaPrefix: 'tg',
    telegram: true,
    replyWindow: false,
    defaultSource: { id: 'telegram-default', kind: 'telegram_bot' },
  },
  bedolaga: {
    id: 'bedolaga',
    label: 'тикет',
    mediaPrefix: 'bedolaga',
    telegram: false,
    replyWindow: false,
    defaultSource: { id: 'bedolaga-default', kind: 'bedolaga' },
  },
  minishop: {
    id: 'minishop',
    label: 'тикет',
    mediaPrefix: 'minishop',
    telegram: false,
    replyWindow: false,
    defaultSource: { id: 'minishop-default', kind: 'minishop' },
  },
};

export const CHANNEL_IDS = Object.keys(CHANNELS) as Channel[];

/**
 * file_ref вложения: по префиксу MediaFetcher выбирает источник, а media.ts
 * вычисляет из него имя файла. Для Telegram в ссылку входит бот-источник.
 * Без канала (диалог не найден) — как у Telegram.
 */
export function attachmentFileRef(channel: Channel | undefined, fileId: string, telegramSourceId?: string | null): string {
  const info = CHANNELS[channel ?? 'tg_dm'];
  if (!info.telegram) return `${info.mediaPrefix}:${fileId}`;
  return `${info.mediaPrefix}:${encodeURIComponent(telegramSourceId ?? info.defaultSource.id)}:${fileId}`;
}
