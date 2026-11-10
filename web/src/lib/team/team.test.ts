/** Команда (6.10): журнал словами, маскирование, «может / не может», разница прав, «затронет N человек». */
import { describe, expect, it } from 'vitest';
import { tr, trn } from '@/i18n/sections/team';
import {
  actorsOf, affectedPeople, canWords, describeEvents, diffPerms, filterLines, maskSecrets, normalizePerms, permGroups,
  roleName, ROLES, sameSet, type AuditEvent,
} from './model';

let seq = 0;
function ev(action: string, payload: unknown, extra: Partial<AuditEvent> = {}): AuditEvent {
  seq += 1;
  const parts = action.split(' ')[1]?.split('/').filter(Boolean) ?? [];
  return {
    id: seq, actor_key: 'op:1', actor_name: 'Мария', actor_role: 'lead', action, resource: parts[1] ?? 'api',
    resource_id: parts[2] ?? null, payload: payload === undefined ? null : JSON.stringify(payload), ip: '203.0.113.5',
    created_at: 1_000 + seq, ...extra,
  };
}
const ctx = { operatorName: (key: string) => (key === 'op:2' ? 'Пётр' : undefined) };
const text = (event: AuditEvent): string => describeEvents([event], ctx)[0]!.text;

describe('журнал словами', () => {
  it('режим помощника: из предыдущей записи видно «было → стало»', () => {
    const lines = describeEvents([
      ev('POST /api/settings', { aiMode: 'suggest' }),
      ev('POST /api/settings', { aiMode: 'auto' }),
    ], ctx);
    expect(lines[0]!.text).toBe('изменил(а) режим помощника: Подсказывает → Отвечает сам');
    expect(lines[1]!.text).toBe('изменил(а) режим помощника: теперь подсказывает');
  });
  it('десяток типов действий', () => {
    expect(text(ev('PUT /api/sla/high', { firstResponseMinutes: 15, resolutionMinutes: 120 })))
      .toBe('изменил(а) сроки ответа (высокая): первый ответ — 15 мин, решение — 2 ч');
    expect(text(ev('POST /api/conversations/3/reply', { text: 'секрет клиента' }))).toBe('ответил(а) в диалоге №3');
    expect(text(ev('POST /api/operators', { name: 'Ольга', role: 'agent' }))).toBe('добавил(а) человека: Ольга, оператор');
    expect(text(ev('POST /api/operators/2', { rotate: true }))).toBe('выдал(а) новый ключ входа: Пётр');
    expect(text(ev('POST /api/operators/2', { active: false }))).toBe('отключил(а) доступ: Пётр');
    expect(text(ev('POST /api/operators/2', { active: true }))).toBe('вернул(а) доступ: Пётр');
    expect(text(ev('POST /api/kb/publish/skorost.md', {}))).toBe('опубликовал(а) статью skorost');
    expect(text(ev('POST /api/nodes/alias', { name: 'x', alias: 'Основной' }))).toBe('назвал(а) сервер «Основной»');
    expect(text(ev('POST /api/nodes/alias', { name: 'x', alias: '' }))).toBe('убрал(а) своё название сервера');
    expect(text(ev('POST /api/update/request', { action: 'rollback' }))).toBe('запустил(а) откат обновления');
    expect(text(ev('POST /api/conversations/5/state', { status: 'resolved', escalated: false })))
      .toBe('поставил(а) диалогу №5 статус «решён»; снял(а) отметку «важно» с диалога №5');
    expect(text(ev('POST /api/conversations/5/state', { aiMode: 'auto' }))).toBe('изменил(а) режим помощника в диалоге №5: отвечает сам');
    expect(text(ev('PUT /api/roles/agent', { permissions: ['conversation:read'] }))).toBe('изменил(а) права роли «Оператор»');
    expect(text(ev('conversation.claim', { force: true }, { resource_id: '7' }))).toBe('перехватил(а) диалог №7');
  });
  it('настройки помощника: значения словами, без ключей и чисел из тела', () => {
    expect(text(ev('POST /api/settings', { autoLearn: false }))).toBe('изменил(а) настройку помощника «обучение на закрытых диалогах»: выключено');
    expect(text(ev('POST /api/settings', { brand: 'X', replyStyle: 'Y' }))).toBe('изменил(а) настройки помощника: название сервиса, манеру ответов');
    expect(text(ev('POST /api/settings', { modelKey: 'sk-secret' }))).not.toContain('sk-secret');
  });
  it('неизвестное действие: по разделу, иначе общими словами; ни пути, ни кода на экране', () => {
    const unknown = text(ev('POST /api/settings/что-то-новое', {}, { resource: 'settings' }));
    expect(unknown).toBe('сделал(а) действие в разделе «Система»');
    expect(text(ev('POST /api/неведомо', {}, { resource: 'неведомо' }))).toBe('сделал(а) действие в панели');
    expect(unknown).not.toMatch(/api|POST/);
  });
  it('новые записи сверху; без имени — «Система»', () => {
    const lines = describeEvents([ev('POST /api/stats/reset', {}), ev('POST /api/stats/reset', {}, { actor_name: '' })], ctx);
    expect(lines[0]!.id).toBeGreaterThan(lines[1]!.id);
    expect(lines[0]!.who).toBe('Система');
  });
  it('фильтры «кто» и «что»; список людей из журнала', () => {
    const lines = describeEvents([
      ev('POST /api/conversations/1/reply', {}),
      ev('POST /api/kb/publish/a.md', {}, { actor_key: 'op:2', actor_name: 'Пётр' }),
    ], ctx);
    expect(filterLines(lines, { who: 'op:2', group: '' })).toHaveLength(1);
    expect(filterLines(lines, { who: '', group: 'chats' })[0]!.who).toBe('Мария');
    expect(filterLines(lines, { who: 'op:1', group: 'knowledge' })).toHaveLength(0);
    expect(actorsOf(lines).map((a) => a.name)).toEqual(['Пётр', 'Мария']);
  });
});

