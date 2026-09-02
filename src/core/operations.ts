import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Conversation, Store } from './store.js';

export type OperatorRole = 'admin' | 'lead' | 'agent' | 'viewer';
export type Permission =
  | 'conversation:read' | 'conversation:write' | 'conversation:assign'
  | 'knowledge:review' | 'settings:write' | 'operators:manage'
  | 'audit:read' | 'update:manage';

export interface Actor {
  key: string;
  id: number | null;
  name: string;
  role: OperatorRole;
  root?: boolean;
}

const ROLE_PERMISSIONS: Record<OperatorRole, ReadonlySet<Permission>> = {
  viewer: new Set(['conversation:read']),
  agent: new Set(['conversation:read', 'conversation:write']),
  lead: new Set(['conversation:read', 'conversation:write', 'conversation:assign', 'knowledge:review', 'audit:read']),
  admin: new Set([
    'conversation:read', 'conversation:write', 'conversation:assign', 'knowledge:review',
    'settings:write', 'operators:manage', 'audit:read', 'update:manage',
  ]),
};

const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
const cleanText = (value: unknown, max = 200): string => String(value ?? '').trim().slice(0, max);

export class Operations {
  readonly db: Database.Database;

  constructor(private readonly store: Store) {
    this.db = store.db;
  }

  rootActor(): Actor {
    return { key: 'root', id: null, name: 'Владелец', role: 'admin', root: true };
  }

  can(actor: Actor, permission: Permission): boolean {
    return ROLE_PERMISSIONS[actor.role].has(permission);
  }

  authenticate(token: string): Actor | null {
    if (!token) return null;
    const row = this.db.prepare(`
      SELECT id, name, role FROM operator_account
       WHERE token_hash = ? AND active = 1
    `).get(tokenHash(token)) as { id: number; name: string; role: OperatorRole } | undefined;
    return row ? { key: `op:${row.id}`, id: row.id, name: row.name, role: row.role } : null;
  }

