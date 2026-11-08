import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config, log } from '../../config.js';

/**
 * Имя на диске никогда не берётся из БД или удалённого API. Даже если запись
 * вложения будет повреждена, наружу можно открыть только один из файлов с
 * именем, вычисленным из file_ref, внутри MEDIA_DIR.
 *
 * Живёт здесь, а не в media.ts, чтобы хранилище могло удалять файлы без
 * импорта загрузчика (он тянет каналы и AI и сам зависит от Store).
 */
export function mediaPath(fileRef: string): string {
  return join(config.mediaDir, mediaFileName(fileRef));
}

/** Имя файла вложения внутри MEDIA_DIR. */
export function mediaFileName(fileRef: string): string {
  return createHash('sha256').update(fileRef).digest('hex').slice(0, 32);
}

/**
 * Удаляет файлы вложений в фоне. Вызывается уже после фиксации транзакции:
 * ошибка удаления только пишется в лог и не отменяет операцию — остаток
 * подберёт периодический сборщик сирот.
 */
export function unlinkMediaFiles(fileRefs: Iterable<string>): void {
  for (const fileRef of new Set(fileRefs)) {
    void unlink(mediaPath(fileRef)).catch((err: NodeJS.ErrnoException) => {
      if (err?.code === 'ENOENT') return;
      log.warn('Не удалось удалить файл вложения', err?.message ?? err);
    });
  }
}

/**
 * После фиксации удаления сообщений: стирает файлы тех file_ref, на которые
 * больше не ссылается ни одно вложение (один файл может быть общим у
 * нескольких записей с тем же file_ref).
 */
export function releaseMediaFiles(db: Database.Database, fileRefs: string[]): void {
  const refs = [...new Set(fileRefs)];
  if (!refs.length) return;
  try {
    const alive = new Set((db
      .prepare(`SELECT DISTINCT file_ref FROM attachment WHERE file_ref IN (${refs.map(() => '?').join(',')})`)
      .all(...refs) as Array<{ file_ref: string }>).map((row) => row.file_ref));
    unlinkMediaFiles(refs.filter((fileRef) => !alive.has(fileRef)));
  } catch (err) {
    log.warn('Не удалось проверить файлы удалённых вложений', err instanceof Error ? err.message : err);
  }
}
