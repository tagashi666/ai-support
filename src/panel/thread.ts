import type Database from 'better-sqlite3';
import { factsQuery, type FactsRow } from '../core/attention.js';
import type { Operations } from '../core/operations.js';
import type { Outbox } from '../core/outbox.js';
import { runtime } from '../core/settings.js';
import {
  ATTACHMENT_GAVE_UP, ATTACHMENT_SHOW_FAILED_AFTER, replyWindow, type Conversation, type Message, type Store, type Suggestion,
} from '../core/store.js';
import type {
  ThreadAttachment, ThreadEvent, ThreadHead, ThreadMessage, ThreadPresence, ThreadSuggestion,
} from '../shared/api-types.js';
import { confidenceLevel } from '../shared/confidence.js';
import { materialize, operatorNames, projectRows, type Names } from './inbox.js';

/**
 * Диалог для новой панели (план редизайна, 6.3 и 10.3): явная проекция
 * сообщений, вложений, черновика помощника и событий. Служебные поля строки
 * диалога и сообщения (sub_link, tg_user_id, media_file_id, sender_tg_user_id,
 * business_connection_id) сюда не попадают.
 */

/** Событие журнала: кто из команды отправил сообщение (10.3 п.3). Без миграции: откат образа остаётся возможным. */
export const AUTHOR_EVENT = 'operator_reply';

const VOICE = (message: Pick<Message, 'direction' | 'author'>): ThreadMessage['voice'] => {
  if (message.direction === 'note') return 'note';
  if (message.direction === 'in') return 'client';
  if (message.author === 'ai') return 'assistant';
  if (message.author === 'system') return 'auto';
  return 'operator';
};

const parseJson = (raw: string | null): unknown => {
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
};

interface AttachmentRow {
  id: number;
  message_id: number;
  media_type: string | null;
  width: number | null;
  height: number | null;
  original_name: string | null;
  mime_type: string | null;
  bytes: number | null;
  ready: number;
  next_attempt_at: number | null;
  attempts: number | null;
}

