/**
 * «Команда» (6.10): роли и права словами, «может / не может», разница прав
 * «было → станет», «затронет N человек» и перевод журнала действий в
 * человеческие фразы. Чистые функции — без запросов и без DOM.
 */
import { t } from '@/i18n/ru';
import { duration } from '@/lib/format/format';
import { MODE_LABEL } from '@/lib/assistant/model';
import { tr, type TKey } from '@/i18n/sections/team';

export const ROLES = ['admin', 'lead', 'agent', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

const ROLE_NAME: Record<Role, TKey> = {
  admin: 'team.role.admin', lead: 'team.role.lead', agent: 'team.role.agent', viewer: 'team.role.viewer',
};
const ROLE_BRIEF: Record<Role, TKey> = {
  admin: 'team.brief.admin', lead: 'team.brief.lead', agent: 'team.brief.agent', viewer: 'team.brief.viewer',
};

export const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value);
export const roleName = (role: string): string => (isRole(role) ? tr(ROLE_NAME[role]) : tr('team.role.unknown'));
/** Краткое описание роли «по умолчанию» — для формы добавления и для тех, кому не видны права. */
export const roleBrief = (role: string): string => (isRole(role) ? tr(ROLE_BRIEF[role]) : '');

/* ───────────── права словами ───────────── */

const PERM_KEY: Record<string, TKey> = {
  'conversation:read': 'team.perm.conversation.read',
  'conversation:reply': 'team.perm.conversation.reply',
  'conversation:attachments': 'team.perm.conversation.attachments',
  'conversation:notes': 'team.perm.conversation.notes',
  'conversation:profile': 'team.perm.conversation.profile',
  'conversation:status': 'team.perm.conversation.status',
  'conversation:assign': 'team.perm.conversation.assign',
  'bedolaga:view': 'team.perm.bedolaga.view',
  'bedolaga:extend': 'team.perm.bedolaga.extend',
  'bedolaga:devices': 'team.perm.bedolaga.devices',
  'queue:read': 'team.perm.queue.read',
  'queue:manage': 'team.perm.queue.manage',
  'templates:read': 'team.perm.templates.read',
  'templates:manage': 'team.perm.templates.manage',
  'knowledge:read': 'team.perm.knowledge.read',
  'knowledge:manage': 'team.perm.knowledge.manage',
  'knowledge:review': 'team.perm.knowledge.review',
  'knowledge:mine': 'team.perm.knowledge.mine',
  'stats:read': 'team.perm.stats.read',
  'stats:reset': 'team.perm.stats.reset',
  'operator_stats:read': 'team.perm.operator_stats.read',
  'team:read': 'team.perm.team.read',
  'operators:manage': 'team.perm.operators.manage',
  'roles:manage': 'team.perm.roles.manage',
  'audit:read': 'team.perm.audit.read',
  'diagnostics:read': 'team.perm.diagnostics.read',
  'settings:read': 'team.perm.settings.read',
  'settings:sources': 'team.perm.settings.sources',
  'settings:services': 'team.perm.settings.services',
  'settings:nodes': 'team.perm.settings.nodes',
  'settings:alerts': 'team.perm.settings.alerts',
  'settings:update': 'team.perm.settings.update',
  'settings:ai_tools': 'team.perm.settings.ai_tools',
  'setting:uiDefault': 'team.perm.setting.uiDefault',
  'setting:aiMode': 'team.perm.setting.aiMode',
  'setting:requireKb': 'team.perm.setting.requireKb',
  'setting:autoLearn': 'team.perm.setting.autoLearn',
  'setting:bedolagaInterfaceKb': 'team.perm.setting.bedolagaInterfaceKb',
  'setting:bedolagaInterfaceMode': 'team.perm.setting.bedolagaInterfaceMode',
  'setting:minConfidence': 'team.perm.setting.minConfidence',
  'setting:autoPerHour': 'team.perm.setting.autoPerHour',
  'setting:humanHoldMinutes': 'team.perm.setting.humanHoldMinutes',
  'setting:maxAgeMinutes': 'team.perm.setting.maxAgeMinutes',
  'setting:slaFirstResponseMinutes': 'team.perm.setting.slaFirstResponseMinutes',
  'setting:handoffRepeatMinutes': 'team.perm.setting.handoffRepeatMinutes',
  'setting:notifyLevel': 'team.perm.setting.notifyLevel',
  'setting:model': 'team.perm.setting.model',
  'setting:fallbackModel': 'team.perm.setting.fallbackModel',
  'setting:brand': 'team.perm.setting.brand',
  'setting:replyStyle': 'team.perm.setting.replyStyle',
  'setting:handoffMessage': 'team.perm.setting.handoffMessage',
  'setting:modelKey': 'team.perm.setting.modelKey',
  'setting:fallbackKey': 'team.perm.setting.fallbackKey',
  'setting:customerLinks': 'team.perm.setting.customerLinks',
};

