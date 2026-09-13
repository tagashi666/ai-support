import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Conversation, Store } from './store.js';

export type OperatorRole = 'admin' | 'lead' | 'agent' | 'viewer';

export const PERMISSION_CATALOG = [
  { id: 'conversation:read', group: 'Диалоги', label: 'Просматривать диалоги' },
  { id: 'conversation:reply', group: 'Диалоги', label: 'Отвечать клиентам' },
  { id: 'conversation:attachments', group: 'Диалоги', label: 'Отправлять вложения' },
  { id: 'conversation:notes', group: 'Диалоги', label: 'Добавлять внутренние заметки' },
  { id: 'conversation:profile', group: 'Диалоги', label: 'Изменять карточку клиента' },
  { id: 'conversation:status', group: 'Диалоги', label: 'Менять статус и режим AI диалога' },
  { id: 'conversation:assign', group: 'Диалоги', label: 'Переназначать чужие диалоги' },
  { id: 'bedolaga:view', group: 'Bedolaga', label: 'Просматривать подписки и платежи' },
  { id: 'bedolaga:extend', group: 'Bedolaga', label: 'Продлевать подписки' },
  { id: 'bedolaga:devices', group: 'Bedolaga', label: 'Управлять устройствами и подпиской' },
  { id: 'queue:read', group: 'Очередь и SLA', label: 'Просматривать очередь SLA' },
  { id: 'queue:manage', group: 'Очередь и SLA', label: 'Изменять сроки SLA' },
  { id: 'templates:read', group: 'Контент', label: 'Использовать шаблоны' },
  { id: 'templates:manage', group: 'Контент', label: 'Редактировать шаблоны' },
  { id: 'knowledge:read', group: 'Контент', label: 'Просматривать базу знаний' },
  { id: 'knowledge:manage', group: 'Контент', label: 'Редактировать базу знаний' },
  { id: 'knowledge:review', group: 'Контент', label: 'Публиковать черновики обучения' },
  { id: 'knowledge:mine', group: 'Контент', label: 'Запускать добычу знаний' },
  { id: 'stats:read', group: 'Аналитика', label: 'Просматривать общую статистику' },
  { id: 'stats:reset', group: 'Аналитика', label: 'Сбрасывать период статистики' },
  { id: 'operator_stats:read', group: 'Аналитика', label: 'Просматривать статистику операторов' },
  { id: 'team:read', group: 'Команда', label: 'Просматривать команду' },
  { id: 'operators:manage', group: 'Команда', label: 'Создавать и отключать операторов' },
  { id: 'roles:manage', group: 'Команда', label: 'Настраивать права ролей' },
  { id: 'audit:read', group: 'Команда', label: 'Просматривать журнал действий' },
  { id: 'diagnostics:read', group: 'Система', label: 'Просматривать диагностику' },
  { id: 'settings:read', group: 'Система', label: 'Открывать настройки' },
  { id: 'settings:sources', group: 'Система', label: 'Управлять источниками и папками' },
  { id: 'settings:services', group: 'Система', label: 'Изменять профили сервисов' },
  { id: 'settings:nodes', group: 'Система', label: 'Обновлять серверы и псевдонимы' },
  { id: 'settings:alerts', group: 'Система', label: 'Проверять системные уведомления' },
  { id: 'settings:update', group: 'Система', label: 'Устанавливать обновления и откаты' },
  { id: 'settings:ai_tools', group: 'Система', label: 'Проверять модели и ключи AI' },
  ...Object.entries({
    aiMode: 'Режим AI по умолчанию', requireKb: 'Ответы только по базе знаний',
    autoLearn: 'Обучение на закрытых диалогах', minConfidence: 'Порог уверенности AI',
    autoPerHour: 'Лимит автоответов в час', humanHoldMinutes: 'Пауза после ответа оператора',
    maxAgeMinutes: 'Максимальный возраст сообщения', slaFirstResponseMinutes: 'Срок первого ответа',
    handoffRepeatMinutes: 'Частота напоминания об операторе', notifyLevel: 'Подробность уведомлений',
    model: 'Основная модель AI', fallbackModel: 'Запасная модель AI', brand: 'Название сервиса',
    replyStyle: 'Манера ответа', handoffMessage: 'Текст передачи оператору',
    modelKey: 'Ключ основной модели', fallbackKey: 'Ключ запасной модели',
  }).map(([key, label]) => ({ id: `setting:${key}`, group: 'Параметры AI', label })),
] as const;

export type Permission = (typeof PERMISSION_CATALOG)[number]['id'];

export interface Actor {
  key: string;
  id: number | null;
  name: string;
  role: OperatorRole;
  root?: boolean;
  permissions?: Permission[];
}

