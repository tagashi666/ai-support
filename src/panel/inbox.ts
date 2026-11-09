import type Database from 'better-sqlite3';
import { avatarKey } from '../core/media.js';
import {
  attentionContext, attentionOf, DONE_AT_SQL, factsOf, factsQuery, LISTED_SQL, OPEN_SQL, openFactsRows, type FactsRow,
} from '../core/attention.js';
import { liveOwner, sectionFor } from '../shared/attention.js';
import { compareRank, doneAtOfRank, parseRank, rankOf } from '../shared/conversation-order.js';
import type {
  InboxCounts, InboxItem, InboxLast, InboxProjection, InboxView, LastAuthor, SectionCounts,
} from '../shared/api-types.js';
import type { Section } from '../shared/attention.js';

/**
 * Список новой панели (GET /api/inbox) и проекция строки для кадров
 * AttentionWatcher. Открытые диалоги считаются функцией src/shared на лету,
 * решённые сортируются в SQL по времени решения.
 */

const PREVIEW_MAX = 140;
const CHANNEL_VIEW: Record<string, InboxProjection['channel']> = { tg_bot: 'telegram', tg_dm: 'business', bedolaga: 'bedolaga', minishop: 'minishop' };
const AUTHOR: Record<string, LastAuthor> = { agent: 'operator', ai: 'assistant', system: 'system', client: 'client' };

export interface Names { name(key: string): string }

export function operatorNames(db: Database.Database): Names {
  const rows = db.prepare('SELECT id, name FROM operator_account').all() as { id: number; name: string }[];
  const byId = new Map(rows.map((row) => [row.id, row.name]));
  return {
    name(key: string): string {
      if (key === 'root') return 'Владелец';
      const id = Number(key.replace(/^op:/, ''));
      return byId.get(id) ?? 'Бывший оператор';
    },
  };
}

const cut = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
};

/** Факты → строка списка без полей получателя. Пакетом: превью, источники и папки — по одному запросу. */
export function projectRows(db: Database.Database, rows: readonly FactsRow[], now = Date.now()): InboxProjection[] {
  if (rows.length === 0) return [];
  const ctx = attentionContext(now);
  const names = operatorNames(db);
  const idList = rows.map((row) => row.id).join(',');
  const lastIds = rows.map((row) => row.last_message_id).filter((id): id is number => id !== null);
  const lastById = new Map((lastIds.length
    ? db.prepare(`SELECT id, direction, author, text, media_type, created_at FROM message WHERE id IN (${lastIds.join(',')})`).all()
    : []).map((row) => [(row as { id: number }).id, row as { id: number; direction: string; author: string; text: string | null; media_type: string | null; created_at: number }]));
  const sourceIds = new Map<number, string[]>();
  for (const row of db.prepare(`SELECT conversation_id, source_id FROM conversation_source WHERE conversation_id IN (${idList})`)
    .all() as { conversation_id: number; source_id: string }[]) {
    const list = sourceIds.get(row.conversation_id) ?? [];
    list.push(row.source_id);
    sourceIds.set(row.conversation_id, list);
  }
  const folderSources = db.prepare('SELECT folder_id, source_id FROM inbox_folder_source').all() as { folder_id: number; source_id: string }[];
  const sources = new Map((db.prepare('SELECT id, kind, name FROM source_account').all() as { id: string; kind: string; name: string }[])
    .map((source) => [source.id, source]));

  return rows.map((row) => {
    const facts = factsOf(row);
    const attention = attentionOf(facts, ctx);
    const message = row.last_message_id !== null ? lastById.get(row.last_message_id) : undefined;
    const last: InboxLast | null = message ? {
      author: message.direction === 'in' ? 'client' : AUTHOR[message.author] ?? 'system',
      kind: message.media_type ? message.media_type : 'text',
      text: cut(message.text ?? ''),
      at: message.created_at,
    } : null;
    const owner = liveOwner(row.assignee, row.claimed_at, now);
    const linked = new Set([...(sourceIds.get(row.id) ?? []), ...(row.source_id ? [row.source_id] : [])]);
    const folderIds = [...new Set(folderSources.filter((item) => linked.has(item.source_id)).map((item) => item.folder_id))].sort((a, b) => a - b);
    const source = row.source_id ? sources.get(row.source_id) : undefined;
    const closesAt = facts.windowClosesAt;
    const window = attention.state !== 'done' && closesAt !== null ? { open: closesAt > now, closes_at: closesAt } : null;
    return {
      id: row.id,
      state: attention.state,
      tier: attention.tier,
      reason: attention.reason,
      waiting_since: attention.waiting_since,
      sla: attention.sla,
      last,
      unread: row.unread,
      owner: owner ? { id: owner.key, name: names.name(owner.key), until: owner.until } : null,
      assignee: row.assignee ? { id: row.assignee, name: names.name(row.assignee) } : null,
      ai: attention.ai,
      window,
      flags: { important: Boolean(row.escalated), not_found: Boolean(row.suspicious), handoff: attention.handoff },
      priority: row.priority,
      status: row.status,
      source: source ? { id: source.id, kind: source.kind, name: source.name } : null,
      channel: CHANNEL_VIEW[row.channel] ?? 'telegram',
      folder_ids: folderIds,
      customer: {
        name: row.display_name,
        username: row.username,
        avatar_version: avatarKey(row.avatar_source_id ?? row.source_id, row.avatar_file_id),
      },
      activity_at: row.last_message_at ?? row.created_at,
      updated_at: row.updated_at,
    };
  });
}