/** Подпись права своими словами; для неизвестного права — подпись сервера. */
export const permLabel = (id: string, fallback = id): string => {
  const key = PERM_KEY[id];
  return key ? tr(key) : fallback;
};

export interface CatalogItem { id: string; group: string; label: string }
export interface PermGroup { group: string; label: string; items: Array<{ id: string; label: string }> }

const GROUP_KEY: Record<string, TKey> = {
  'Диалоги': 'team.group.chats', 'Bedolaga': 'team.group.bedolaga', 'Очередь и SLA': 'team.group.queue',
  'Контент': 'team.group.content', 'Аналитика': 'team.group.stats', 'Команда': 'team.group.team',
  'Система': 'team.group.system', 'Параметры AI': 'team.group.assistant',
};

/** Каталог → группы в порядке сервера, с человеческими подписями. */
export function permGroups(catalog: readonly CatalogItem[]): PermGroup[] {
  const groups: PermGroup[] = [];
  for (const item of catalog) {
    let group = groups.find((entry) => entry.group === item.group);
    if (!group) {
      const key = GROUP_KEY[item.group];
      group = { group: item.group, label: key ? tr(key) : tr('team.group.other'), items: [] };
      groups.push(group);
    }
    group.items.push({ id: item.id, label: permLabel(item.id, item.label) });
  }
  return groups;
}

interface Ability { key: TKey; all?: readonly string[]; prefix?: string }
/** Что человек «может»: порядок — от повседневного к управлению. */
const ABILITIES: readonly Ability[] = [
  { key: 'team.ab.reply', all: ['conversation:reply'] },
  { key: 'team.ab.notes', all: ['conversation:notes'] },
  { key: 'team.ab.assign', all: ['conversation:assign'] },
  { key: 'team.ab.subs', all: ['bedolaga:view'] },
  { key: 'team.ab.extend', all: ['bedolaga:extend'] },
  { key: 'team.ab.devices', all: ['bedolaga:devices'] },
  { key: 'team.ab.sla', all: ['queue:manage'] },
  { key: 'team.ab.templates', all: ['templates:manage'] },
  { key: 'team.ab.kb', all: ['knowledge:manage'] },
  { key: 'team.ab.review', all: ['knowledge:review'] },
  { key: 'team.ab.reports', all: ['stats:read'] },
  { key: 'team.ab.peopleReports', all: ['operator_stats:read'] },
  { key: 'team.ab.audit', all: ['audit:read'] },
  { key: 'team.ab.system', all: ['diagnostics:read'] },
  { key: 'team.ab.team', all: ['operators:manage'] },
  { key: 'team.ab.roles', all: ['roles:manage'] },
  { key: 'team.ab.connections', all: ['settings:sources'] },
  { key: 'team.ab.update', all: ['settings:update'] },
  { key: 'team.ab.assistant', prefix: 'setting:' },
];