describe('маскирование', () => {
  it('token / key / secret на любой глубине, остальное остаётся', () => {
    const masked = maskSecrets({ token: 'abc', nested: { apiKey: 'k', modelKey: 'm', password: 'p', name: 'ok' }, list: [{ secret: 's' }] });
    expect(JSON.stringify(masked)).not.toMatch(/abc|"k"|"m"|"p"|"s"/);
    expect((masked as { nested: { name: string } }).nested.name).toBe('ok');
  });
  it('«Как есть» не содержит секретов, длинные строки обрезаны', () => {
    const line = describeEvents([ev('POST /api/sources/request', { kind: 'remnawave', name: 'Панель', token: 'TOPSECRET', text: 'я'.repeat(500) })], ctx)[0]!;
    expect(line.body).not.toContain('TOPSECRET');
    expect(line.body).toContain('••••');
    expect(line.body!.length).toBeLessThan(500);
    expect(line.text).toBe('запросил(а) подключение: Remnawave «Панель»');
  });
  it('битое тело не роняет разбор', () => {
    const line = describeEvents([{ ...ev('POST /api/stats/reset', {}), payload: '{oops' }], ctx)[0]!;
    expect(line.bodyBroken).toBe(true);
    expect(line.body).toBeNull();
  });
});

const DEFAULT_VIEWER = ['conversation:read', 'queue:read', 'templates:read', 'knowledge:read', 'stats:read', 'settings:read'];

