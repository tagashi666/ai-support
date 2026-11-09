import type Database from 'better-sqlite3';
import type { AssistantPause } from '../core/pause.js';
import type {
  ActivityItem, ActivityKind, ActivityReason, ActivityResponse, ActivityTotals, AssistantPauseView,
} from '../shared/api-types.js';

/**
 * «Что делал помощник» (план редизайна, 6.7 и 10.4 п.5): лента собирается из
 * того, что уже пишется, — черновиков (ai_suggestion), ответов помощника
 * (message.author = 'ai') и журнала event (ai_draft, ai_handoff, ai_blocked,
 * ai_error, ai_cancelled_operator, ai_skip_old, ai_feedback,
 * suggestion_rejected). Новых таблиц нет.
 */

export const ACTIVITY_LIMIT_MAX = 200;
const TEXT_MAX = 200;
/** ai_draft пишется сразу после черновика; запас — на случай медленной записи. */
const DRAFT_EVENT_SLACK_MS = 60_000;

export function pauseView(pause: AssistantPause | null): AssistantPauseView | null {
  if (!pause) return null;
  return { until: pause.until, at: pause.at, by: pause.by ? { id: pause.by, name: pause.byName ?? '' } : null };
}

/** Причина гейта (src/ai/gate.ts) словами для журнала → код для панели. */
export function reasonCode(reason: unknown): ActivityReason | null {
  if (typeof reason !== 'string' || !reason) return null;
  const text = reason.toLowerCase();
  if (text.includes('пауза помощника')) return 'pause';
  if (text.includes('пауза после ответа')) return 'hold';
  if (text.includes('ждёт специалиста')) return 'waiting_human';
  if (text.includes('просит человека')) return 'asked_human';
  if (text.includes('чувствительн')) return 'sensitive';
  if (text.includes('ниже порога')) return 'low_confidence';
  if (text.includes('базу знаний') || text.includes('базе знаний')) return 'no_kb';
  if (text.includes('на взводе')) return 'tone';
  if (text.includes('эскалирован')) return 'important';
  if (text.includes('автоответов')) return 'limit';
  if (text.includes('окно ответа')) return 'window';
  if (text.includes('уточняющий')) return 'clarify_again';
  if (text.includes('внутренн')) return 'internal_data';
  if (text.includes('не смог')) return 'error';
  if (text.startsWith('режим') || text.includes('теневой')) return 'mode';
  return 'other';
}

const clip = (text: string | null): string | null => {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX - 1)}…` : flat;
};

const payloadOf = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
};

const nameOf = (row: { display_name: string | null; username: string | null; conversation_id: number }): string =>
  row.display_name?.trim() || (row.username ? `@${row.username}` : `№${row.conversation_id}`);

interface SuggestionRow {
  id: number; conversation_id: number; text: string; status: string; created_at: number; decided_at: number | null;
  display_name: string | null; username: string | null; message_id: number | null; message_author: string | null;
}

interface EventRow {
  id: number; kind: string; conversation_id: number | null; payload: string | null; created_at: number;
  display_name: string | null; username: string | null;
}

const EVENT_KINDS: Record<string, ActivityKind> = {
  ai_handoff: 'handoff',
  ai_cancelled_operator: 'yielded',
  ai_blocked: 'blocked',
  ai_error: 'error',
  ai_skip_old: 'skipped_old',
};

export interface ActivityQuery {
  since: number;
  /** Только раньше этого момента (страницы); по умолчанию — сейчас. */
  before?: number;
  limit: number;
}

/** Итоги за период: тем же правилом, что и строки ленты. */
export function activityTotals(db: Database.Database, since: number, until = Date.now()): ActivityTotals {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN EXISTS (SELECT 1 FROM message m WHERE m.suggestion_id = s.id AND m.direction = 'out' AND m.author = 'ai') THEN 1 ELSE 0 END) AS auto,
      SUM(CASE WHEN s.status IN ('sent', 'edited', 'rejected', 'pending')
                AND NOT EXISTS (SELECT 1 FROM message m WHERE m.suggestion_id = s.id AND m.direction = 'out' AND m.author = 'ai') THEN 1 ELSE 0 END) AS drafts,
      SUM(CASE WHEN s.status = 'sent'
                AND NOT EXISTS (SELECT 1 FROM message m WHERE m.suggestion_id = s.id AND m.direction = 'out' AND m.author = 'ai') THEN 1 ELSE 0 END) AS draftsSent,
      SUM(CASE WHEN s.status = 'edited' THEN 1 ELSE 0 END) AS draftsEdited,
      SUM(CASE WHEN s.status = 'rejected' THEN 1 ELSE 0 END) AS draftsRejected
    FROM ai_suggestion s WHERE s.created_at >= ? AND s.created_at < ?
  `).get(since, until) as Partial<Record<keyof ActivityTotals, number | null>>;
  const handoffs = (db.prepare(`SELECT COUNT(*) AS n FROM event WHERE kind = 'ai_handoff' AND created_at >= ? AND created_at < ?`)
    .get(since, until) as { n: number }).n;
  return {
    auto: row.auto ?? 0,
    drafts: row.drafts ?? 0,
    draftsSent: row.draftsSent ?? 0,
    draftsEdited: row.draftsEdited ?? 0,
    draftsRejected: row.draftsRejected ?? 0,
    handoffs,
  };
}

