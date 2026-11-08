import type { FastifyInstance, FastifyReply } from 'fastify';
import { gunzipSync } from 'node:zlib';
import { fetchAvatarFileId, TelegramBotRegistry } from '../../channels/tgdm.js';
import { config, log } from '../../config.js';
import { limitConcurrency, readLimitedBody } from '../../core/http.js';
import {
  ATTACHMENT_GAVE_UP, ATTACHMENT_SHOW_FAILED_AFTER, type Conversation, type StoredAttachment,
} from '../../core/store.js';
import { avatarKey, openMediaFile, readCachedAvatar, readMediaFile, saveCachedAvatar } from '../../core/media.js';
import { etagMatches, IMMUTABLE_PRIVATE } from '../helpers.js';
import type { RouteContext } from '../context.js';

const MEDIA_MIME: Record<string, string> = {
  photo: 'image/jpeg',
  video: 'video/mp4',
  voice: 'audio/ogg',
  audio: 'audio/mpeg',
  video_note: 'video/mp4',
  animation: 'video/mp4',
  sticker: 'image/webp',
  video_sticker: 'video/webm',
  tgs_sticker: 'application/gzip',
};

const MAX_TGS_JSON_BYTES = 2 * 1024 * 1024;

/** Распаковывает только самодостаточную Telegram-анимацию без внешних assets. */
function parseSafeTgs(bytes: Buffer): Record<string, unknown> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('Некорректный TGS');
  const raw = gunzipSync(bytes, { maxOutputLength: MAX_TGS_JSON_BYTES });
  const value = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Array.isArray(value.layers)
      || !Number.isFinite(Number(value.fr)) || Number(value.fr) <= 0 || Number(value.fr) > 120
      || !Number.isFinite(Number(value.w)) || Number(value.w) <= 0 || Number(value.w) > 2048
      || !Number.isFinite(Number(value.h)) || Number(value.h) <= 0 || Number(value.h) > 2048) {
    throw new Error('Недопустимая TGS-анимация');
  }
  const assets = Array.isArray(value.assets) ? value.assets : [];
  if (assets.some((asset) => asset && typeof asset === 'object'
      && ('p' in asset || 'u' in asset || 'e' in asset))) {
    throw new Error('Внешние assets в TGS запрещены');
  }
  let nodes = 0;
  const inspect = (item: unknown, depth: number): void => {
    if (depth > 48 || ++nodes > 100_000) throw new Error('TGS слишком сложный');
    if (typeof item === 'string' && item.length > 100_000) throw new Error('Строка TGS слишком длинная');
    if (Array.isArray(item)) for (const child of item) inspect(child, depth + 1);
    else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Недопустимый ключ TGS');
        inspect(child, depth + 1);
      }
    }
  };
  inspect(value, 0);
  return value;
}

/**
 * Telegram нередко отдаёт фотографии как application/octet-stream. При
 * X-Content-Type-Options: nosniff браузер закономерно отказывается рисовать
 * такой ответ в <img>, поэтому тип определяем по сигнатуре самих байтов.
 */
function imageMime(body: Buffer, declared: string | null): string | null {
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (body.length >= 12 && body.subarray(0, 4).toString('ascii') === 'RIFF'
      && body.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (body.length >= 6 && ['GIF87a', 'GIF89a'].includes(body.subarray(0, 6).toString('ascii'))) return 'image/gif';
  const mime = declared?.split(';', 1)[0]?.trim().toLowerCase();
  return mime && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime) ? mime : null;
}

/** Понятная оператору причина, без путей и file_id источника. */
function attachmentFailureText(error: string | null): string {
  const text = error ?? '';
  if (/file is too big|превысил предел|слишком большой/i.test(text)) return 'Файл больше лимита Telegram Bot API (20 МБ)';
  if (/лимита/i.test(text)) return 'Закончилось место для вложений (MEDIA_MAX_TOTAL_MB)';
  if (/HTTP 40[14]|wrong file_id|not found/i.test(text)) return 'Источник больше не отдаёт файл';
  if (/временно недоступен|timeout|aborted|fetch failed/i.test(text)) return 'Источник не отвечает';
  return 'Файл не удалось скачать';
}