describe('«может / не может»', () => {
  it('Наблюдатель только читает', () => {
    const { can, cannot } = canWords(DEFAULT_VIEWER);
    expect(can).toEqual(['смотреть общие отчёты']);
    expect(cannot).toContain('отвечать клиентам');
    expect(cannot).toContain('менять настройки помощника');
  });
  it('любое право на параметр помощника включает «менять настройки помощника»', () => {
    expect(canWords([...DEFAULT_VIEWER, 'setting:brand']).can).toContain('менять настройки помощника');
  });
  it('повседневное — раньше управления', () => {
    const { can } = canWords(['conversation:reply', 'roles:manage', 'knowledge:manage']);
    expect(can).toEqual(['отвечать клиентам', 'править знания', 'менять права ролей']);
  });
  it('порядок ролей один: Администратор, Руководитель, Оператор, Наблюдатель', () => {
    expect(ROLES.map(roleName)).toEqual(['Администратор', 'Руководитель', 'Оператор', 'Наблюдатель']);
    expect(roleName('что-то')).toBe('Сотрудник');
  });
});

describe('права: было → станет', () => {
  const order = ['conversation:read', 'conversation:reply', 'knowledge:read', 'knowledge:manage', 'stats:read'];
  it('разница в порядке каталога', () => {
    const diff = diffPerms(['conversation:read', 'stats:read'], ['conversation:read', 'knowledge:manage', 'knowledge:read'], order);
    expect(diff).toEqual({ added: ['knowledge:read', 'knowledge:manage'], removed: ['stats:read'] });
  });
  it('зависимые права добавляются сами, как у сервера', () => {
    const after = normalizePerms(['knowledge:manage']);
    expect([...after].sort()).toEqual(['knowledge:manage', 'knowledge:read']);
    expect(normalizePerms(['setting:brand']).has('settings:read')).toBe(true);
    expect(normalizePerms(['roles:manage']).has('team:read')).toBe(true);
    expect(normalizePerms(['bedolaga:extend'])).toEqual(new Set(['bedolaga:extend', 'bedolaga:view', 'conversation:read']));
  });
  it('без изменений — пусто; sameSet не зависит от порядка', () => {
    expect(diffPerms(['a', 'b'], ['b', 'a'], [])).toEqual({ added: [], removed: [] });
    expect(sameSet(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameSet(['a'], ['a', 'b'])).toBe(false);
  });
  it('«Затронет N человек»: только с этой ролью и с открытым доступом', () => {
    const people = [
      { id: 1, name: 'Мария', role: 'agent', active: 1 }, { id: 2, name: 'Пётр', role: 'agent', active: 1 },
      { id: 3, name: 'Софья', role: 'agent', active: 0 }, { id: 4, name: 'Иван', role: 'lead', active: 1 },
    ];
    const hit = affectedPeople(people, 'agent');
    expect(hit.map((p) => p.name)).toEqual(['Мария', 'Пётр']);
    expect(tr('team.roles.affects', { n: hit.length, people: trn('team.roles.people', hit.length), names: 'Мария, Пётр' }))
      .toBe('Затронет 2 человека: Мария, Пётр.');
    expect([1, 2, 5, 21].map((n) => `${n} ${trn('team.roles.people', n)}`)).toEqual(['1 человека', '2 человека', '5 человек', '21 человека']);
    expect(affectedPeople(people, 'viewer')).toEqual([]);
  });
});

describe('подписи прав', () => {
  it('группы каталога называются по-человечески, без латиницы и жаргона', () => {
    const groups = permGroups([
      { id: 'conversation:read', group: 'Диалоги', label: 'x' },
      { id: 'queue:manage', group: 'Очередь и SLA', label: 'Изменять сроки SLA' },
      { id: 'setting:model', group: 'Параметры AI', label: 'Основная модель AI' },
      { id: 'новое:право', group: 'Новая группа', label: 'Сделать что-то' },
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Диалоги', 'Очередь и сроки ответа', 'Настройки помощника', 'Прочее']);
    expect(groups[1]!.items[0]!.label).toBe('Менять сроки ответа');
    expect(groups[3]!.items[0]!.label).toBe('Сделать что-то');
  });
});
