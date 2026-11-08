/**
 * База знаний в промпт — кусками, а не целыми статьями.
 *
 * Раньше уходили до пяти статей целиком (каждая до AI_KB_CHARS): ~11 тыс.
 * символов на каждый ответ при лимите бесплатного тарифа ~8K токенов в
 * минуту. Модели нужен один-два раздела, где есть ответ. Статьи режутся
 * по заголовкам (иначе по абзацам), куски ранжируются теми же основами
 * слов, что и FTS-поиск, и в промпт идут лучшие в пределах общего бюджета.
 */
import type { KbHit } from '../core/store.js';
import { ftsTerms } from '../core/fts.js';

/** Целевой размер куска при нарезке по абзацам. */
export const CHUNK_TARGET = 900;

export interface ArticlePart {
  section?: string;
  body: string;
}

export interface KbChunk extends ArticlePart {
  /** Название статьи: по нему работают used, источники и статистика панели. */
  title: string;
  /** Место статьи в выдаче поиска (0 — лучшая). */
  rank: number;
  /** Порядок куска внутри статьи. */
  position: number;
  score: number;
}

/** Длинный текст без заголовков — по абзацам, склеивая до target. */
function byParagraphs(text: string, target: number): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const parts: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > target) {
      parts.push(current);
      current = '';
    }
    if (paragraph.length > target) {
      // Абзац-простыня: режем по предложениям.
      const sentences = paragraph.match(/[^.!?…]+[.!?…]*\s*/g) ?? [paragraph];
      for (const sentence of sentences) {
        if (current && current.length + sentence.length > target) { parts.push(current.trim()); current = ''; }
        current += sentence;
      }
      continue;
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Разделы по заголовкам ##/###; без заголовков или в длинном разделе — абзацы. */
export function splitArticle(body: string, target = CHUNK_TARGET): ArticlePart[] {
  const sections: { section?: string; lines: string[] }[] = [{ lines: [] }];
  for (const line of body.split('\n')) {
    const heading = /^#{1,4}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) sections.push({ section: heading[1]!.trim(), lines: [] });
    else sections.at(-1)!.lines.push(line);
  }
  const parts: ArticlePart[] = [];
  for (const { section, lines } of sections) {
    const text = lines.join('\n').trim();
    if (!text) continue;
    for (const piece of text.length > target ? byParagraphs(text, target) : [text]) parts.push({ section, body: piece });
  }
  return parts;
}

function stemsOf(text: string): string[] {
  return ftsTerms(text, 10_000);
}

/** Сколько основ запроса встречается в куске (префиксом, как `term*` в FTS). */
const matches = (word: string, term: string): boolean =>
  word.startsWith(term) || (word.length >= 4 && term.startsWith(word));

function scoreChunk(terms: string[], part: ArticlePart): number {
  if (!terms.length) return 0;
  const words = stemsOf(part.body);
  const heading = part.section ? stemsOf(part.section) : [];
  let score = 0;
  for (const term of terms) {
    if (words.some((word) => matches(word, term))) score += 1;
    if (heading.some((word) => matches(word, term))) score += 0.5;
  }
  return score;
}

/**
 * Лучшие куски найденных статей в пределах общего бюджета символов.
 * maxChunk — потолок на один кусок (совместимость с AI_KB_CHARS).
 * Порядок в выдаче — по статье и месту в ней: так связнее читается.
 */
export function selectChunks(hits: KbHit[], query: string, budget: number, maxChunk = Infinity): KbChunk[] {
  const terms = ftsTerms(query);
  const all: KbChunk[] = hits.flatMap((hit, rank) => splitArticle(hit.body).map((part, position) => {
    const body = part.body.length > maxChunk ? `${part.body.slice(0, maxChunk)}…` : part.body;
    // Небольшая прибавка за место статьи в поиске: при равенстве — лучшая статья.
    const score = scoreChunk(terms, part) + (hits.length - rank) / (hits.length * 4);
    return { title: hit.title, section: part.section, body, rank, position, score };
  }));
  if (!all.length || budget <= 0) return [];

  const ranked = [...all].sort((a, b) => b.score - a.score || a.rank - b.rank || a.position - b.position);
  const relevant = ranked.filter((chunk) => chunk.score >= 1);
  // Ни одно слово не совпало (короткий вопрос, фото): начало лучшей статьи.
  const pool = relevant.length ? relevant : ranked.filter((chunk) => chunk.rank === 0);

  const picked: KbChunk[] = [];
  let used = 0;
  for (const chunk of pool) {
    const size = chunk.title.length + (chunk.section?.length ?? 0) + chunk.body.length + 8;
    if (used + size > budget) continue;
    picked.push(chunk);
    used += size;
  }
  // Даже лучший кусок не влез — отдаём его обрезанным, без опоры модель хуже.
  if (!picked.length) {
    const best = pool[0]!;
    picked.push({ ...best, body: `${best.body.slice(0, Math.max(200, budget - best.title.length - 8))}…` });
  }
  return picked.sort((a, b) => a.rank - b.rank || a.position - b.position);
}
