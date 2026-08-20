import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bot } from 'grammy';
import { config, log } from '../config.js';
import type { Store } from './store.js';
import type { BedolagaClient } from '../channels/bedolaga.js';
import { AiProvider } from '../ai/provider.js';
import { readLimitedBody } from './http.js';

const VOICE_TYPES = new Set(['voice', 'audio', 'video_note']);

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
    private readonly bot: Bot,
    private readonly bedolaga?: BedolagaClient,
    private readonly provider = new AiProvider(),
  ) {}

  start(intervalMs = 15_000): void {
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
          const name = createHash('sha256').update(item.file_ref).digest('hex').slice(0, 32);
          const path = join(config.mediaDir, name);
          await writeFile(path, bytes);
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
      const file = await this.bot.api.getFile(ref.slice('tg:'.length));
      if (!file.file_path) return null;
      const response = await fetch(
        `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`,
        { signal: AbortSignal.timeout(60_000) },
      );
      if (!response.ok) return null;
      return readLimitedBody(response, config.mediaMaxFileBytes);
    }
    return null;
  }
}