const ROLE_PERMISSIONS: Record<OperatorRole, ReadonlySet<Permission>> = {
  viewer: new Set(['conversation:read', 'queue:read', 'templates:read', 'knowledge:read', 'stats:read', 'settings:read']),
  agent: new Set([
    'conversation:read', 'conversation:reply', 'conversation:attachments', 'conversation:notes',
    'conversation:profile', 'conversation:status', 'bedolaga:view', 'bedolaga:extend',
    'queue:read', 'templates:read', 'knowledge:read', 'stats:read', 'settings:read',
  ]),
  lead: new Set([
    'conversation:read', 'conversation:reply', 'conversation:attachments', 'conversation:notes',
    'conversation:profile', 'conversation:status', 'conversation:assign', 'bedolaga:view',
    'bedolaga:extend', 'queue:read', 'queue:manage', 'templates:read', 'templates:manage',
    'knowledge:read', 'knowledge:manage', 'knowledge:review', 'knowledge:mine', 'stats:read',
    'operator_stats:read', 'team:read', 'audit:read', 'diagnostics:read', 'settings:read',
  ]),
  admin: new Set(PERMISSION_CATALOG.map((item) => item.id)),
};

const KNOWN_PERMISSIONS = new Set<Permission>(PERMISSION_CATALOG.map((item) => item.id));

const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
const cleanText = (value: unknown, max = 200): string => String(value ?? '').trim().slice(0, max);

export class Operations {
  readonly db: Database.Database;

  constructor(private readonly store: Store) {
    this.db = store.db;
  }

  rootActor(): Actor {
    return {
      key: 'root', id: null, name: 'Владелец', role: 'admin', root: true,
      permissions: PERMISSION_CATALOG.map((item) => item.id),
    };
  }

  can(actor: Actor, permission: Permission): boolean {
    if (actor.root) return true;
    const override = this.db.prepare(
      'SELECT allowed FROM role_permission WHERE role = ? AND permission = ?',
    ).get(actor.role, permission) as { allowed: number } | undefined;
    return override ? Boolean(override.allowed) : ROLE_PERMISSIONS[actor.role].has(permission);
  }

  permissionsFor(actor: Actor): Permission[] {
    return PERMISSION_CATALOG.map((item) => item.id).filter((permission) => this.can(actor, permission));
  }

