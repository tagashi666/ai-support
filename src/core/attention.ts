import type Database from 'better-sqlite3';
import { computeAttention, unknownAttention, type Attention, type AttentionContext, type AttentionFacts } from '../shared/attention.js';
import { confidenceLevel } from '../shared/confidence.js';
import { runtime } from './settings.js';
import { CHANNELS } from './channels.js';
import { REPLY_WINDOW_MS, type Channel, type Conversation } from './store/types.js';

/**
 * Факты для состояния внимания (src/shared/attention.ts) одним запросом с
 * подзапросами: последнее исходящее, первое ожидающее входящее, живой
 * черновик помощника, срок по приоритету. Состояние не хранится в базе —
 * его считают на лету сервер (список, AttentionWatcher, счётчики «ждут»)
 * и одна и та же функция в src/shared.
 */

/** Время решения: то же выражение, что doneAt() в src/shared/attention.ts. */
export const DONE_AT_SQL = 'COALESCE(c.resolved_at, c.last_resolved_at, c.last_message_at, c.created_at)';

/** Диалоги, которые видит список: не скрытые и с перепиской (как GET /api/conversations). */
export const LISTED_SQL = `c.hidden_at IS NULL AND EXISTS (SELECT 1 FROM message lm WHERE lm.conversation_id = c.id)`;
export const OPEN_SQL = `c.status NOT IN ('resolved','closed')`;

export interface FactsRow extends Conversation {
  last_out_at: number | null;
  last_out_author: string | null;
  last_agent_out_at: number | null;
  inbound_waiting_since: number | null;
  draft_at: number | null;
  draft_confidence: number | null;
  draft_needs_human: number | null;
  draft_sources: string | null;
  draft_text: string | null;
  sla_minutes: number | null;
  last_message_id: number | null;
}

/**
 * SELECT строк с фактами. `where` и `tail` (ORDER/LIMIT) — фрагменты из
 * констант этого модуля и именованные параметры, ввод в текст не попадает.
 */
export function factsQuery(where: string, tail = ''): string {
  return `SELECT x.*,
       (SELECT MIN(r.created_at) FROM message r
         WHERE r.conversation_id = x.id AND r.direction = 'in' AND r.is_backfill = 0
           AND r.created_at > COALESCE(x.last_out_at, 0)
           AND r.created_at > COALESCE(x.last_resolved_at, 0)) AS inbound_waiting_since,
       (SELECT s.created_at FROM ai_suggestion s WHERE s.id = x.draft_id) AS draft_at,
       (SELECT s.confidence FROM ai_suggestion s WHERE s.id = x.draft_id) AS draft_confidence,
       (SELECT s.needs_human FROM ai_suggestion s WHERE s.id = x.draft_id) AS draft_needs_human,
       (SELECT s.sources FROM ai_suggestion s WHERE s.id = x.draft_id) AS draft_sources,
       (SELECT s.text FROM ai_suggestion s WHERE s.id = x.draft_id) AS draft_text
  FROM (
    SELECT c.*,
           (SELECT MAX(o.created_at) FROM message o WHERE o.conversation_id = c.id AND o.direction = 'out') AS last_out_at,
           (SELECT o.author FROM message o WHERE o.conversation_id = c.id AND o.direction = 'out'
             ORDER BY o.created_at DESC, o.id DESC LIMIT 1) AS last_out_author,
           (SELECT MAX(o.created_at) FROM message o
             WHERE o.conversation_id = c.id AND o.direction = 'out' AND o.author = 'agent') AS last_agent_out_at,
           (SELECT s.id FROM ai_suggestion s WHERE s.conversation_id = c.id AND s.status = 'pending'
             ORDER BY s.id DESC LIMIT 1) AS draft_id,
           (SELECT m.id FROM message m WHERE m.conversation_id = c.id AND m.direction != 'note'
             ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message_id,
           p.first_response_minutes AS sla_minutes,
           ${DONE_AT_SQL} AS done_at
      FROM conversation c LEFT JOIN sla_policy p ON p.priority = c.priority
     WHERE ${where}
     ${tail}
  ) x`;
}

const hasSources = (raw: string | null): boolean => {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
};

/** Строка базы → факты. Черновик живой, только если новее ответа человека и закрытия (как livePendingSuggestion). */
export function factsOf(row: FactsRow): AttentionFacts {
  const draftLive = row.draft_at !== null
    && row.draft_at > (row.last_agent_out_at ?? -1)
    && row.draft_at > (row.last_resolved_at ?? -1);
  const holdMs = runtime.humanHoldMinutes * 60_000;
  const holdUntil = holdMs > 0 && row.last_agent_out_at !== null
    && (row.last_resolved_at == null || row.last_resolved_at < row.last_agent_out_at)
    ? row.last_agent_out_at + holdMs : null;
  const windowApplies = CHANNELS[row.channel as Channel]?.replyWindow === true;
  return {
    id: row.id,
    status: row.status,
    priority: row.priority,
    escalated: Boolean(row.escalated),
    aiMode: row.ai_mode,
    handoffAt: row.handoff_at,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    resolvedAt: row.resolved_at,
    lastResolvedAt: row.last_resolved_at ?? null,
    inboundWaitingSince: row.inbound_waiting_since,
    lastOut: row.last_out_at !== null ? { at: row.last_out_at, author: row.last_out_author ?? 'system' } : null,
    lastAgentOutAt: row.last_agent_out_at,
    draft: draftLive ? {
      createdAt: row.draft_at!,
      unsure: confidenceLevel({
        score: row.draft_confidence,
        threshold: runtime.minConfidence,
        hasSources: hasSources(row.draft_sources),
        askedHuman: Boolean(row.draft_needs_human),
        gatePassed: false,
        hasText: Boolean(row.draft_text?.trim()),
      }) !== 'sure',
    } : null,
    holdUntil,
    windowClosesAt: windowApplies
      ? (row.last_inbound_at !== null ? row.last_inbound_at + REPLY_WINDOW_MS : row.created_at) : null,
    slaMinutes: row.sla_minutes,
  };
}

export const attentionContext = (now = Date.now()): AttentionContext => ({ now, globalAiMode: runtime.aiMode });

/** Состояние с «ошибкой в сторону внимания»: сбой расчёта не прячет диалог. */
export function attentionOf(facts: AttentionFacts, ctx: AttentionContext): Attention {
  try {
    return computeAttention(facts, ctx);
  } catch {
    return unknownAttention(facts, ctx);
  }
}

/** Открытые диалоги списка с фактами. `ids` — пересчёт только этих диалогов. */
export function openFactsRows(db: Database.Database, ids?: readonly number[]): FactsRow[] {
  if (ids && ids.length === 0) return [];
  const byIds = ids ? ` AND c.id IN (${ids.map((id) => Number(id)).filter(Number.isSafeInteger).join(',') || '0'})` : '';
  return db.prepare(factsQuery(`${LISTED_SQL} AND ${OPEN_SQL}${byIds}`)).all() as FactsRow[];
}

/**
 * «Ждут человека» (7.1 п.9): все needs_human — и свои, и у коллег, одинаково
 * для всех; скрытые не входят. Это totals.waiting в /api/stats,
 * Store.waitingCount, строка уведомления и counts.waiting в /api/inbox.
 */
export function countNeedsHuman(db: Database.Database, now = Date.now()): number {
  const ctx = attentionContext(now);
  let count = 0;
  for (const row of openFactsRows(db)) if (attentionOf(factsOf(row), ctx).state === 'needs_human') count += 1;
  return count;
}