  listOperators(): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT id, name, role, active, created_at, updated_at
        FROM operator_account ORDER BY active DESC, name COLLATE NOCASE
    `).all() as Array<Record<string, unknown>>;
  }

  createOperator(nameRaw: unknown, roleRaw: unknown): { operator: Record<string, unknown>; token: string } {
    const name = cleanText(nameRaw, 80);
    const role = String(roleRaw) as OperatorRole;
    if (name.length < 2) throw new Error('Имя оператора слишком короткое');
    if (!Object.hasOwn(ROLE_PERMISSIONS, role)) throw new Error('Неизвестная роль');
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO operator_account (name, role, token_hash, active, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `).run(name, role, tokenHash(token), now, now);
    const operator = this.db.prepare(`
      SELECT id, name, role, active, created_at, updated_at FROM operator_account WHERE id = ?
    `).get(Number(result.lastInsertRowid)) as Record<string, unknown>;
    return { operator, token };
  }

  rotateOperator(id: number): string {
    const token = randomBytes(32).toString('base64url');
    const result = this.db.prepare(`UPDATE operator_account SET token_hash = ?, updated_at = ? WHERE id = ?`)
      .run(tokenHash(token), Date.now(), id);
    if (!result.changes) throw new Error('Оператор не найден');
    return token;
  }

  setOperatorActive(id: number, active: boolean): boolean {
    return this.db.prepare(`UPDATE operator_account SET active = ?, updated_at = ? WHERE id = ?`)
      .run(active ? 1 : 0, Date.now(), id).changes > 0;
  }

  claim(conversationId: number, actor: Actor, force = false): { ok: boolean; owner?: string; until?: number } {
    const now = Date.now();
    const leaseMs = 15 * 60_000;
    const row = this.db.prepare(`SELECT assignee, claimed_at FROM conversation WHERE id = ?`).get(conversationId) as
      { assignee: string | null; claimed_at: number | null } | undefined;
    if (!row) return { ok: false };
    const live = row.assignee && row.claimed_at && row.claimed_at + leaseMs > now;
    if (live && row.assignee !== actor.key && !force) {
      return { ok: false, owner: this.actorName(row.assignee!), until: row.claimed_at! + leaseMs };
    }
    this.db.prepare(`
      UPDATE conversation
         SET assignee = ?, assigned_operator_id = ?, claimed_at = ?, operator_active_at = ?, updated_at = ?
       WHERE id = ?
    `).run(actor.key, actor.id, now, now, now, conversationId);
    this.presence(conversationId, actor, 'viewing');
    return { ok: true, owner: actor.name, until: now + leaseMs };
  }

  release(conversationId: number, actor: Actor, force = false): boolean {
    const current = this.db.prepare(`SELECT assignee FROM conversation WHERE id = ?`).get(conversationId) as { assignee: string | null } | undefined;
    if (!current || (current.assignee && current.assignee !== actor.key && !force)) return false;
    const result = this.db.prepare(`
      UPDATE conversation SET assignee = NULL, assigned_operator_id = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?
    `).run(Date.now(), conversationId);
    this.db.prepare(`DELETE FROM operator_presence WHERE actor_key = ? AND conversation_id = ?`).run(actor.key, conversationId);
    return result.changes > 0;
  }

  presence(conversationId: number, actor: Actor, stateRaw: unknown): void {
    const state = stateRaw === 'typing' ? 'typing' : 'viewing';
    this.db.prepare(`
      INSERT INTO operator_presence (actor_key, conversation_id, state, seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(actor_key, conversation_id) DO UPDATE SET state=excluded.state, seen_at=excluded.seen_at
    `).run(actor.key, conversationId, state, Date.now());
    this.db.prepare(`DELETE FROM operator_presence WHERE seen_at < ?`).run(Date.now() - 5 * 60_000);
  }

  collaboration(conversationId: number): Record<string, unknown> {
    const row = this.db.prepare(`
      SELECT assignee, claimed_at FROM conversation WHERE id = ?
    `).get(conversationId) as { assignee: string | null; claimed_at: number | null } | undefined;
    const now = Date.now();
    const presences = (this.db.prepare(`
      SELECT actor_key, state, seen_at FROM operator_presence
       WHERE conversation_id = ? AND seen_at >= ? ORDER BY seen_at DESC
    `).all(conversationId, now - 90_000) as Array<{ actor_key: string; state: string; seen_at: number }>)
      .map((item) => ({ ...item, name: this.actorName(item.actor_key) }));
    const leaseUntil = row?.claimed_at ? row.claimed_at + 15 * 60_000 : null;
    return {
      owner: row?.assignee && leaseUntil && leaseUntil > now
        ? { key: row.assignee, name: this.actorName(row.assignee), until: leaseUntil }
        : null,
      presences,
    };
  }

  actorName(key: string): string {
    if (key === 'root') return 'Владелец';
    const id = Number(key.replace(/^op:/, ''));
    if (!Number.isFinite(id)) return key;
    const row = this.db.prepare(`SELECT name FROM operator_account WHERE id = ?`).get(id) as { name: string } | undefined;
    return row?.name ?? 'Бывший оператор';
  }

  ensureProfile(conversation: Conversation): number {
    const identity = conversation.tg_user_id != null
      ? `tg:${conversation.tg_user_id}`
      : `${conversation.channel}:${conversation.external_id}`;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO customer_profile (identity_key, tg_user_id, username, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity_key) DO UPDATE SET
        tg_user_id=COALESCE(excluded.tg_user_id, customer_profile.tg_user_id),
        username=COALESCE(excluded.username, customer_profile.username),
        display_name=COALESCE(excluded.display_name, customer_profile.display_name),
        updated_at=excluded.updated_at
    `).run(identity, conversation.tg_user_id, conversation.username, conversation.display_name, now, now);
    const profile = this.db.prepare(`SELECT id FROM customer_profile WHERE identity_key = ?`).get(identity) as { id: number };
    this.db.prepare(`UPDATE conversation SET customer_profile_id = ? WHERE id = ?`).run(profile.id, conversation.id);
    return profile.id;
  }

  profile(conversation: Conversation): Record<string, unknown> {
    const id = conversation.customer_profile_id ?? this.ensureProfile(conversation);
    const profile = this.db.prepare(`SELECT * FROM customer_profile WHERE id = ?`).get(id) as Record<string, unknown>;
    const tags = (this.db.prepare(`SELECT tag FROM customer_tag WHERE customer_id = ? ORDER BY tag`).all(id) as Array<{ tag: string }>).map((r) => r.tag);
    const notes = this.db.prepare(`
      SELECT id, actor_key, text, created_at FROM customer_note WHERE customer_id = ? ORDER BY id DESC LIMIT 100
    `).all(id) as Array<Record<string, unknown>>;
    const related = this.db.prepare(`
      SELECT id, channel, external_id, username, display_name, status, priority, last_message_at
        FROM conversation WHERE customer_profile_id = ? ORDER BY last_message_at DESC
    `).all(id) as Array<Record<string, unknown>>;
    return { ...profile, tags, notes, related };
  }

  updateProfile(conversation: Conversation, values: Record<string, unknown>): Record<string, unknown> {
    const id = conversation.customer_profile_id ?? this.ensureProfile(conversation);
    const allowed = ['username', 'display_name', 'email', 'phone', 'company'] as const;
    const current = this.db.prepare(`SELECT * FROM customer_profile WHERE id = ?`).get(id) as Record<string, unknown>;
    const next = Object.fromEntries(allowed.map((key) => [key, Object.hasOwn(values, key) ? cleanText(values[key], 200) || null : current[key]]));
    this.db.prepare(`
      UPDATE customer_profile SET username=?, display_name=?, email=?, phone=?, company=?, updated_at=? WHERE id=?
    `).run(next.username, next.display_name, next.email, next.phone, next.company, Date.now(), id);
    if (Array.isArray(values.tags)) {
      const tags = [...new Set(values.tags.map((tag) => cleanText(tag, 40).toLowerCase()).filter(Boolean))].slice(0, 20);
      this.db.transaction(() => {
        this.db.prepare(`DELETE FROM customer_tag WHERE customer_id = ?`).run(id);
        const insert = this.db.prepare(`INSERT INTO customer_tag (customer_id, tag, created_at) VALUES (?, ?, ?)`);
        for (const tag of tags) insert.run(id, tag, Date.now());
      })();
    }
    return this.profile({ ...conversation, customer_profile_id: id });
  }

  addProfileNote(conversation: Conversation, actor: Actor, textRaw: unknown): Record<string, unknown> {
    const text = cleanText(textRaw, 4000);
    if (!text) throw new Error('Пустая заметка');
    const id = conversation.customer_profile_id ?? this.ensureProfile(conversation);
    const result = this.db.prepare(`INSERT INTO customer_note (customer_id, actor_key, text, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, actor.key, text, Date.now());
    return this.db.prepare(`SELECT id, actor_key, text, created_at FROM customer_note WHERE id = ?`)
      .get(Number(result.lastInsertRowid)) as Record<string, unknown>;
  }

  audit(actor: Actor, action: string, resource: string, resourceId: unknown, payload: unknown, ip?: string): void {
    let safe: string | null = null;
    if (payload !== undefined) {
      const json = JSON.stringify(payload, (key, value) =>
        /token|password|secret|api.?key|authorization|cookie|credential|bearer/i.test(key)
          ? '[redacted]'
          : value,
      );
      safe = (json ?? 'null').slice(0, 8000);
    }
    this.db.prepare(`
      INSERT INTO audit_log (actor_key, actor_name, actor_role, action, resource, resource_id, payload, ip, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(actor.key, actor.name, actor.role, action, resource, resourceId == null ? null : String(resourceId), safe, ip ?? null, Date.now());
  }

  listAudit(limit = 200): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`).all(Math.min(1000, Math.max(1, limit))) as Array<Record<string, unknown>>;
  }

  search(queryRaw: unknown, limit = 40): Record<string, unknown> {
    const query = cleanText(queryRaw, 120);
    if (query.length < 2) return { query, conversations: [], messages: [], customers: [], knowledge: [] };
    const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const n = Math.min(100, Math.max(1, limit));
    const conversations = this.db.prepare(`
      SELECT id, channel, username, display_name, subject, status, priority, last_message_at
        FROM conversation
       WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'
          OR subject LIKE ? ESCAPE '\\' OR external_id LIKE ? ESCAPE '\\'
       ORDER BY last_message_at DESC LIMIT ?
    `).all(like, like, like, like, n);
    const messages = this.db.prepare(`
      SELECT id, conversation_id, direction, author, substr(text, 1, 300) AS text, created_at
        FROM message WHERE text LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?
    `).all(like, n);
    const customers = this.db.prepare(`
      SELECT id, username, display_name, email, phone, company
        FROM customer_profile
       WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'
          OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC LIMIT ?
    `).all(like, like, like, like, like, n);
    const knowledge = this.db.prepare(`
      SELECT id, title, substr(body, 1, 300) AS excerpt FROM kb_doc
       WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?
    `).all(like, like, n);
    return { query, conversations, messages, customers, knowledge };
  }

  slaPolicies(): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT * FROM sla_policy ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END`).all() as Array<Record<string, unknown>>;
  }

  updateSla(priority: string, first: number, resolution: number): void {
    if (!['low', 'normal', 'high', 'urgent'].includes(priority)) throw new Error('Неизвестный приоритет');
    if (![first, resolution].every((n) => Number.isInteger(n) && n > 0 && n <= 10080)) throw new Error('Некорректный SLA');
    this.db.prepare(`UPDATE sla_policy SET first_response_minutes=?, resolution_minutes=? WHERE priority=?`).run(first, resolution, priority);
  }

  queue(): Array<Record<string, unknown>> {
    const now = Date.now();
    return (this.db.prepare(`
      SELECT c.id, c.channel, c.username, c.display_name, c.status, c.priority, c.assignee,
             c.first_inbound_at, c.first_response_at, c.created_at, c.last_message_at,
             p.first_response_minutes, p.resolution_minutes
        FROM conversation c JOIN sla_policy p ON p.priority = c.priority
       WHERE c.status != 'resolved'
       ORDER BY CASE c.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
                c.last_message_at ASC
    `).all() as Array<Record<string, unknown>>).map((row) => {
      const firstBase = Number(row.first_inbound_at ?? row.created_at);
      const resolutionBase = Number(row.created_at);
      const firstDue = firstBase + Number(row.first_response_minutes) * 60_000;
      const resolutionDue = resolutionBase + Number(row.resolution_minutes) * 60_000;
      const due = row.first_response_at ? resolutionDue : Math.min(firstDue, resolutionDue);
      return { ...row, due_at: due, overdue: due < now, owner_name: row.assignee ? this.actorName(String(row.assignee)) : null };
    });
  }

  registerCandidates(articles: Array<{ title: string; file: string; confidence?: number }>, source: string): number[] {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO kb_candidate (title, file_name, source, confidence, status, version, created_at)
      VALUES (?, ?, ?, ?, 'pending', COALESCE((SELECT MAX(version)+1 FROM kb_candidate WHERE file_name=?), 1), ?)
    `);
    const ids: number[] = [];
    for (const article of articles) {
      const result = insert.run(cleanText(article.title, 200), cleanText(article.file, 300), cleanText(source, 80), article.confidence ?? null, cleanText(article.file, 300), Date.now());
      if (result.changes) ids.push(Number(result.lastInsertRowid));
    }
    return ids;
  }

  candidates(status = 'pending'): Array<Record<string, unknown>> {
    if (!['pending', 'approved', 'rejected', 'all'].includes(status)) status = 'pending';
    return (status === 'all'
      ? this.db.prepare(`SELECT * FROM kb_candidate ORDER BY id DESC`).all()
      : this.db.prepare(`SELECT * FROM kb_candidate WHERE status=? ORDER BY id DESC`).all(status)) as Array<Record<string, unknown>>;
  }

  candidate(id: number): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT * FROM kb_candidate WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  }

  decideCandidate(id: number, status: 'approved' | 'rejected', actor: Actor): boolean {
    return this.db.prepare(`
      UPDATE kb_candidate SET status=?, decided_at=?, decided_by=? WHERE id=? AND status='pending'
    `).run(status, Date.now(), actor.key, id).changes > 0;
  }

  savedFilters(actor: Actor): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT * FROM saved_filter WHERE owner_key=? ORDER BY name COLLATE NOCASE`).all(actor.key) as Array<Record<string, unknown>>;
  }

  saveFilter(actor: Actor, nameRaw: unknown, query: unknown): void {
    const name = cleanText(nameRaw, 60);
    if (!name) throw new Error('Нужно имя фильтра');
    const encoded = JSON.stringify(query ?? {}).slice(0, 4000);
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO saved_filter (owner_key, name, query, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner_key, name) DO UPDATE SET query=excluded.query, updated_at=excluded.updated_at
    `).run(actor.key, name, encoded, now, now);
  }

  deleteFilter(actor: Actor, id: number): boolean {
    return this.db.prepare(`DELETE FROM saved_filter WHERE id=? AND owner_key=?`).run(id, actor.key).changes > 0;
  }

  recordUpdate(action: 'update' | 'rollback', targetVersion: string | null, status: string, actor: Actor, detail?: unknown): number {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO update_history (action, version, status, detail, actor_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(action, targetVersion, cleanText(status, 40), detail === undefined ? null : JSON.stringify(detail).slice(0, 4000), actor.key, now, now);
    return Number(result.lastInsertRowid);
  }

  updateHistory(limit = 30): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT * FROM update_history ORDER BY id DESC LIMIT ?`)
      .all(Math.min(100, Math.max(1, limit))) as Array<Record<string, unknown>>;
  }

  diagnostics(): Record<string, unknown> {
    const integrity = this.db.pragma('quick_check', { simple: true });
    const counts = Object.fromEntries(['conversation', 'message', 'customer_profile', 'kb_doc', 'kb_candidate', 'audit_log']
      .map((table) => [table, Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)]));
    const jobs = this.db.prepare(`SELECT id, kind, status, progress, error, started_at, ended_at FROM job ORDER BY id DESC LIMIT 20`).all();
    return { integrity, schema: Number(this.db.pragma('user_version', { simple: true })), counts, jobs };
  }
}