/** Строка для получателя: секция и ранг зависят от живого закрепления и того, кто смотрит. */
export function materialize(item: InboxProjection, viewerKey: string): InboxItem {
  const section = sectionFor(item.state, item.owner?.id ?? null, viewerKey);
  const rank = rankOf({
    id: item.id,
    section,
    tier: item.tier,
    waitingSince: item.waiting_since,
    activityAt: item.activity_at,
    doneAt: item.state === 'done' ? item.reason.since ?? item.activity_at : item.activity_at,
  });
  return { ...item, section, rank };
}

/** Все открытые диалоги списка (для счётчиков и AttentionWatcher). */
export function openProjections(db: Database.Database, now = Date.now(), ids?: readonly number[]): InboxProjection[] {
  return projectRows(db, openFactsRows(db, ids), now);
}

export function countsFor(open: readonly InboxProjection[], viewerKey: string): InboxCounts {
  const sections: SectionCounts = { mine: 0, colleagues: 0, ai: 0, client: 0 };
  const byFolder: Record<string, number> = {};
  let waiting = 0;
  for (const item of open) {
    const section = sectionFor(item.state, item.owner?.id ?? null, viewerKey);
    if (section === 'done') continue;
    sections[section] += 1;
    if (item.state === 'needs_human') waiting += 1;
    if (section === 'mine') for (const folder of item.folder_ids) byFolder[folder] = (byFolder[folder] ?? 0) + 1;
  }
  return { waiting, open: open.length, sections, byFolder };
}

export interface InboxQuery {
  view: InboxView;
  section?: Section;
  source?: string;
  folder?: number;
  assignee?: string;
  only?: 'important' | 'not_found';
  q?: string;
  limit: number;
  cursor?: string;
}

/** Фильтры списка как SQL с именованными параметрами: значения в текст запроса не попадают. */
function filterSql(query: InboxQuery, viewerKey: string): { sql: string; params: Record<string, unknown> } {
  const parts: string[] = [];
  const params: Record<string, unknown> = {};
  if (query.source) {
    parts.push(`(c.source_id = @source OR EXISTS (SELECT 1 FROM conversation_source fs WHERE fs.conversation_id = c.id AND fs.source_id = @source))`);
    params.source = query.source;
  }
  if (query.folder !== undefined) {
    parts.push(`EXISTS (SELECT 1 FROM inbox_folder_source ff WHERE ff.folder_id = @folder AND (ff.source_id = c.source_id
      OR ff.source_id IN (SELECT fs.source_id FROM conversation_source fs WHERE fs.conversation_id = c.id)))`);
    params.folder = query.folder;
  }
  if (query.assignee === 'none') parts.push('c.assignee IS NULL');
  else if (query.assignee) {
    parts.push('c.assignee = @assignee');
    params.assignee = query.assignee === 'me' ? viewerKey : query.assignee;
  }
  if (query.only === 'important') parts.push('c.escalated = 1');
  if (query.only === 'not_found') parts.push('c.suspicious = 1');
  if (query.q) {
    parts.push(`(c.display_name LIKE @q ESCAPE '\\' OR c.username LIKE @q ESCAPE '\\' OR c.subject LIKE @q ESCAPE '\\')`);
    params.q = `%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  }
  return { sql: parts.map((part) => ` AND ${part}`).join(''), params };
}

/**
 * Страница списка. Открытые — расчёт на лету и сортировка рангом; решённые —
 * SQL по времени решения. Курсор — ранг последней строки; у каждой секции свой.
 */
export function listInbox(db: Database.Database, query: InboxQuery, viewerKey: string, now = Date.now()): { items: InboxItem[]; next: string | null; counts: InboxCounts } {
  const filter = filterSql(query, viewerKey);
  const open = openProjections(db, now);
  const counts = countsFor(open, viewerKey);
  const cursor = query.cursor ? parseRank(query.cursor) : null;

  if (query.view === 'resolved' || query.section === 'done') {
    const params: Record<string, unknown> = { ...filter.params, limit: query.limit + 1 };
    let after = '';
    if (cursor && cursor.section === 'done') {
      after = ` AND (${DONE_AT_SQL} < @cursorAt OR (${DONE_AT_SQL} = @cursorAt AND c.id < @cursorId))`;
      params.cursorAt = doneAtOfRank(cursor);
      params.cursorId = cursor.id;
    }
    const rows = db.prepare(factsQuery(`${LISTED_SQL} AND c.status IN ('resolved','closed')${filter.sql}${after}`,
      `ORDER BY ${DONE_AT_SQL} DESC, c.id DESC LIMIT @limit`)).all(params) as FactsRow[];
    const page = projectRows(db, rows.slice(0, query.limit), now).map((item) => materialize(item, viewerKey));
    return { items: page, next: rows.length > query.limit ? page[page.length - 1]?.rank ?? null : null, counts };
  }

  const allowed = filter.sql
    ? new Set((db.prepare(`SELECT c.id FROM conversation c WHERE ${LISTED_SQL} AND ${OPEN_SQL}${filter.sql}`).all(filter.params) as { id: number }[]).map((row) => row.id))
    : null;
  const section = query.view === 'waiting' ? 'mine' : query.section;
  const sorted = open
    .filter((item) => !allowed || allowed.has(item.id))
    .map((item) => materialize(item, viewerKey))
    .filter((item) => !section || item.section === section)
    .sort((a, b) => compareRank(a.rank, b.rank));
  const start = query.cursor ? sorted.findIndex((item) => item.rank > query.cursor!) : 0;
  const from = start < 0 ? sorted.length : start;
  const page = sorted.slice(from, from + query.limit);
  const next = from + query.limit < sorted.length ? page[page.length - 1]?.rank ?? null : null;
  return { items: page, next, counts };
}
