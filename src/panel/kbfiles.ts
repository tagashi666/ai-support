import { readdir, readFile, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { config } from '../config.js';

/**
 * Работа с файлами базы знаний из панели.
 *
 * Имя файла приходит от клиента, поэтому каждый путь проверяется на то, что
 * он действительно лежит внутри разрешённого каталога: без этого «../» в имени
 * даёт чтение и запись где угодно на диске.
 */
export type Area = 'kb' | 'draft';

export interface Doc {
  name: string;
  title: string;
  size: number;
  updatedAt: number;
}

function dirFor(area: Area): string {
  return area === 'kb' ? config.kbDir : config.draftDir;
}

function safePath(area: Area, name: string): string {
  const clean = basename(name);
  if (clean !== name) throw new Error('Недопустимое имя файла');
  if (!clean.endsWith('.md') || clean.startsWith('.')) {
    throw new Error('Разрешены только файлы .md');
  }
  const dir = resolve(dirFor(area));
  const full = resolve(dir, clean);
  if (!full.startsWith(dir + '/')) throw new Error('Недопустимое имя файла');
  return full;
}

function titleOf(text: string): string {
  const line = text.split('\n').find((l) => /^#\s+/.test(l));
  return line ? line.replace(/^#\s+/, '').trim() : '';
}

export async function listDocs(area: Area): Promise<Doc[]> {
  let names: string[];
  try {
    // Скрытые файлы (в т.ч. AppleDouble «._foo.md» от macOS) отбрасываем здесь:
    // иначе safePath ниже отвергает их исключением и роняет весь листинг.
    names = (await readdir(dirFor(area))).filter(
      (name) => name.toLowerCase().endsWith('.md') && !name.startsWith('.'),
    );
  } catch {
    return [];
  }
  // Один нечитаемый или пропавший файл не должен ронять весь список.
  const docs = await Promise.all(
    names.map(async (name): Promise<Doc | null> => {
      try {
        const full = safePath(area, name);
        const [text, info] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
        return {
          name,
          title: titleOf(text) || name.replace(/\.md$/i, ''),
          size: text.length,
          updatedAt: info.mtimeMs,
        };
      } catch {
        return null;
      }
    }),
  );
  return docs.filter((d): d is Doc => d !== null).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readDoc(area: Area, name: string): Promise<string> {
  return readFile(safePath(area, name), 'utf8');
}

export async function writeDoc(area: Area, name: string, text: string): Promise<void> {
  await mkdir(dirFor(area), { recursive: true });
  await writeFile(safePath(area, name), text, 'utf8');
}

export function removeDoc(area: Area, name: string): Promise<void> {
  return unlink(safePath(area, name));
}

/**
 * Публикация черновика: файл переезжает из draft в базу знаний.
 *
 * Копируем и удаляем, а не переименовываем. В Docker kb и data — два разных
 * bind-монтирования, то есть разные файловые системы, и rename между ними
 * падает с EXDEV. Копирование работает всегда и стоит на таких размерах ничего.
 */
export async function publishDraft(name: string): Promise<void> {
  const from = safePath('draft', name);
  const to = safePath('kb', name);
  const text = await readFile(from, 'utf8');
  await mkdir(config.kbDir, { recursive: true });
  await writeFile(to, text, 'utf8');
  await unlink(from);
}

/**
 * Проверяет, что каталоги базы знаний доступны на запись.
 *
 * Права — самая частая поломка: каталоги создаёт root, а контейнер работает
 * под uid 1000. Раньше это всплывало только при попытке опубликовать
 * черновик, и выглядело как неработающая кнопка.
 */
export async function checkWritable(): Promise<{ area: Area; dir: string; error: string }[]> {
  const problems: { area: Area; dir: string; error: string }[] = [];
  for (const area of ['kb', 'draft'] as Area[]) {
    const dir = dirFor(area);
    try {
      await mkdir(dir, { recursive: true });
      const probe = join(dir, `.write-test-${process.pid}`);
      await writeFile(probe, 'ok', 'utf8');
      await unlink(probe);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      problems.push({
        area,
        dir,
        error: code === 'EACCES' || code === 'EPERM'
          ? `нет прав на запись. На сервере выполните: chown -R 1000:1000 ${area === 'kb' ? 'kb' : 'data'}`
          : `${code ?? ''} ${(err as Error).message}`.trim(),
      });
    }
  }
  return problems;
}

export function slugFromTitle(title: string): string {
  const map: Record<string, string> = {
    а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
    н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',
    ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
  };
  const slug = title.toLowerCase().split('').map((ch) => map[ch] ?? ch).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return `${slug || 'statya'}.md`;
}