function attachmentsOf(db: Database.Database, ids: readonly number[]): Map<number, ThreadAttachment[]> {
  const grouped = new Map<number, ThreadAttachment[]>();
  if (ids.length === 0) return grouped;
  const rows = db.prepare(`SELECT id, message_id, media_type, width, height, original_name, mime_type, bytes,
      local_path IS NOT NULL AS ready, next_attempt_at, attempts
      FROM attachment WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids) as AttachmentRow[];
  for (const row of rows) {
    const failed = !row.ready && ((row.next_attempt_at ?? 0) >= ATTACHMENT_GAVE_UP || (row.attempts ?? 0) >= ATTACHMENT_SHOW_FAILED_AFTER);
    const list = grouped.get(row.message_id) ?? [];
    list.push({
      id: row.id,
      kind: row.media_type ?? 'document',
      width: row.width,
      height: row.height,
      name: row.original_name,
      mime: row.mime_type,
      bytes: row.bytes,
      state: row.ready ? 'ready' : failed ? 'failed' : 'pending',
    });
    grouped.set(row.message_id, list);
  }
  return grouped;
}

/** Авторы-люди исходящих сообщений по событиям журнала. */
function authorsOf(db: Database.Database, conversationId: number, messages: readonly Message[], names: Names): Map<number, { id: string; name: string }> {
  const found = new Map<number, { id: string; name: string }>();
  const own = messages.filter((message) => message.direction === 'out' && message.author === 'agent');
  if (own.length === 0) return found;
  const from = Math.min(...own.map((message) => message.created_at));
  const rows = db.prepare(`SELECT payload FROM event WHERE kind = ? AND conversation_id = ? AND created_at >= ?`)
    .all(AUTHOR_EVENT, conversationId, from) as { payload: string | null }[];
  for (const row of rows) {
    const payload = parseJson(row.payload) as { message_id?: unknown; actor?: unknown } | null;
    if (!payload || typeof payload.message_id !== 'number' || typeof payload.actor !== 'string') continue;
    found.set(payload.message_id, { id: payload.actor, name: names.name(payload.actor) });
  }
  return found;
}

export function projectMessages(db: Database.Database, conversationId: number, messages: readonly Message[]): ThreadMessage[] {
  if (messages.length === 0) return [];
  const names = operatorNames(db);
  const attachments = attachmentsOf(db, messages.map((message) => message.id));
  const authors = authorsOf(db, conversationId, messages, names);
  return messages.map((message) => ({
    id: message.id,
    voice: VOICE(message),
    text: message.text,
    at: message.created_at,
    kind: message.media_type ?? 'text',
    author: authors.get(message.id) ?? null,
    quote: message.reply_excerpt,
    quote_id: message.direction === 'in' && message.external_msg_id ? message.external_msg_id : null,
    suggestion_id: message.suggestion_id,
    attachments: attachments.get(message.id) ?? [],
  }));
}

export function projectSuggestion(suggestion: Suggestion | null | undefined): ThreadSuggestion | null {
  if (!suggestion) return null;
  const parsed = parseJson(suggestion.sources);
  const sources = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  return {
    id: suggestion.id,
    text: suggestion.text,
    confidence: suggestion.confidence,
    level: confidenceLevel({
      score: suggestion.confidence,
      threshold: runtime.minConfidence,
      hasSources: sources.length > 0,
      askedHuman: Boolean(suggestion.needs_human),
      gatePassed: false,
      hasText: Boolean(suggestion.text?.trim()),
    }),
    needs_human: Boolean(suggestion.needs_human),
    reason: suggestion.reason,
    operator_note: suggestion.operator_note ?? null,
    sources,
    model: suggestion.model,
    status: suggestion.status,
    created_at: suggestion.created_at,
    message_id: suggestion.message_id,
  };
}

interface AuditRow { id: number; actor_key: string; action: string; payload: string | null; created_at: number }

/**
 * События ленты из журнала действий (смена статуса, передачи, режима,
 * важности, скрытия) и передача человеку помощником. Журнал пишет любое
 * успешное изменение (хук onResponse в server.ts), поэтому событие есть и у
 * действий из классики.
 */
export function threadEvents(db: Database.Database, conversation: Conversation, since: number): ThreadEvent[] {
  const names = operatorNames(db);
  const rows = db.prepare(`SELECT id, actor_key, action, payload, created_at FROM audit_log
      WHERE resource = 'conversations' AND resource_id = ? AND created_at > ?
        AND (action = ? OR action = 'conversation.claim')
      ORDER BY id LIMIT 500`)
    .all(String(conversation.id), since, `POST /api/conversations/${conversation.id}/state`) as AuditRow[];
  const events: ThreadEvent[] = [];
  for (const row of rows) {
    const actor = { id: row.actor_key, name: names.name(row.actor_key) };
    const body = (parseJson(row.payload) ?? {}) as Record<string, unknown>;
    const push = (kind: ThreadEvent['kind'], extra: Partial<ThreadEvent> = {}): void => {
      events.push({ id: `a${row.id}${kind}`, at: row.created_at, kind, actor, ...extra });
    };
    if (row.action === 'conversation.claim') {
      if (body.force === true) push('claimed');
      continue;
    }
    if (body.handoff === true) push('took');
    if (body.handoff === false) push('returned');
    if (body.status === 'resolved') push('resolved');
    if (body.status === 'pending') push('pending');
    if (body.status === 'open') push('reopened');
    if (body.escalated === true) push('important');
    if (body.escalated === false) push('unimportant');
    if (body.hidden === true) push('hidden');
    if (body.hidden === false) push('unhidden');
    if (typeof body.aiMode === 'string') push('mode', { mode: body.aiMode });
  }
  // Передача помощником: момент handoff_at без «взял себе» человека рядом.
  const handoffAt = conversation.handoff_at;
  if (handoffAt !== null && handoffAt > since && !events.some((event) => event.kind === 'took' && Math.abs(event.at - handoffAt) < 5000)) {
    events.push({ id: `h${handoffAt}`, at: handoffAt, kind: 'handoff', actor: null });
  }
  return events.sort((a, b) => a.at - b.at);
}

function presenceOf(operations: Operations, conversationId: number): ThreadPresence[] {
  const collaboration = operations.collaboration(conversationId) as {
    presences?: Array<{ actor_key: string; state: string; seen_at: number; name: string }>;
  };
  return (collaboration.presences ?? []).map((item) => ({
    id: item.actor_key,
    name: item.name,
    state: item.state === 'typing' ? 'typing' : 'viewing',
    at: item.seen_at,
  }));
}

/** Шапка: строка списка для получателя (даже у убранного диалога) и свойства канала. */
export function threadHead(store: Store, outbox: Outbox, operations: Operations, conversation: Conversation, viewerKey: string, now = Date.now()): ThreadHead | null {
  const rows = store.db.prepare(factsQuery('c.id = @id')).all({ id: conversation.id }) as FactsRow[];
  const projection = projectRows(store.db, rows, now)[0];
  if (!projection) return null;
  const window = replyWindow(conversation, now);
  const ticket = conversation.channel === 'bedolaga' || conversation.channel === 'minishop'
    ? { kind: conversation.channel, number: conversation.remote_external_id ?? conversation.external_id ?? null }
    : null;
  return {
    item: materialize(projection, viewerKey),
    ticket,
    attachments: outbox.supportsAttachments(conversation.channel),
    sender: outbox.has(conversation.channel),
    hidden: conversation.hidden_at !== null,
    window: {
      applies: window.applies,
      open: window.open,
      closes_at: window.applies && Number.isFinite(window.msLeft) ? now + window.msLeft : null,
    },
    presence: presenceOf(operations, conversation.id),
  };
}