/** Лента новые сверху: черновики и ответы плюс события, слитые по времени. */
export function listActivity(db: Database.Database, query: ActivityQuery, now = Date.now()): ActivityResponse {
  const before = query.before ?? now + 1;
  const { since, limit } = query;
  const suggestions = db.prepare(`
    SELECT s.id, s.conversation_id, s.text, s.status, s.created_at, s.decided_at, c.display_name, c.username,
           (SELECT m.id FROM message m WHERE m.suggestion_id = s.id AND m.direction = 'out' ORDER BY m.id DESC LIMIT 1) AS message_id,
           (SELECT m.author FROM message m WHERE m.suggestion_id = s.id AND m.direction = 'out' ORDER BY m.id DESC LIMIT 1) AS message_author
      FROM ai_suggestion s JOIN conversation c ON c.id = s.conversation_id
     WHERE s.created_at >= ? AND s.created_at < ?
       -- Заменённый черновик — не событие; но если помощник его отправил, это ответ.
       AND (s.status != 'superseded'
            OR EXISTS (SELECT 1 FROM message m WHERE m.suggestion_id = s.id AND m.direction = 'out' AND m.author = 'ai'))
     ORDER BY s.created_at DESC, s.id DESC LIMIT ?
  `).all(since, before, limit) as SuggestionRow[];
  const events = db.prepare(`
    SELECT e.id, e.kind, e.conversation_id, e.payload, e.created_at, c.display_name, c.username
      FROM event e JOIN conversation c ON c.id = e.conversation_id
     WHERE e.created_at >= ? AND e.created_at < ?
       AND e.kind IN (${Object.keys(EVENT_KINDS).map((kind) => `'${kind}'`).join(',')})
     ORDER BY e.created_at DESC, e.id DESC LIMIT ?
  `).all(since, before, limit) as EventRow[];

  // Решение гейта и отказы — по черновику; «Это неверно» — по сообщению.
  const oldest = suggestions.length ? suggestions[suggestions.length - 1]!.created_at : before;
  const side = db.prepare(`
    SELECT kind, payload FROM event
     WHERE created_at >= ? AND kind IN ('ai_draft', 'suggestion_rejected', 'ai_feedback')
  `).all(Math.max(0, Math.min(oldest, since) - DRAFT_EVENT_SLACK_MS)) as Array<{ kind: string; payload: string | null }>;
  const gate = new Map<number, { action: string; reason: unknown }>();
  const rejected = new Map<number, string>();
  const wrong = new Set<number>();
  for (const row of side) {
    const payload = payloadOf(row.payload);
    if (row.kind === 'ai_draft' && Number.isSafeInteger(payload['suggestion'])) {
      gate.set(payload['suggestion'] as number, { action: String(payload['action'] ?? ''), reason: payload['reason'] });
    } else if (row.kind === 'suggestion_rejected' && Number.isSafeInteger(payload['suggestion_id'])) {
      rejected.set(payload['suggestion_id'] as number, typeof payload['reason'] === 'string' ? payload['reason'] : '');
    } else if (row.kind === 'ai_feedback' && Number.isSafeInteger(payload['message'])) {
      wrong.add(payload['message'] as number);
    }
  }

  const items: ActivityItem[] = [];
  for (const row of suggestions) {
    const verdict = gate.get(row.id);
    const byAi = row.message_author === 'ai';
    let kind: ActivityKind;
    if (byAi) kind = 'auto';
    else if (row.status === 'sent') kind = 'draft_sent';
    else if (row.status === 'edited') kind = 'draft_edited';
    else if (row.status === 'rejected') kind = 'draft_rejected';
    else kind = verdict?.action === 'shadow' ? 'shadow' : 'draft';
    items.push({
      id: `s${row.id}`,
      at: row.created_at,
      kind,
      conversation_id: row.conversation_id,
      name: nameOf(row),
      text: clip(row.text),
      reason: kind === 'auto' ? null : reasonCode(verdict?.reason),
      reject_reason: kind === 'draft_rejected' ? (rejected.get(row.id) || null) : null,
      message_id: byAi ? row.message_id : null,
      suggestion_id: row.id,
      wrong: byAi && row.message_id !== null && wrong.has(row.message_id),
    });
  }
  for (const row of events) {
    const kind = EVENT_KINDS[row.kind];
    if (!kind || row.conversation_id === null) continue;
    const payload = payloadOf(row.payload);
    const reason = kind === 'handoff' ? reasonCode(payload['reason'])
      : kind === 'blocked' ? 'internal_data' : kind === 'error' ? 'error' : null;
    items.push({
      id: `e${row.id}`,
      at: row.created_at,
      kind,
      conversation_id: row.conversation_id,
      name: nameOf({ ...row, conversation_id: row.conversation_id }),
      text: null,
      reason,
      reject_reason: null,
      message_id: null,
      suggestion_id: Number.isSafeInteger(payload['suggestion']) ? payload['suggestion'] as number : null,
      wrong: false,
    });
  }
  items.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  const page = items.slice(0, limit);
  const full = suggestions.length === limit || events.length === limit;
  const last = page[page.length - 1];
  return {
    items: page,
    next: full && last ? last.at : null,
    totals: activityTotals(db, since, now + 1),
    since,
  };
}
