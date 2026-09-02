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
          this.store.markAttachmentDownloaded(item.id, path, bytes.byteLength);
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