/** Медиа: аватарки, вложения и TGS-анимации. */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store, bot } = ctx;

  app.get<{ Params: { id: string }; Querystring: { v?: string } }>('/api/conversations/:id/avatar', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    const key = conversation
      ? avatarKey(conversation.avatar_source_id ?? conversation.source_id, conversation.avatar_file_id)
      : null;
    if (!conversation?.avatar_file_id || !key) return reply.code(404).send();
    // Ключ — хэш file_id: та же версия означает тот же файл. Только URL с
    // актуальной версией кэшируется навсегда; без неё — с перепроверкой.
    const etag = `"av-${key}"`;
    const cacheControl = request.query.v === key ? IMMUTABLE_PRIVATE : 'private, no-cache';
    if (etagMatches(request.headers['if-none-match'], etag)) {
      return reply.code(304).header('etag', etag).header('cache-control', cacheControl).send();
    }
    const send = (body: Buffer, mime: string) => reply
      .header('etag', etag)
      .header('cache-control', cacheControl)
      .type(mime)
      .send(body);

    const cached = await readCachedAvatar(key);
    const cachedMime = cached ? imageMime(cached, null) : null;
    if (cached && cachedMime) return send(cached, cachedMime);
    if (!bot) return reply.code(404).send();
    const miss = avatarMisses.get(key);
    if (miss && miss.until > Date.now()) {
      return reply.code(miss.status).header('cache-control', `private, max-age=${miss.status === 404 ? 300 : 30}`).send();
    }
    // Один запрос к Telegram на ключ, сколько бы карточек ни ждали этот аватар,
    // и не больше трёх скачиваний одновременно: холодный кэш на 50 диалогов
    // иначе упирается в лимиты Bot API и часть аватарок не приходит.
    let job = avatarJobs.get(key);
    if (!job) {
      job = avatarSlots(() => downloadAvatar(conversation, key)).finally(() => avatarJobs.delete(key));
      avatarJobs.set(key, job);
    }
    const result = await job;
    if ('body' in result) return send(result.body, result.mime);
    avatarMisses.set(key, { status: result.status, until: Date.now() + (result.status === 404 ? 300_000 : 30_000) });
    return reply.code(result.status).header('cache-control', `private, max-age=${result.status === 404 ? 300 : 30}`).send();
  });

  type AvatarResult = { body: Buffer; mime: string } | { status: 404 | 502 };
  const avatarJobs = new Map<string, Promise<AvatarResult>>();
  const avatarMisses = new Map<string, { status: 404 | 502; until: number }>();
  const avatarSlots = limitConcurrency(3);

  async function downloadAvatar(conversation: Conversation, key: string): Promise<AvatarResult> {
    if (!bot || !conversation.avatar_file_id) return { status: 404 };
    const selectedBot = bot instanceof TelegramBotRegistry ? bot.botFor(conversation) : bot;
    const token = bot instanceof TelegramBotRegistry
      ? bot.tokenFor(conversation.avatar_source_id ?? conversation.source_id)
      : config.botToken;
    if (!token) return { status: 404 };
    try {
      let file;
      try {
        file = await selectedBot.api.getFile(conversation.avatar_file_id);
      } catch (err) {
        // Клиент сменил или удалил фото: старый file_id больше не принимается.
        // Берём актуальный id; новая версия аватара уйдёт в панель событием.
        if (!/wrong file_id|file is temporarily unavailable/i.test(String((err as Error)?.message)) || !conversation.tg_user_id) throw err;
        const fresh = await fetchAvatarFileId(selectedBot, conversation.tg_user_id);
        if (fresh && fresh !== conversation.avatar_file_id) {
          store.setConversationAvatar(conversation.id, fresh, conversation.avatar_source_id ?? conversation.source_id ?? undefined);
        } else if (!fresh) {
          store.clearConversationAvatar(conversation.id);
        }
        return { status: 404 };
      }
      if (!file.file_path) return { status: 404 };
      const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return { status: 502 };
      const body = await readLimitedBody(response, Math.min(config.mediaMaxFileBytes, 5 * 1024 * 1024));
      const mime = imageMime(body, response.headers.get('content-type'));
      if (!mime) return { status: 502 };
      // В кэш кладём только то, что прошло проверку типа. Ошибка записи не
      // мешает показать аватар: в худшем случае скачаем его ещё раз.
      await saveCachedAvatar(key, body).catch((err) => log.warn('Не удалось сохранить аватар в кэш', err));
      return { body, mime };
    } catch (err) {
      log.warn(`Не удалось загрузить аватар диалога ${conversation.id}`, err instanceof Error ? err.message : err);
      return { status: 502 };
    }
  }

  /**
   * Вложение уже есть в сообщении, но MediaFetcher ещё не положил файл на
   * диск. 202 + Retry-After отличает «подождите» от «нет такого», и панель
   * показывает скелетон вместо пустой рамки.
   */
  const pendingAttachment = (reply: FastifyReply, attachment: StoredAttachment) => {
    // Окончательный отказ или много неудач подряд: вместо вечного скелетона
    // панель получает причину и предлагает повторить вручную.
    if (attachment.next_attempt_at >= ATTACHMENT_GAVE_UP || attachment.attempts >= ATTACHMENT_SHOW_FAILED_AFTER) {
      return reply.code(424).header('cache-control', 'no-store')
        .header('x-attachment-error', encodeURIComponent(attachmentFailureText(attachment.last_error)))
        .send({ failed: true, error: attachmentFailureText(attachment.last_error) });
    }
    const wait = Math.max(1, Math.min(60, Math.ceil(((attachment.next_attempt_at ?? 0) - Date.now()) / 1000)));
    return reply.code(202).header('retry-after', String(wait)).header('cache-control', 'no-store')
      .send({ pending: true, retryAfter: wait });
  };

  app.post<{ Params: { id: string } }>('/api/attachments/:id/retry', async (request, reply) => {
    const id = Number(request.params.id);
    // Очередь вложений слушает событие attachment_retry и проходит сразу.
    if (!store.retryAttachment(id)) return reply.code(404).send({ error: 'Вложение уже скачано или не найдено' });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/attachments/:id', async (request, reply) => {
    const attachment = store.getAttachment(Number(request.params.id));
    if (!attachment) return reply.code(404).send({ error: 'Вложение не найдено' });
    if (!attachment.local_path) return pendingAttachment(reply, attachment);
    const etag = `"att-${attachment.id}-${attachment.bytes ?? 0}"`;
    if (etagMatches(request.headers['if-none-match'], etag)) {
      return reply.code(304).header('etag', etag).header('cache-control', IMMUTABLE_PRIVATE).send();
    }
    try {
      const handle = await openMediaFile(attachment.file_ref);
      const mime = attachment.mime_type ?? MEDIA_MIME[attachment.media_type ?? ''] ?? 'application/octet-stream';
      const inline = (
        ['photo', 'sticker'].includes(attachment.media_type ?? '')
          && /^image\/(?:jpeg|png|webp|gif)$/.test(mime)
      ) || (
        ['video', 'video_note', 'video_sticker'].includes(attachment.media_type ?? '') && /^video\/(?:mp4|webm)$/.test(mime)
      ) || (
        attachment.media_type === 'animation' && /^(?:image\/gif|video\/mp4)$/.test(mime)
      ) || (
        ['voice', 'audio'].includes(attachment.media_type ?? '') && /^audio\//.test(mime)
      );
      const safeName = encodeURIComponent(attachment.original_name ?? 'attachment.bin').replace(/'/g, '%27');
      return reply
        .header('cache-control', IMMUTABLE_PRIVATE)
        .header('etag', etag)
        .header('x-content-type-options', 'nosniff')
        .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${safeName}`)
        .type(inline ? mime : 'application/octet-stream')
        .send(handle.createReadStream({ autoClose: true }));
    } catch {
      // Путь и file_ref могут содержать чувствительные данные, поэтому в
      // ответ и журнал их не выводим. Повреждённая запись выглядит как 404.
      log.warn(`Вложение ${attachment.id}: файл отсутствует или небезопасен`);
      return reply.code(404).send({ error: 'Файл вложения недоступен' });
    }
  });

  app.get<{ Params: { id: string } }>('/api/attachments/:id/lottie', async (request, reply) => {
    const attachment = store.getAttachment(Number(request.params.id));
    if (!attachment || attachment.media_type !== 'tgs_sticker') {
      return reply.code(404).send({ error: 'TGS не найден' });
    }
    if (!attachment.local_path) return pendingAttachment(reply, attachment);
    const etag = `"tgs-${attachment.id}-${attachment.bytes ?? 0}"`;
    if (etagMatches(request.headers['if-none-match'], etag)) {
      return reply.code(304).header('etag', etag).header('cache-control', IMMUTABLE_PRIVATE).send();
    }
    try {
      const animation = parseSafeTgs(await readMediaFile(attachment.file_ref));
      return reply.header('cache-control', IMMUTABLE_PRIVATE).header('etag', etag).send(animation);
    } catch (err) {
      log.warn(`TGS-вложение ${attachment.id} отклонено: ${(err as Error).message}`);
      return reply.code(422).send({ error: 'TGS-анимация повреждена или небезопасна' });
    }
  });
}