/** «Может / не может» словами по набору прав. */
export function canWords(permissions: Iterable<string>): { can: string[]; cannot: string[] } {
  const set = new Set(permissions);
  const can: string[] = [];
  const cannot: string[] = [];
  for (const ability of ABILITIES) {
    const prefix = ability.prefix;
    const has = prefix !== undefined
      ? [...set].some((id) => id.startsWith(prefix))
      : (ability.all ?? []).every((id) => set.has(id));
    (has ? can : cannot).push(tr(ability.key));
  }
  return { can, cannot };
}

/** Те же правила, что у сервера (setRolePermissions): зависимые права добавляются сами. Нужны, чтобы «станет» было честным. */
export function normalizePerms(selected: Iterable<string>): Set<string> {
  const set = new Set(selected);
  const any = (test: (id: string) => boolean): boolean => [...set].some(test);
  if (any((id) => id.startsWith('conversation:') && id !== 'conversation:read')) set.add('conversation:read');
  if (set.has('bedolaga:extend') || set.has('bedolaga:devices')) { set.add('bedolaga:view'); set.add('conversation:read'); }
  if (any((id) => id.startsWith('setting:'))) set.add('settings:read');
  if (any((id) => ['settings:sources', 'settings:services', 'settings:alerts', 'settings:update'].includes(id))) set.add('settings:read');
  if (set.has('queue:manage')) set.add('queue:read');
  if (set.has('templates:manage')) set.add('templates:read');
  if (any((id) => ['knowledge:manage', 'knowledge:review', 'knowledge:mine'].includes(id))) set.add('knowledge:read');
  if (set.has('stats:reset')) set.add('stats:read');
  if (set.has('operators:manage') || set.has('roles:manage')) set.add('team:read');
  return set;
}

export interface PermDiff { added: string[]; removed: string[] }

/** Разница прав «было → станет» в порядке каталога. */
export function diffPerms(before: Iterable<string>, after: Iterable<string>, order: readonly string[]): PermDiff {
  const was = new Set(before);
  const now = new Set(after);
  const rank = (id: string): number => { const index = order.indexOf(id); return index < 0 ? order.length : index; };
  const byOrder = (a: string, b: string): number => rank(a) - rank(b);
  return {
    added: [...now].filter((id) => !was.has(id)).sort(byOrder),
    removed: [...was].filter((id) => !now.has(id)).sort(byOrder),
  };
}

export interface Person { id: number; name: string; role: string; active: number | boolean }

/** Кого затронет смена прав роли: те, у кого она есть и доступ открыт. */
export const affectedPeople = <P extends Person>(people: readonly P[], role: string): P[] =>
  people.filter((person) => person.role === role && Boolean(person.active));

export const sameSet = (a: Iterable<string>, b: Iterable<string>): boolean => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
};

/* ───────────── журнал ───────────── */

export interface AuditEvent {
  id: number;
  actor_key: string;
  actor_name: string;
  actor_role: string;
  action: string;
  resource: string;
  resource_id: string | null;
  payload: string | null;
  ip: string | null;
  created_at: number;
}

export type AuditGroup = 'chats' | 'assistant' | 'knowledge' | 'team' | 'settings' | 'other';
export const AUDIT_GROUPS: readonly AuditGroup[] = ['chats', 'assistant', 'knowledge', 'team', 'settings'];

export const GROUP_LABEL: Record<AuditGroup, TKey> = {
  chats: 'team.group.chats', assistant: 'team.group.assistant', knowledge: 'team.group.content',
  team: 'team.group.team', settings: 'team.group.system', other: 'team.group.other',
};

export interface AuditLine {
  id: number;
  at: number;
  whoKey: string;
  who: string;
  group: AuditGroup;
  /** Что сделал(а): без имени. */
  text: string;
  action: string;
  section: string;
  /** Тело запроса без секретов, красиво; null — тела нет. */
  body: string | null;
  bodyBroken: boolean;
}

export interface AuditContext { operatorName(key: string): string | undefined }

