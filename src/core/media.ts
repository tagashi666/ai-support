import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { config, log } from '../config.js';
import { ATTACHMENT_SHOW_FAILED_AFTER, type Store } from './store.js';
import { mediaFileName, mediaPath } from './store/media-files.js';

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
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'application/gzip';
  return undefined;
}

// Имя файла вычисляется из file_ref — см. store/media-files.ts.
export { mediaPath };

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

const AVATAR_KEY = /^[a-f0-9]{32}$/;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/**
 * Ключ аватарки: хэш источника и file_id Telegram. Он же версия в URL и
 * имя файла в кэше — путь никогда не строится из пользовательского ввода.
 */
export function avatarKey(sourceId: string | null | undefined, fileId: string | null | undefined): string | null {
  if (!fileId) return null;
  return createHash('sha256').update(`${sourceId ?? ''}\0${fileId}`).digest('hex').slice(0, 32);
}

function avatarPath(key: string): string {
  if (!AVATAR_KEY.test(key)) throw new Error('Недопустимый ключ аватарки');
  return join(config.avatarDir, key);
}

/** Кэш читается так же осторожно, как вложения: без симлинков и не больше лимита. */
export async function readCachedAvatar(key: string): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await open(avatarPath(key), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > MAX_AVATAR_BYTES) return null;
    return await handle.readFile();
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function saveCachedAvatar(key: string, bytes: Buffer): Promise<void> {
  if (bytes.byteLength > MAX_AVATAR_BYTES) return;
  const target = avatarPath(key);
  await mkdir(config.avatarDir, { recursive: true, mode: 0o700 });
  const temporary = join(config.avatarDir, `.avatar-${process.pid}-${randomBytes(12).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } catch (err) {
    await unlink(temporary).catch(() => undefined);
    throw err;
  }
}

const ORPHAN_MIN_AGE_MS = 60 * 60_000;
const AVATAR_UNUSED_MS = 30 * 24 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
const SWEEP_START_DELAY_MS = 10 * 60_000;
// Сборщик трогает только файлы с нашими именами: если MEDIA_DIR по ошибке
// указывает на общий каталог (например, рядом с БД), чужое не пострадает.
const MEDIA_FILE_NAME = /^(?:[a-f0-9]{32}|\.(?:attachment|upload)-\d+-[a-f0-9]{24}\.tmp)$/;
const AVATAR_FILE_NAME = /^(?:[a-f0-9]{32}|\.avatar-\d+-[a-f0-9]{24}\.tmp)$/;

export interface OrphanSweepResult { media: number; avatars: number }

/** Удаляет подходящие файлы каталога; ошибки отдельных файлов — в лог. */
async function sweepDir(
  dir: string,
  pattern: RegExp,
  shouldRemove: (name: string, mtimeMs: number) => boolean,
): Promise<number> {
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => entry.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn(`Сборщик сирот: каталог ${dir} недоступен`, err instanceof Error ? err.message : err);
    }
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const path = join(dir, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || !shouldRemove(name, info.mtimeMs)) continue;
      await unlink(path);
      removed += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      log.warn(`Сборщик сирот: не удалось удалить ${name}`, err instanceof Error ? err.message : err);
    }
  }
  return removed;
}

/**
 * Сборщик сирот. В MEDIA_DIR удаляются файлы старше часа, на которые не
 * ссылается ни одна запись attachment (сообщение удалено, загрузка оборвалась
 * между записью файла и строкой в БД). Свежие не трогаем: между rename и
 * INSERT есть окно. В кэше аватарок удаляются только файлы, которые не нужны
 * ни одному диалогу и не обновлялись 30 дней.
 */
export async function sweepOrphanMedia(
  store: Store,
  now = Date.now(),
  dirs: { media: string; avatars: string } = { media: config.mediaDir, avatars: config.avatarDir },
): Promise<OrphanSweepResult> {
  // Ссылки читаются до обхода каталога: файл, появившийся позже, моложе часа.
  const media = new Set<string>();
  for (const row of store.mediaFileReferences()) {
    media.add(mediaFileName(row.file_ref));
    if (row.local_path) media.add(basename(row.local_path));
  }
  const avatars = new Set<string>();
  for (const row of store.avatarReferences()) {
    const key = avatarKey(row.source_id, row.file_id);
    if (key) avatars.add(key);
  }
  const sameDir = resolve(dirs.media) === resolve(dirs.avatars);
  const result: OrphanSweepResult = {
    media: await sweepDir(dirs.media, MEDIA_FILE_NAME, (name, mtimeMs) =>
      now - mtimeMs > ORPHAN_MIN_AGE_MS && !media.has(name) && !(sameDir && avatars.has(name))),
    avatars: 0,
  };
  if (!sameDir) {
    result.avatars = await sweepDir(dirs.avatars, AVATAR_FILE_NAME, (name, mtimeMs) =>
      name.startsWith('.')
        ? now - mtimeMs > ORPHAN_MIN_AGE_MS
        : now - mtimeMs > AVATAR_UNUSED_MS && !avatars.has(name));
  }
  return result;
}

/**
 * Откуда брать байты вложения. Каналы предоставляют свои источники, ядро про
 * конкретные каналы не знает: file_ref имеет вид `<prefix>:<ref>`, источник
 * получает ref уже без префикса. `null` — источник сейчас недоступен (повтор
 * позже), окончательный отказ — `MediaFetchError` с `permanent`.
 */
export interface MediaSource {
  readonly prefix: string;
  fetch(ref: string): Promise<Buffer | null>;
}

/** Расшифровка голосовых: реализует AI-провайдер, ядро зависит только от интерфейса. */
export interface Transcriber {
  transcribe(audio: Buffer, filename: string): Promise<string>;
}

/**
 * Скачивает вложения в фоне. Ссылки на файлы Telegram живут около часа, а у
 * бедолаги отдача закрыта токеном — в обоих случаях URL клиенту отдать нельзя,
 * поэтому файлы кладём к себе и раздаём через панель.
 */
export class MediaFetcher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private again = false;
  private stopped = false;
  private kickTimer: NodeJS.Timeout | undefined;
  private sweepStartTimer: NodeJS.Timeout | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private sweeping = false;
  // Вложение может прийти и без media_type у сообщения (альбомы, внешние
  // каналы), поэтому будим очередь на любое сообщение: проход дешёвый.
  private readonly onMessage = (): void => this.kick();

  private readonly sources = new Map<string, MediaSource>();
  private readonly transcriber?: Transcriber;

  constructor(
    private readonly store: Store,
    options: { sources?: MediaSource[]; transcriber?: Transcriber } = {},
  ) {
    for (const source of options.sources ?? []) this.register(source);
    this.transcriber = options.transcriber;
  }

  /** Источник отвечает за file_ref вида `<prefix>:<ref>`; повторная регистрация заменяет прежний. */
  register(source: MediaSource): this {
    this.sources.set(source.prefix, source);
    return this;
  }

  /**
   * Новое вложение качаем сразу по событию сообщения: иначе панель получала
   * WS-кадр с картинкой раньше, чем файл появлялся на диске, и до пяти секунд
   * опрашивала пустой ответ. Таймер остаётся подстраховкой для повторов.
   */
  start(intervalMs = 5_000): void {
    this.stopped = false;
    void this.drain();
    this.timer = setInterval(() => void this.drain(), intervalMs);
    // Сборщик сирот: через несколько минут после старта и затем раз в сутки.
    this.sweepStartTimer = setTimeout(() => void this.sweep(), SWEEP_START_DELAY_MS);
    this.sweepStartTimer.unref();
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
    this.store.on('message', this.onMessage);
    this.store.on('message_updated', this.onMessage);
    this.store.on('attachment_retry', this.onMessage);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.kickTimer = undefined;
    if (this.sweepStartTimer) clearTimeout(this.sweepStartTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepStartTimer = this.sweepTimer = undefined;
    this.store.off('message', this.onMessage);
    this.store.off('message_updated', this.onMessage);
    this.store.off('attachment_retry', this.onMessage);
  }

  private async sweep(): Promise<void> {
    if (this.stopped || this.sweeping) return;
    this.sweeping = true;
    try {
      const removed = await sweepOrphanMedia(this.store);
      if (removed.media || removed.avatars) {
        log.info(`Сборщик сирот: удалено вложений ${removed.media}, аватарок ${removed.avatars}`);
      }
    } catch (err) {
      log.warn('Сборщик сирот не отработал', err instanceof Error ? err.message : err);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Внеочередной проход очереди. Вызов во время текущего прохода не теряется:
   * drain повторится сразу после него, потому что запись вложения могла
   * появиться уже после выборки pendingAttachments.
   */
  kick(): void {
    if (this.stopped) return;
    if (this.running) { this.again = true; return; }
    if (this.kickTimer) return;
    // Отложенный запуск: событие сообщения приходит изнутри транзакции записи.
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined;
      void this.drain();
    }, 0);
  }

  async drain(): Promise<number> {
    if (this.running) { this.again = true; return 0; }
    this.running = true;
    this.again = false;
    let saved = 0;
    try {
      try {
        await mkdir(config.mediaDir, { recursive: true });
      } catch (err) {
        log.warn('Каталог вложений недоступен на запись', err instanceof Error ? err.message : err);
        return 0;
      }
      for (const item of this.store.pendingAttachments(20, Date.now(), config.transcribe.enabled)) {
        try {
          let bytes: Buffer;
          let path: string;
          let downloadedNow = false;
          try {
            // После неудачной расшифровки файл уже лежит локально. Берём его
            // повторно, не полагаясь на успевшую истечь ссылку Telegram.
            bytes = await readMediaFile(item.file_ref);
            path = mediaPath(item.file_ref);
          } catch {
            const downloaded = await this.fetch(item.file_ref);
            if (!downloaded) throw new Error('Источник вложения временно недоступен');
            if (this.store.mediaBytes() + downloaded.byteLength > config.mediaMaxTotalBytes) {
              throw new Error(`Каталог вложений достиг лимита ${config.mediaMaxTotalBytes} байт`);
            }
            bytes = downloaded;
            path = await saveMediaFile(item.file_ref, bytes);
            downloadedNow = true;
          }

          // Файл готов независимо от состояния Whisper: оператор должен
          // видеть и прослушивать его, а размер обязан попасть в квоту.
          this.store.markAttachmentDownloaded(
            item.id,
            path,
            bytes.byteLength,
            downloadedMediaMime(bytes, item.media_type),
          );
          if (downloadedNow) saved += 1;

          // Если провайдер недоступен, deferAttachment оставит отдельно
          // расшифровку в очереди, не скрывая уже скачанный файл.
          if (config.transcribe.enabled && VOICE_TYPES.has(item.media_type ?? '')) {
            await this.transcribe(item.id, item.message_id, bytes, item.media_type ?? 'voice');
          }
        } catch (err) {
          const permanent = isPermanentMediaError(err);
          const nextAttemptAt = this.store.deferAttachment(item.id, err, Date.now(), permanent);
          const reason = err instanceof Error ? err.message : String(err);
          // Первую неудачу и окончательный отказ видно в журнале без debug:
          // иначе «картинка не грузится» не с чем сопоставить.
          if (permanent || item.attempts === 0 || item.attempts + 1 === ATTACHMENT_SHOW_FAILED_AFTER) {
            log.warn(`Вложение ${item.id} не скачалось${permanent ? ' (окончательно)' : ''}: ${reason}`);
          } else {
            log.debug(`Вложение ${item.id} не скачалось, следующая попытка ${new Date(nextAttemptAt).toISOString()}: ${reason}`);
          }
        }
      }
    } finally {
      this.running = false;
      if (this.again) { this.again = false; this.kick(); }
    }
    return saved;
  }

  /**
   * Голосовые — заметная часть обращений, а без расшифровки они для AI
   * невидимы: текста в сообщении нет, отвечать не на что.
   */
  private async transcribe(attachmentId: number, messageId: number, bytes: Buffer, kind: string): Promise<void> {
    const extension = kind === 'video_note' ? 'mp4' : 'ogg';
    if (!this.transcriber) throw new Error('Расшифровка голосовых не подключена');
    const text = await this.transcriber.transcribe(bytes, `voice-${attachmentId}.${extension}`);
    if (!text?.trim()) throw new Error('Провайдер вернул пустую расшифровку голосового');
    this.store.attachTranscript(messageId, text);
    log.info(`Голосовое ${attachmentId} расшифровано: ${text.slice(0, 60)}…`);
  }

  private async fetch(ref: string): Promise<Buffer | null> {
    const separator = ref.indexOf(':');
    if (separator < 0) return null;
    const source = this.sources.get(ref.slice(0, separator));
    return source ? source.fetch(ref.slice(separator + 1)) : null;
  }
}

/** Ошибка источника, после которой повтор бессмыслен (файл удалён или слишком большой). */
export class MediaFetchError extends Error {
  constructor(message: string, readonly permanent: boolean) { super(message); }
}

/**
 * Bot API не отдаёт файлы больше 20 МБ, а лимит размера не изменится от повтора —
 * такие вложения повторять по 6 часов вечно незачем.
 */
export function isPermanentMediaError(err: unknown): boolean {
  if (err instanceof MediaFetchError) return err.permanent;
  const message = err instanceof Error ? err.message : String(err);
  return /file is too big|превысил предел|слишком большой/i.test(message);
}
