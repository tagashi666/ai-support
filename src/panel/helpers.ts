import type { BedolagaClient, BedolagaTicketStatus } from '../channels/bedolaga.js';
import { minishopStatusForLocal, minishopTicketId, type MinishopClient } from '../channels/minishop.js';
import { log } from '../config.js';
import { avatarKey } from '../core/media.js';
import type { Operations } from '../core/operations.js';
import { StatusSyncError, type Outbox } from '../core/outbox.js';
import { replyWindow, type Channel, type Conversation, type Store } from '../core/store.js';
import { CHANNEL_IDS } from '../core/channels.js';

/** Вложение по id не меняется: файл пишется один раз и по имени из file_ref. */
export const IMMUTABLE_PRIVATE = 'private, max-age=31536000, immutable';

/** Совпадает ли ETag из If-None-Match; слабые и сильные варианты считаем равными. */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) return false;
  const bare = etag.replace(/^W\//, '');
  return value.split(',').some((item) => {
    const candidate = item.trim();
    return candidate === '*' || candidate.replace(/^W\//, '') === bare;
  });
}

/** Какие каналы подключены (есть отправитель) — `channels` в ответах API. */
export function channelAvailability(outbox: Outbox): Record<Channel, boolean> {
  return Object.fromEntries(CHANNEL_IDS.map((id) => [id, outbox.has(id)])) as Record<Channel, boolean>;
}

/** Диалог в виде для панели: окно ответа, источники, версия аватарки, совместная работа. */
export function decorate(conversation: Conversation, store: Store, operations?: Operations) {
  const window = replyWindow(conversation);
  const sourceIds = store.conversationSourceIds(conversation.id);
  const source = store.sourceAccount(conversation.source_id);
  return {
    ...conversation,
    // Версия аватарки для URL: меняется только вместе с самим файлом, поэтому
    // браузер держит картинку в кэше, сколько бы сообщений ни пришло.
    avatar_version: avatarKey(conversation.avatar_source_id ?? conversation.source_id, conversation.avatar_file_id),
    source_ids: sourceIds,
    source: source ? { id: source.id, kind: source.kind, name: source.name } : null,
    window: {
      applies: window.applies,
      open: window.open,
      msLeft: Number.isFinite(window.msLeft) ? window.msLeft : null,
    },
    ...(operations ? { collaboration: operations.collaboration(conversation.id) } : {}),
  };
}

/**
 * Подключает к Outbox передачу статуса во внешние тикеты Bedolaga и MiniShop.
 * Синхронизатор регистрируется и без клиента: тогда смена статуса такого
 * диалога отвечает 503, как и раньше.
 */
export function registerStatusSyncs(
  outbox: Outbox,
  { bedolaga, minishop }: { bedolaga?: BedolagaClient; minishop?: MinishopClient },
): void {
  outbox.registerStatusSync('bedolaga', async (conversation, status) => {
    if (!bedolaga) throw new StatusSyncError('Интеграция Bedolaga отключена', 503);
    // В Bedolaga `answered` означает «администратор ответил, ждём
    // клиента»; `pending` там — отдельное состояние «в обработке».
    const remoteStatus: BedolagaTicketStatus = status === 'resolved' ? 'closed' : status === 'pending' ? 'answered' : 'open';
    const remoteTicketId = Number(conversation.remote_external_id ?? conversation.external_id);
    if (!Number.isSafeInteger(remoteTicketId) || remoteTicketId <= 0) {
      throw new StatusSyncError('У диалога нет корректного ID тикета Bedolaga', 409);
    }
    try {
      await bedolaga.setStatus(remoteTicketId, remoteStatus);
    } catch (err) {
      log.error('Не удалось изменить статус тикета Bedolaga', err);
      throw new StatusSyncError(`Bedolaga не приняла статус: ${(err as Error).message}`, 502);
    }
  });
  outbox.registerStatusSync('minishop', async (conversation, status) => {
    if (!minishop) throw new StatusSyncError('Интеграция MiniShop отключена', 503);
    try {
      await minishop.setStatus(minishopTicketId(conversation), minishopStatusForLocal(status));
    } catch (err) {
      log.error('Не удалось изменить статус тикета MiniShop', err);
      throw new StatusSyncError(`MiniShop не принял статус: ${(err as Error).message}`, 502);
    }
  });
}

/**
 * Файл превысил предел размера. Отдельный тип вместо разбора текста ошибки:
 * маршрут загрузки отвечает на него 413, а не 502.
 */
export class UploadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Файл больше ${Math.floor(maxBytes / 1024 / 1024)} МБ`);
    this.name = 'UploadTooLargeError';
  }
}

/**
 * Пропускает поток загрузки, пока прочитано не больше `maxBytes`, и бросает
 * UploadTooLargeError на первом лишнем байте — до того, как его увидит запись
 * на диск.
 */
export async function* limitUploadBytes(source: AsyncIterable<Uint8Array>, maxBytes: number): AsyncGenerator<Uint8Array> {
  let bytes = 0;
  for await (const chunk of source) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new UploadTooLargeError(maxBytes);
    yield chunk;
  }
}