const SECRET = /token|key|secret|passw|authorization|cookie|credential|bearer/i;
const MASK = '••••';
const MAX_TEXT = 300;

/** Замаскировать поля token/key/secret… на любой глубине; длинные строки обрезаются. */
export function maskSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => maskSecrets(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, inner]) => [key, SECRET.test(key) ? MASK : maskSecrets(inner, depth + 1)]));
  }
  if (typeof value === 'string' && value.length > MAX_TEXT) return `${value.slice(0, MAX_TEXT)}…`;
  return value;
}

type Body = Record<string, unknown>;
interface State { aiMode?: string }
interface Described { group: AuditGroup; text: string }
type Vars = Record<string, string | number>;

const d = (group: AuditGroup, key: TKey, vars?: Vars): Described => ({ group, text: tr(key, vars) });
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const modeWord = (mode: string): string => {
  const key = (MODE_LABEL as Record<string, Parameters<typeof t>[0]>)[mode];
  return key ? t(key) : tr('team.act.otherMode');
};
const settingWhat = (key: string): string | null => {
  const id = `setting:${key}`;
  return PERM_KEY[id] ? permLabel(id).replace(/^Менять (?:правило )?/, '') : null;
};
const decode = (value: string): string => { try { return decodeURIComponent(value); } catch { return value; } };
const articleName = (value: string): string => decode(value).replace(/\.md$/i, '');
const PRIORITY: Record<string, TKey> = {
  urgent: 'team.prio.urgent', high: 'team.prio.high', normal: 'team.prio.normal', low: 'team.prio.low',
};
const STATUS: Record<string, TKey> = { open: 'team.status.open', pending: 'team.status.pending', resolved: 'team.status.resolved' };
const KIND: Record<string, TKey> = {
  telegram_bot: 'team.kind.telegram_bot', remnawave: 'team.kind.remnawave', minishop: 'team.kind.minishop',
};

function chatState(id: string, body: Body): Described {
  const parts: string[] = [];
  const status = str(body['status']);
  const statusKey = STATUS[status];
  if (statusKey) parts.push(tr('team.act.status', { id, status: tr(statusKey) }));
  const mode = str(body['aiMode']);
  if (mode) parts.push(tr('team.act.aiModeChat', { id, mode: mode === 'inherit' ? t('mode.inherit') : modeWord(mode).toLowerCase() }));
  if (typeof body['escalated'] === 'boolean') parts.push(tr(body['escalated'] ? 'team.act.important' : 'team.act.unimportant', { id }));
  if (typeof body['handoff'] === 'boolean') parts.push(tr(body['handoff'] ? 'team.act.needHuman' : 'team.act.noNeedHuman', { id }));
  if (typeof body['hidden'] === 'boolean') parts.push(tr(body['hidden'] ? 'team.act.hide' : 'team.act.unhide', { id }));
  return { group: 'chats', text: parts.length ? parts.join('; ') : tr('team.act.chatChanged', { id }) };
}

function settings(body: Body, state: State): Described {
  const parts: string[] = [];
  const rest: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (key === 'aiMode') {
      const to = str(value);
      const from = state.aiMode;
      parts.push(from && from !== to
        ? tr('team.act.aiModeFromTo', { from: modeWord(from), to: modeWord(to) })
        : tr('team.act.aiModeTo', { to: modeWord(to).toLowerCase() }));
      if (to) state.aiMode = to;
      continue;
    }
    const what = settingWhat(key);
    if (!what) continue;
    if ((key === 'requireKb' || key === 'autoLearn') && typeof value === 'boolean') {
      parts.push(tr('team.act.settingBool', { what, value: tr(value ? 'team.act.on' : 'team.act.off') }));
    } else rest.push(what);
  }
  if (rest.length) parts.push(tr(rest.length === 1 ? 'team.act.settingOne' : 'team.act.settingMany', { what: rest.join(', ') }));
  return { group: 'assistant', text: parts.length ? parts.join('; ') : tr('team.act.settingAny') };
}

