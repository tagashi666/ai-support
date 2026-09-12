import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bot } from 'grammy';
import { config, log } from '../config.js';
import { TelegramBotRegistry } from '../channels/tgdm.js';
import type { Store } from './store.js';
import type { BedolagaClient } from '../channels/bedolaga.js';
import { AiProvider } from '../ai/provider.js';
import { readLimitedBody } from './http.js';

const VOICE_TYPES = new Set(['voice', 'audio', 'video_note']);

/** MIME удалённого файла нельзя надёжно вывести из Telegram file_id. */
function downloadedMediaMime(bytes: Buffer, mediaType: string | null): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && ['GIF87a','GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) {
    return ['video', 'video_sticker'].includes(mediaType ?? '') ? 'video/webm' : 'application/webm';
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  return undefined;
}

/**
 * Имя на диске никогда не берётся из БД или удалённого API. Даже если запись
 * вложения будет повреждена, наружу можно открыть только один из файлов с
 * именем, вычисленным из file_ref, внутри MEDIA_DIR.
 */
export function mediaPath(fileRef: string): string {
  const name = createHash('sha256').update(fileRef).digest('hex').slice(0, 32);
  return join(config.mediaDir, name);
}

/** Атомарная запись не следует по заранее подложенному симлинку назначения. */
export async function saveMediaFile(fileRef: string, bytes: Buffer): Promise<string> {
  await mkdir(config.mediaDir, { recursive: true });
  const target = mediaPath(fileRef);
  const temporary = join(
    config.mediaDir,
    `.attachment-${process.pid}-${randomBytes(12).toString('hex')}.tmp`,
  );
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
    return target;
  } catch (err) {
    await unlink(temporary).catch(() => undefined);
    throw err;
  }
}

export interface SavedUpload {
  fileRef: string;
  localPath: string;
  bytes: number;
  sha256: string;
  prefix: Buffer;
}

/**
 * Потоковая загрузка не держит 45 МБ в памяти. Лимит проверяется и по
 * Content-Length в HTTP-слое, и здесь по реально прочитанным байтам.
 */
