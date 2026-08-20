import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, log } from '../config.js';
import type { Store } from '../core/store.js';
import type { BedolagaClient } from '../channels/bedolaga.js';

/** Первый заголовок markdown — название документа, остальное тело. */
function splitMarkdown(name: string, raw: string): { title: string; body: string } {
  const lines = raw.split('\n');
  const headingIndex = lines.findIndex((line) => /^#\s+/.test(line));
  if (headingIndex === -1) return { title: name.replace(/\.md$/i, ''), body: raw.trim() };
  return {
    title: lines[headingIndex]!.replace(/^#\s+/, '').trim(),
    body: lines.slice(headingIndex + 1).join('\n').trim(),
  };
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export async function syncKbFromFiles(store: Store, dir = config.kbDir): Promise<number> {
  let names: string[];
  try {
    // Скрытые файлы (напр. AppleDouble «._foo.md» от macOS) — бинарный мусор,
    // а не документы: не индексируем их как базу знаний.
    names = (await readdir(dir)).filter(
      (name) => name.toLowerCase().endsWith('.md') && !name.startsWith('.'),
    );
  } catch {
    log.debug(`Каталог базы знаний ${dir} не найден — пропускаю`);
    return 0;
  }

  const docs = [];
  for (const name of names) {
    const raw = await readFile(join(dir, name), 'utf8');
    const { title, body } = splitMarkdown(name, raw);
    if (body) docs.push({ extId: name, title, body });
  }
  store.syncKb('files', docs);
  return docs.length;
}

/**
 * FAQ из админки бедолаги. Правка там подхватывается следующей синхронизацией,
 * отдельного хранилища держать не нужно.
 */
export async function syncKbFromBedolaga(store: Store, client: BedolagaClient): Promise<number> {
  const { items } = await client.faqPages(config.bedolaga.language);
  const docs = [];
  for (const item of items ?? []) {
    const title = String(item['title'] ?? item['question'] ?? '').trim();
    const body = stripHtml(String(item['content'] ?? item['text'] ?? item['answer'] ?? ''));
    const extId = String(item['id'] ?? title);
    if (title && body) docs.push({ extId, title, body });
  }
  store.syncKb('bedolaga_faq', docs);
  return docs.length;
}