type Handler = (m: RegExpExecArray, body: Body, ctx: AuditContext, state: State) => Described;
const RULES: Array<[string, RegExp, Handler]> = [
  // Диалоги
  ['POST', /^\/api\/conversations\/(\d+)\/reply$/, (m) => d('chats', 'team.act.reply', { id: m[1]! })],
  ['POST', /^\/api\/conversations\/(\d+)\/attachments$/, (m) => d('chats', 'team.act.attachment', { id: m[1]! })],
  ['POST', /^\/api\/attachments\/\d+\/retry$/, () => d('chats', 'team.act.attachmentRetry')],
  ['POST', /^\/api\/conversations\/(\d+)\/note$/, (m) => d('chats', 'team.act.note', { id: m[1]! })],
  ['POST', /^\/api\/conversations\/(\d+)\/release$/, (m) => d('chats', 'team.act.release', { id: m[1]! })],
  ['POST', /^\/api\/conversations\/(\d+)\/state$/, (m, body) => chatState(m[1]!, body)],
  ['PATCH', /^\/api\/conversations\/(\d+)\/profile$/, (m) => d('chats', 'team.act.profile', { id: m[1]! })],
  ['POST', /^\/api\/conversations\/(\d+)\/profile\/notes$/, (m) => d('chats', 'team.act.profileNote', { id: m[1]! })],
  ['POST', /^\/api\/conversations\/(\d+)\/customer\/refresh$/, (m) => d('chats', 'team.act.customerRefresh', { id: m[1]! })],
  ['POST', /^\/api\/conversations\/(\d+)\/subscription\/action$/, (m, body) => {
    const action = str(body['action']);
    const key: TKey = action === 'reset-devices' ? 'team.act.devicesReset' : action === 'revoke' ? 'team.act.keyRevoke'
      : action === 'delete-device' ? 'team.act.deviceDelete' : 'team.act.subOther';
    return d('chats', key, { id: m[1]! });
  }],
  ['POST', /^\/api\/conversations\/(\d+)\/bedolaga\/subscriptions\/\d+\/extend$/, (m, body) => {
    const days = Number(body['days']);
    return Number.isFinite(days) && days > 0
      ? d('chats', 'team.act.extend', { id: m[1]!, days: tr('team.days', { n: days }) })
      : d('chats', 'team.act.extendNoDays', { id: m[1]! });
  }],
  ['POST', /^\/api\/filters$/, (_m, body) => d('chats', 'team.act.filterSave', { name: str(body['name']) })],
  ['DELETE', /^\/api\/filters\/\d+$/, () => d('chats', 'team.act.filterDelete')],
  // Помощник
  ['POST', /^\/api\/settings$/, (_m, body, _ctx, state) => settings(body, state)],
  ['POST', /^\/api\/assistant\/pause$/, () => d('assistant', 'team.act.pause')],
  ['DELETE', /^\/api\/assistant\/pause$/, () => d('assistant', 'team.act.resume')],
  ['POST', /^\/api\/ai\/ping$/, () => d('assistant', 'team.act.ping')],
  ['POST', /^\/api\/ai\/try$/, () => d('assistant', 'team.act.try')],
  ['POST', /^\/api\/suggestions\/\d+\/decide$/, (_m, body) => d('assistant', body['status'] === 'rejected' ? 'team.act.suggestRejected' : 'team.act.suggestClosed')],
  ['POST', /^\/api\/messages\/\d+\/feedback$/, () => d('assistant', 'team.act.feedback')],
  // Знания и шаблоны
  ['POST', /^\/api\/kb$/, (_m, body) => d('knowledge', body['draft'] ? 'team.act.kbDraft' : 'team.act.kbCreate', { title: str(body['title']) })],
  ['PUT', /^\/api\/kb\/[^/]+\/([^/]+)$/, (m) => d('knowledge', 'team.act.kbEdit', { name: articleName(m[1]!) })],
  ['DELETE', /^\/api\/kb\/[^/]+\/([^/]+)$/, (m) => d('knowledge', 'team.act.kbDelete', { name: articleName(m[1]!) })],
  ['POST', /^\/api\/kb\/publish\/([^/]+)$/, (m) => d('knowledge', 'team.act.kbPublish', { name: articleName(m[1]!) })],
  ['POST', /^\/api\/kb\/mine$/, () => d('knowledge', 'team.act.kbMine')],
  ['POST', /^\/api\/kb\/mine\/export$/, () => d('knowledge', 'team.act.kbExport')],
  ['POST', /^\/api\/learning\/candidates\/\d+$/, (_m, body) => d('knowledge', body['decision'] === 'rejected' ? 'team.act.ideaRejected' : 'team.act.ideaApproved')],
  ['POST', /^\/api\/templates$/, (_m, body) => d('knowledge', 'team.act.template', { title: str(body['title']) })],
  ['DELETE', /^\/api\/templates\/\d+$/, () => d('knowledge', 'team.act.templateDelete')],
  ['PUT', /^\/api\/interface-kb\/overrides$/, () => d('knowledge', 'team.act.interfaceKb')],
  ['POST', /^\/api\/interface-kb\/images$/, () => d('knowledge', 'team.act.interfaceKb')],
  // Команда
  ['POST', /^\/api\/operators$/, (_m, body) => d('team', 'team.act.personAdd', { name: str(body['name']), role: roleName(str(body['role'])).toLowerCase() })],
  ['POST', /^\/api\/operators\/(\d+)$/, (m, body, ctx) => {
    const name = ctx.operatorName(`op:${m[1]}`) || str(body['name']) || `№${m[1]}`;
    if (body['rotate']) return d('team', 'team.act.personKey', { name });
    if (typeof body['active'] === 'boolean') return d('team', body['active'] ? 'team.act.personOn' : 'team.act.personOff', { name });
    if (str(body['role'])) return d('team', 'team.act.personRole', { name, role: roleName(str(body['role'])).toLowerCase() });
    return d('team', 'team.act.personEdit', { name });
  }],
  ['PUT', /^\/api\/roles\/([^/]+)$/, (m) => d('team', 'team.act.rolePerms', { role: roleName(decode(m[1]!)) })],
  // Настройки и система
  ['PUT', /^\/api\/sla\/([^/]+)$/, (m, body) => {
    const raw = decode(m[1]!);
    const key = PRIORITY[raw];
    const priority = key ? tr(key) : raw;
    const first = Number(body['firstResponseMinutes']);
    const resolution = Number(body['resolutionMinutes']);
    if (Number.isFinite(first) && Number.isFinite(resolution)) {
      return d('settings', 'team.act.sla', { priority, first: duration(first * 60_000), resolution: duration(resolution * 60_000) });
    }
    return d('settings', 'team.act.slaShort', { priority });
  }],
  ['POST', /^\/api\/stats\/reset$/, () => d('settings', 'team.act.statsReset')],
  ['POST', /^\/api\/settings\/services\/[^/]+$/, (_m, body) => (str(body['serviceName'])
    ? d('settings', 'team.act.profileService', { name: str(body['serviceName']) }) : d('settings', 'team.act.profileServiceShort'))],
  ['POST', /^\/api\/settings\/test-alert$/, () => d('settings', 'team.act.alert')],
  ['POST', /^\/api\/sources\/request$/, (_m, body) => {
    const kind = KIND[str(body['kind'])];
    return kind && str(body['name'])
      ? d('settings', 'team.act.source', { kind: tr(kind), name: str(body['name']) }) : d('settings', 'team.act.sourceShort');
  }],
  ['POST', /^\/api\/update\/request$/, (_m, body) => d('settings', body['action'] === 'rollback' ? 'team.act.updateBack' : body['force'] ? 'team.act.updateAgain' : 'team.act.updateRun')],
  ['POST', /^\/api\/nodes\/refresh$/, () => d('settings', 'team.act.nodesRefresh')],
  ['POST', /^\/api\/nodes\/alias$/, (_m, body) => (str(body['alias'])
    ? d('settings', 'team.act.nodeAlias', { alias: str(body['alias']) }) : d('settings', 'team.act.nodeAliasOff'))],
  ['POST', /^\/api\/inbox\/folders$/, (_m, body) => d('settings', body['id'] ? 'team.act.folderEdit' : 'team.act.folderNew', { name: str(body['name']) })],
  ['DELETE', /^\/api\/inbox\/folders\/\d+$/, () => d('settings', 'team.act.folderDelete')],
];