export async function saveUploadedMedia(source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<SavedUpload> {
  await mkdir(config.mediaDir, { recursive: true });
  const fileRef = `local:${randomBytes(24).toString('hex')}`;
  const target = mediaPath(fileRef);
  const temporary = join(config.mediaDir, `.upload-${process.pid}-${randomBytes(12).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  const hash = createHash('sha256');
  const prefix: Buffer[] = [];
  let prefixBytes = 0;
  let bytes = 0;
  try {
    for await (const raw of source) {
      const chunk = Buffer.from(raw);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error(`Файл больше ${Math.floor(maxBytes / 1024 / 1024)} МБ`);
      if (prefixBytes < 512) {
        const part = chunk.subarray(0, 512 - prefixBytes);
        prefix.push(part); prefixBytes += part.byteLength;
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
    if (!bytes) throw new Error('Пустой файл');
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
    return { fileRef, localPath: target, bytes, sha256: hash.digest('hex'), prefix: Buffer.concat(prefix) };
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw err;
  }
}

export async function removeMediaFile(fileRef: string): Promise<void> {
  await unlink(mediaPath(fileRef)).catch(() => undefined);
}

export interface InspectedUpload { mimeType: string; mediaType: 'photo' | 'animation' | 'video' | 'document'; dangerous: boolean }

/** MIME из браузера — только подсказка. Для активного inline-контента
 * доверяем сигнатуре; всё неизвестное скачивается как octet-stream. */
export function inspectUpload(prefix: Buffer, declaredMime: string, name: string): InspectedUpload {
  let mimeType = 'application/octet-stream';
  let mediaType: InspectedUpload['mediaType'] = 'document';
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) {
    mimeType = 'image/jpeg'; mediaType = 'photo';
  } else if (prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) {
    mimeType = 'image/png'; mediaType = 'photo';
  } else if (prefix.length >= 12 && prefix.subarray(0, 4).toString('ascii') === 'RIFF'
      && prefix.subarray(8, 12).toString('ascii') === 'WEBP') {
    mimeType = 'image/webp'; mediaType = 'photo';
  } else if (prefix.length >= 6 && ['GIF87a','GIF89a'].includes(prefix.subarray(0, 6).toString('ascii'))) {
    mimeType = 'image/gif'; mediaType = 'animation';
  } else if (prefix.length >= 12 && prefix.subarray(4, 8).toString('ascii') === 'ftyp') {
    mimeType = 'video/mp4'; mediaType = 'video';
  } else if (prefix.length >= 4 && prefix.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) {
    mimeType = declaredMime.toLowerCase() === 'video/webm' ? 'video/webm' : 'application/webm';
    mediaType = mimeType === 'video/webm' ? 'video' : 'document';
  } else if (/^[\w.+-]+\/[\w.+-]+$/.test(declaredMime) && !/^(text\/html|image\/svg\+xml)$/i.test(declaredMime)) {
    mimeType = declaredMime.toLowerCase();
  }
  const dangerous = /\.(?:exe|msi|com|scr|bat|cmd|ps1|vbs|js|jar|apk|appimage)$/i.test(name)
    || (prefix.length >= 2 && prefix[0] === 0x4d && prefix[1] === 0x5a);
  return { mimeType, mediaType, dangerous };
}

/**
 * Открывает только обычный файл с ожидаемым хеш-именем. O_NOFOLLOW закрывает
 * финальную гонку с симлинком между проверкой и open(). Размер сверяется уже
 * по открытому дескриптору, поэтому подмена пути после open() не помогает.
 */
export async function openMediaFile(fileRef: string): Promise<FileHandle> {
  const path = mediaPath(fileRef);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > config.mediaMaxFileBytes) {
      throw new Error('Недопустимый файл вложения');
    }
    return handle;
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}

/**
 * Читает вложение через уже проверенный дескриптор. Все потребители, включая
 * AI, обязаны использовать file_ref, а не сохранённый в БД локальный путь.
 */
export async function readMediaFile(fileRef: string): Promise<Buffer> {
  const handle = await openMediaFile(fileRef);
  try {
    const bytes = await handle.readFile();
    if (bytes.byteLength > config.mediaMaxFileBytes) {
      throw new Error('Недопустимый файл вложения');
    }
    return bytes;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Скачивает вложения в фоне. Ссылки на файлы Telegram живут около часа, а у
 * бедолаги отдача закрыта токеном — в обоих случаях URL клиенту отдать нельзя,
 * поэтому файлы кладём к себе и раздаём через панель.
 */
export class MediaFetcher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly bot?: Bot | TelegramBotRegistry,
    private readonly bedolaga?: BedolagaClient,
    private readonly provider = new AiProvider(),
  ) {}

  start(intervalMs = 5_000): void {
    void this.drain();
    this.timer = setInterval(() => void this.drain(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async drain(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let saved = 0;
    try {
      await mkdir(config.mediaDir, { recursive: true });
      for (const item of this.store.pendingAttachments()) {
        this.store.bumpAttachmentAttempt(item.id);
        try {
          const bytes = await this.fetch(item.file_ref);
          if (!bytes) continue;
          if (this.store.mediaBytes() + bytes.byteLength > config.mediaMaxTotalBytes) {
            throw new Error(`Каталог вложений достиг лимита ${config.mediaMaxTotalBytes} байт`);
          }
          const path = await saveMediaFile(item.file_ref, bytes);
          this.store.markAttachmentDownloaded(
            item.id,
            path,
            bytes.byteLength,
            downloadedMediaMime(bytes, item.media_type),
          );
          saved += 1;

          if (config.transcribe.enabled && VOICE_TYPES.has(item.media_type ?? '')) {
            await this.transcribe(item.id, item.message_id, bytes, item.media_type ?? 'voice');
          }
        } catch (err) {
          log.debug(`Вложение ${item.file_ref} не скачалось`, err);
        }
      }
    } finally {
      this.running = false;
    }
    return saved;
  }

  /**
   * Голосовые — заметная часть обращений, а без расшифровки они для AI
   * невидимы: текста в сообщении нет, отвечать не на что.
   */
  private async transcribe(attachmentId: number, messageId: number, bytes: Buffer, kind: string): Promise<void> {
    try {
      const extension = kind === 'video_note' ? 'mp4' : 'ogg';
      const text = await this.provider.transcribe(bytes, `voice-${attachmentId}.${extension}`);
      if (!text) return;
      this.store.attachTranscript(messageId, text);
      log.info(`Голосовое ${attachmentId} расшифровано: ${text.slice(0, 60)}…`);
    } catch (err) {
      log.warn('Не удалось расшифровать голосовое', err);
    }
  }

  private async fetch(ref: string): Promise<Buffer | null> {
    if (ref.startsWith('bedolaga:')) {
      return this.bedolaga ? this.bedolaga.downloadMedia(ref.slice('bedolaga:'.length)) : null;
    }
    if (ref.startsWith('tg:')) {
      if (!this.bot) return null;
      const payload = ref.slice('tg:'.length);
      const separator = payload.indexOf(':');
      const sourceId = separator >= 0 ? decodeURIComponent(payload.slice(0, separator)) : undefined;
      const fileId = separator >= 0 ? payload.slice(separator + 1) : payload;
      const bot = this.bot instanceof TelegramBotRegistry ? this.bot.botBySource(sourceId) : this.bot;
      const token = this.bot instanceof TelegramBotRegistry ? this.bot.tokenFor(sourceId) : config.botToken;
      if (!bot || !token) return null;
      const file = await bot.api.getFile(fileId);
      if (!file.file_path) return null;
      const response = await fetch(
        `https://api.telegram.org/file/bot${token}/${file.file_path}`,
        { signal: AbortSignal.timeout(60_000) },
      );
      if (!response.ok) return null;
      return readLimitedBody(response, config.mediaMaxFileBytes);
    }
    return null;
  }
}