  authenticate(token: string): Actor | null {
    if (!token) return null;
    const row = this.db.prepare(`
      SELECT id, name, role FROM operator_account
       WHERE token_hash = ? AND active = 1
    `).get(tokenHash(token)) as { id: number; name: string; role: OperatorRole } | undefined;
    if (!row) return null;
    const actor: Actor = { key: `op:${row.id}`, id: row.id, name: row.name, role: row.role };
    actor.permissions = this.permissionsFor(actor);
    return actor;
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

  updateOperator(id: number, values: { name?: unknown; role?: unknown }): Record<string, unknown> | null {
    const current = this.db.prepare('SELECT * FROM operator_account WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!current) return null;
    const name = values.name === undefined ? String(current['name']) : cleanText(values.name, 80);
    const role = values.role === undefined ? String(current['role']) as OperatorRole : String(values.role) as OperatorRole;
    if (name.length < 2) throw new Error('Имя оператора слишком короткое');
    if (!Object.hasOwn(ROLE_PERMISSIONS, role)) throw new Error('Неизвестная роль');
    this.db.prepare('UPDATE operator_account SET name = ?, role = ?, updated_at = ? WHERE id = ?')
      .run(name, role, Date.now(), id);
    return this.db.prepare(`
      SELECT id, name, role, active, created_at, updated_at FROM operator_account WHERE id = ?
    `).get(id) as Record<string, unknown>;
  }

  rolePermissions(): Record<string, Permission[]> {
    const result: Record<string, Permission[]> = {};
    for (const role of Object.keys(ROLE_PERMISSIONS) as OperatorRole[]) {
      const actor: Actor = { key: `role:${role}`, id: null, name: role, role };
      result[role] = this.permissionsFor(actor);
    }
    return result;
  }

  defaultRolePermissions(): Record<string, Permission[]> {
    return Object.fromEntries(
      (Object.keys(ROLE_PERMISSIONS) as OperatorRole[]).map((role) => [role, [...ROLE_PERMISSIONS[role]]]),
    );
  }

  setRolePermissions(roleRaw: unknown, values: unknown): Permission[] {
    const role = String(roleRaw) as OperatorRole;
    if (!Object.hasOwn(ROLE_PERMISSIONS, role)) throw new Error('Неизвестная роль');
    if (!Array.isArray(values)) throw new Error('Нужен список прав');
    const permissions = [...new Set(values.map(String))];
    if (permissions.some((permission) => !KNOWN_PERMISSIONS.has(permission as Permission))) {
      throw new Error('Список содержит неизвестное право');
    }
    const selected = new Set(permissions as Permission[]);
    // Зависимые действия без экрана/объекта чтения дали бы формально
    // разрешённую, но недоступную функцию. Нормализуем только необходимые
    // базовые права; остальные флаги остаются полностью независимыми.
    if ([...selected].some((permission) => permission.startsWith('conversation:') && permission !== 'conversation:read')) selected.add('conversation:read');
    if (selected.has('bedolaga:extend') || selected.has('bedolaga:devices')) {
      selected.add('bedolaga:view'); selected.add('conversation:read');
    }
    if ([...selected].some((permission) => permission.startsWith('setting:'))) selected.add('settings:read');
    if ([...selected].some((permission) => ['settings:sources','settings:services','settings:alerts','settings:update'].includes(permission))) selected.add('settings:read');
    if (selected.has('queue:manage')) selected.add('queue:read');
    if (selected.has('templates:manage')) selected.add('templates:read');
    if ([...selected].some((permission) => ['knowledge:manage','knowledge:review','knowledge:mine'].includes(permission))) selected.add('knowledge:read');
    if (selected.has('stats:reset')) selected.add('stats:read');
    if (selected.has('operators:manage') || selected.has('roles:manage')) selected.add('team:read');
    const upsert = this.db.prepare(`
      INSERT INTO role_permission (role, permission, allowed, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(role, permission) DO UPDATE SET allowed=excluded.allowed, updated_at=excluded.updated_at
    `);
    this.db.transaction(() => {
      for (const item of PERMISSION_CATALOG) {
        const allowed = selected.has(item.id);
        if (allowed === ROLE_PERMISSIONS[role].has(item.id)) {
          this.db.prepare('DELETE FROM role_permission WHERE role = ? AND permission = ?').run(role, item.id);
        } else {
          upsert.run(role, item.id, allowed ? 1 : 0, Date.now());
        }
      }
    })();
    return this.rolePermissions()[role]!;
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

  /** Ожидание клиента с первого входящего после последнего ответа. */
  pendingResponseMs(conversationId: number, now = Date.now()): number | null {
    const row = this.db.prepare(`
      SELECT MIN(created_at) AS inbound_at
        FROM message
       WHERE conversation_id = ? AND direction = 'in' AND is_backfill = 0
         AND created_at > COALESCE((
           SELECT MAX(created_at) FROM message
            WHERE conversation_id = ? AND direction = 'out'
         ), 0)
    `).get(conversationId, conversationId) as { inbound_at: number | null };
    return row.inbound_at == null ? null : Math.max(0, now - row.inbound_at);
  }

  recordActivity(actor: Actor, kind: 'reply' | 'resolved', conversationId: number, responseMs?: number | null): void {
    this.db.prepare(`
      INSERT INTO operator_activity (actor_key, operator_id, conversation_id, kind, response_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(actor.key, actor.id, conversationId, kind, responseMs ?? null, Date.now());
  }

  operatorStats(daysRaw = 30): Record<string, unknown> {
    const days = Math.min(365, Math.max(1, Number(daysRaw) || 30));
    const since = Date.now() - days * 86_400_000;
    const accounts = this.listOperators();
    const identities = [
      { id: null, key: 'root', name: 'Владелец', role: 'admin', active: 1 },
      ...accounts.map((row) => ({ ...row, key: `op:${row['id']}` })),
    ] as Array<Record<string, unknown>>;
    const events = this.db.prepare(`
      SELECT actor_key, conversation_id, kind, response_ms, created_at
        FROM operator_activity WHERE created_at >= ? ORDER BY created_at
    `).all(since) as Array<{ actor_key: string; conversation_id: number; kind: string; response_ms: number | null; created_at: number }>;
    const assigned = new Map<string, number>();
    for (const row of this.db.prepare(`
      SELECT assignee, COUNT(*) AS n FROM conversation
       WHERE assignee IS NOT NULL AND status NOT IN ('closed','resolved') GROUP BY assignee
    `).all() as Array<{ assignee: string; n: number }>) assigned.set(row.assignee, Number(row.n));
    const operators = identities.map((identity) => {
      const key = String(identity['key']);
      const own = events.filter((event) => event.actor_key === key);
      const replies = own.filter((event) => event.kind === 'reply');
      const samples = replies.map((event) => event.response_ms).filter((ms): ms is number => ms != null).sort((a, b) => a - b);
      const median = samples.length ? samples[Math.floor((samples.length - 1) / 2)]! : null;
      return {
        ...identity,
        handled: new Set(own.map((event) => event.conversation_id)).size,
        resolved: new Set(own.filter((event) => event.kind === 'resolved').map((event) => event.conversation_id)).size,
        replies: replies.length,
        average_response_ms: samples.length ? Math.round(samples.reduce((sum, ms) => sum + ms, 0) / samples.length) : null,
        median_response_ms: median,
        active_assigned: assigned.get(key) ?? 0,
        last_activity_at: own.at(-1)?.created_at ?? null,
      };
    });
    return { days, since, operators };
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