const RESOURCE_GROUP: Record<string, AuditGroup> = {
  conversations: 'chats', attachments: 'chats', filters: 'chats',
  assistant: 'assistant', ai: 'assistant', suggestions: 'assistant', messages: 'assistant',
  kb: 'knowledge', learning: 'knowledge', templates: 'knowledge', 'interface-kb': 'knowledge',
  operators: 'team', roles: 'team',
  settings: 'settings', sources: 'settings', update: 'settings', nodes: 'settings', sla: 'settings', stats: 'settings', inbox: 'settings',
};

function parseBody(payload: string | null): { body: Body; masked: string | null; broken: boolean } {
  if (!payload) return { body: {}, masked: null, broken: false };
  try {
    const parsed: unknown = JSON.parse(payload);
    const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    return { body: isObject ? parsed as Body : {}, masked: JSON.stringify(maskSecrets(parsed), null, 2), broken: false };
  } catch {
    return { body: {}, masked: null, broken: true };
  }
}

function describeOne(event: AuditEvent, body: Body, ctx: AuditContext, state: State): Described {
  if (event.action === 'conversation.claim') {
    return d('chats', body['force'] ? 'team.act.claimForce' : 'team.act.claim', { id: event.resource_id ?? '' });
  }
  const match = /^([A-Z]+) (\/[^?]*)$/.exec(event.action);
  if (match) {
    for (const [method, re, handler] of RULES) {
      if (method !== match[1]) continue;
      const found = re.exec(match[2] ?? '');
      if (found) return handler(found, body, ctx, state);
    }
  }
  const group = RESOURCE_GROUP[event.resource] ?? 'other';
  return group === 'other' ? d('other', 'team.act.unknownAny') : d(group, 'team.act.unknown', { section: tr(GROUP_LABEL[group]) });
}

