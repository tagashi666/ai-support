/**
 * «Знания» (6.6): чистые функции без сети — разбор статьи на название и
 * текст, «было → стало» по строкам, состояние статьи в списке, подписи
 * идей, черновик ввода на устройстве (7.8).
 */
import type { Key } from '@/i18n/ru';
import type { IdeaRejectReason, KbDoc } from '@shared/api-types';

/** Статья — markdown с первой строкой «# Название». */
export interface DocFields {
  title: string;
  body: string;
}

export function splitDoc(text: string): DocFields {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first >= 0 && /^#\s+/.test(lines[first] ?? '')) {
    return { title: (lines[first] ?? '').replace(/^#\s+/, '').trim(), body: lines.slice(first + 1).join('\n').replace(/^\n+/, '') };
  }
  return { title: '', body: text.replace(/\r\n/g, '\n') };
}

export function composeDoc(fields: DocFields): string {
  const body = fields.body.replace(/\r\n/g, '\n').replace(/^\n+/, '');
  const title = fields.title.replace(/\s+/g, ' ').trim();
  const text = title ? `# ${title}\n\n${body}` : body;
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** Тот же текст после разбора и сборки: так «есть правки» не зажигается от пустой строки в конце. */
export const normalizeDoc = (text: string): string => composeDoc(splitDoc(text));

export type DiffOp = { kind: 'same' | 'add' | 'del'; line: string };

/** «Было → стало» по строкам (LCS). Статьи короткие — квадратная таблица не страшна; длинные режем. */
export function lineDiff(before: string, after: string): DiffOp[] {
  const lines = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
  const a = lines(before);
  const b = lines(after);
  if (a.length * b.length > 4_000_000) {
    return [...a.map((line) => ({ kind: 'del' as const, line })), ...b.map((line) => ({ kind: 'add' as const, line }))];
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ kind: 'same', line: a[i]! }); i += 1; j += 1; }
    else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) { ops.push({ kind: 'del', line: a[i]! }); i += 1; }
    else { ops.push({ kind: 'add', line: b[j]! }); j += 1; }
  }
  while (i < a.length) { ops.push({ kind: 'del', line: a[i]! }); i += 1; }
  while (j < b.length) { ops.push({ kind: 'add', line: b[j]! }); j += 1; }
  return ops;
}

export function diffStats(ops: readonly DiffOp[]): { added: number; removed: number } {
  return { added: ops.filter((op) => op.kind === 'add').length, removed: ops.filter((op) => op.kind === 'del').length };
}

/** Состояние строки списка: опубликована / опубликована · есть правки / черновик (+ идея на проверке). */
export type ArticleState = 'published' | 'edited' | 'draft';

export interface ArticleRow {
  name: string;
  title: string;
  excerpt: string;
  updatedAt: number;
  state: ArticleState;
  /** Черновик — одновременно идея на проверке (6.6). */
  idea: boolean;
}

export function articleRows(kb: readonly KbDoc[], drafts: readonly KbDoc[], ideaFiles: ReadonlySet<string>): ArticleRow[] {
  const draftBy = new Map(drafts.map((doc) => [doc.name, doc]));
  const rows: ArticleRow[] = kb.map((doc) => {
    const draft = draftBy.get(doc.name);
    return {
      name: doc.name, title: draft?.title || doc.title, excerpt: draft?.excerpt ?? doc.excerpt,
      updatedAt: Math.max(doc.updatedAt, draft?.updatedAt ?? 0), state: draft ? 'edited' : 'published', idea: ideaFiles.has(doc.name),
    };
  });
  const published = new Set(kb.map((doc) => doc.name));
  for (const doc of drafts) {
    if (!published.has(doc.name)) {
      rows.push({ name: doc.name, title: doc.title, excerpt: doc.excerpt, updatedAt: doc.updatedAt, state: 'draft', idea: ideaFiles.has(doc.name) });
    }
  }
  return rows.sort((x, y) => y.updatedAt - x.updatedAt || x.title.localeCompare(y.title, 'ru'));
}

export type ArticleFilter = 'all' | 'published' | 'draft' | 'edited';

const norm = (text: string): string => text.toLowerCase().replace(/ё/g, 'е');

export function filterArticles(rows: readonly ArticleRow[], filter: ArticleFilter, query: string): ArticleRow[] {
  const q = norm(query.trim());
  return rows.filter((row) => (filter === 'all' || row.state === filter)
    && (!q || norm(row.title).includes(q) || norm(row.excerpt).includes(q) || norm(row.name).includes(q)));
}

export const STATE_LABEL: Record<ArticleState, Key> = {
  published: 'kb.state.published', edited: 'kb.state.edited', draft: 'kb.state.draft',
};

/** Откуда идея (`kb_candidate.source`). */
export function ideaSourceLabel(source: string): Key {
  switch (source) {
    case 'auto-learn': return 'kb.source.learn';
    case 'archive': return 'kb.source.archive';
    case 'panel': return 'kb.source.panel';
    case 'telegram-export': return 'kb.source.export';
    case 'feedback': return 'kb.source.feedback';
    default: return 'kb.source.other';
  }
}

export const REJECT_REASONS: readonly IdeaRejectReason[] = ['wrong', 'duplicate', 'too_specific', 'not_needed'];
export const REJECT_LABEL: Record<IdeaRejectReason, Key> = {
  wrong: 'kb.reject.wrong', duplicate: 'kb.reject.duplicate', too_specific: 'kb.reject.tooSpecific', not_needed: 'kb.reject.notNeeded',
};

/** Следующая идея после решения: та, что стояла после, иначе предыдущая; null — всё разобрано. */
export function nextIdeaId(ids: readonly number[], current: number): number | null {
  const index = ids.indexOf(current);
  const rest = ids.filter((id) => id !== current);
  if (!rest.length) return null;
  if (index < 0) return rest[0]!;
  return rest[Math.min(index, rest.length - 1)]!;
}

/** Черновик ввода на устройстве (7.8): редактор не теряет текст при обрыве, 401 и закрытии вкладки. */
export interface LocalDraft {
  title: string;
  body: string;
  /** Версия, от которой начали править; null — новая статья. */
  base: string | null;
  at: number;
}

const LOCAL_PREFIX = 'next.kb.';
const LOCAL_TTL = 14 * 24 * 60 * 60_000;

export function readLocalDraft(key: string, now: number, storage: Storage | null = safeStorage()): LocalDraft | null {
  try {
    const raw = storage?.getItem(LOCAL_PREFIX + key);
    if (!raw) return null;
    const value = JSON.parse(raw) as LocalDraft;
    if (typeof value.title !== 'string' || typeof value.body !== 'string' || now - Number(value.at) > LOCAL_TTL) return null;
    return value;
  } catch {
    return null;
  }
}

export function saveLocalDraft(key: string, value: LocalDraft, storage: Storage | null = safeStorage()): void {
  try { storage?.setItem(LOCAL_PREFIX + key, JSON.stringify(value)); } catch { /* без хранилища — только в памяти */ }
}

export function dropLocalDraft(key: string, storage: Storage | null = safeStorage()): void {
  try { storage?.removeItem(LOCAL_PREFIX + key); } catch { /* нечего чистить */ }
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** Шаблоны: короткое имя для «/» — 1–40 печатных символов, как проверяет сервер. */
export function validShortcut(value: string): boolean {
  const clean = value.trim();
  // eslint-disable-next-line no-control-regex
  return clean.length > 0 && clean.length <= 40 && !/[\u0000-\u001f\u007f]/u.test(clean);
}