/**
 * Записи журнала человеческими фразами, новые сверху. Прежний режим помощника
 * («Подсказывает → Отвечает сам») берётся из предыдущей записи об этом режиме.
 */
export function describeEvents(events: readonly AuditEvent[], ctx: AuditContext): AuditLine[] {
  const oldestFirst = [...events].sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  const state: State = {};
  const lines = oldestFirst.map((event): AuditLine => {
    const parsed = parseBody(event.payload);
    const described = describeOne(event, parsed.body, ctx, state);
    return {
      id: event.id, at: event.created_at, whoKey: event.actor_key, who: event.actor_name || tr('team.log.system'),
      group: described.group, text: described.text, action: event.action, section: event.resource,
      body: parsed.masked, bodyBroken: parsed.broken,
    };
  });
  return lines.reverse();
}

export interface LogFilter { who: string; group: AuditGroup | '' }

export const filterLines = (lines: readonly AuditLine[], filter: LogFilter): AuditLine[] =>
  lines.filter((line) => (!filter.who || line.whoKey === filter.who) && (!filter.group || line.group === filter.group));

/** Люди из журнала для фильтра «Кто»: в порядке первого появления (новые первыми). */
export function actorsOf(lines: readonly AuditLine[]): Array<{ key: string; name: string }> {
  const seen = new Map<string, string>();
  for (const line of lines) if (!seen.has(line.whoKey)) seen.set(line.whoKey, line.who);
  return [...seen].map(([key, name]) => ({ key, name }));
}
