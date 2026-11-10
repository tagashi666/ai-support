/** «Система» (6.9): вердикт, сортировка проверок, разбор списка изменений, подписи шагов, сводка серверов, уровни уведомлений. */
import { describe, expect, it, vi } from 'vitest';

// problems.ts тянет живое хранилище, которому при загрузке нужен адрес страницы.
vi.hoisted(() => { (globalThis as Record<string, unknown>).location = { search: '', hostname: 'localhost', pathname: '/' }; });

import {
  actionWords, buildChecks, bytesWords, historyRows, levelHint, levelLabel, NOTIFY_LEVELS, nodeStateWords, overrideRows, parseChangelog,
  pollTime, serversWords, sortChecks, sortNodes, statusWords, stepStates, updateHeadline, verdictOf, verdictTarget,
  type Check, type Diagnostics, type NodeRow, type NodesState,
} from './model';

const diag = (over: Partial<Diagnostics> = {}): Diagnostics => ({
  application: { version: '2.7.0', uptime: 3 * 86400, memory: { rss: 180 * 1024 ** 2, heapUsed: 1, heapTotal: 2 } },
  database: { integrity: 'ok', schema: 12, counts: { conversation: 40, message: 900 }, jobs: [] },
  channels: { tg_bot: true, tg_dm: true, bedolaga: true, minishop: false },
  integrations: { telegram: true, bedolaga: true, minishop: false, remnawave: true, customers: true, nodes: true },
  cursors: { bedolaga: '1731165900000', minishop: null }, kb: 5, settingOverrides: [], ...over,
});
const node = (name: string, over: Partial<NodeRow> = {}): NodeRow => ({ rawName: name.toLowerCase(), name, online: true, disabled: false, alias: null, ...over });
const nodes = (list: NodeRow[]): NodesState => ({ kind: 'ok', snapshot: { at: 1_731_165_900_000, nodes: list } });
const base = { problems: [], now: 1_731_170_000_000 };

describe('вердикт', () => {
  it('всё в порядке: нет неполадок', () => {
    const v = verdictOf(buildChecks({ ...base, diag: diag(), health: { ok: true, kb: 5, businessConnection: true, lastBedolagaPoll: '1731165900000', lastMinishopPoll: null }, nodes: nodes([node('A'), node('B')]), aiKeys: true }));
    expect(v.level).toBe('ok');
    expect(v.title).toBe('Всё в порядке');
  });
  it('сервер не отвечает: «Есть что проверить» с именем в строке ниже', () => {
    const v = verdictOf(buildChecks({ ...base, diag: diag(), nodes: nodes([node('Франкфурт-2', { online: false }), node('B')]) }));
    expect(v.level).toBe('check');
    expect(v.title).toBe('Есть что проверить: 1');
    expect(v.text).toContain('Франкфурт-2');
  });
  it('база нарушена: неисправность', () => {
    const v = verdictOf(buildChecks({ ...base, diag: diag({ database: { integrity: 'row 5 missing', schema: 12, counts: {}, jobs: [] } }) }));
    expect(v.level).toBe('fail');
    expect(v.title).toBe('Есть неисправность');
  });
  it('ни один сервер не отвечает — красное; выключенные не в счёт', () => {
    const checks = buildChecks({ ...base, diag: diag(), nodes: nodes([node('A', { online: false }), node('B', { disabled: true, online: false })]) });
    expect(checks.find((c) => c.id === 'servers')!.tone).toBe('error');
    const only = buildChecks({ ...base, diag: diag(), nodes: nodes([node('B', { disabled: true, online: false }), node('C')]) });
    expect(only.find((c) => c.id === 'servers')!.tone).toBe('ok');
  });
  it('сигнал сервера поднимает проверку; неизвестный код не теряется', () => {
    const checks = buildChecks({ ...base, diag: diag(), problems: [{ code: 'job_failed', severity: 'warn', count: 1, subject: 'mine', at: null }] });
    expect(checks.find((c) => c.id === 'jobs')!.tone).toBe('warn');
    const upd = buildChecks({ ...base, diag: diag(), problems: [{ code: 'update_failed', severity: 'warn', count: 1, subject: '2.8.0', at: null }] });
    expect(upd.find((c) => c.id === 'update')!.link).toBe('update');
  });
  it('ошибка опроса серверов и сбой уведомлений видны; нет права — проверки нет', () => {
    const checks = buildChecks({ ...base, diag: diag(), nodes: null, notifications: { configured: true, level: 'all', lastError: 'chat not found' } });
    expect(checks.find((c) => c.id === 'servers')!.tone).toBe('warn');
    expect(checks.find((c) => c.id === 'notifications')!.tone).toBe('error');
    expect(buildChecks({ ...base, diag: diag() }).some((c) => c.id === 'servers')).toBe(false);
  });
  it('«Подробнее» ведёт на вкладку первой неполадки', () => {
    const checks = buildChecks({ ...base, diag: diag(), nodes: nodes([node('A', { online: false }), node('B')]) });
    expect(verdictTarget(checks)).toBe('servers');
    expect(verdictTarget(buildChecks({ ...base, diag: diag() }))).toBeUndefined();
  });
});

describe('проверки', () => {
  const mk = (id: Check['id'], tone: Check['tone']): Check => ({ id, tone, title: id, summary: '', details: [] });
  it('красное, потом янтарное, потом остальное; порядок внутри сохраняется', () => {
    const sorted = sortChecks([mk('app', 'ok'), mk('bot', 'off'), mk('kb', 'warn'), mk('jobs', 'error'), mk('model', 'warn')]);
    expect(sorted.map((c) => c.id)).toEqual(['jobs', 'kb', 'model', 'app', 'bot']);
  });
  it('все карточки классических «Интеграций» находят место', () => {
    const checks = buildChecks({
      ...base, diag: diag(), health: { ok: true, kb: 5, businessConnection: true, lastBedolagaPoll: null, lastMinishopPoll: null },
      nodes: nodes([node('A')]), notifications: { configured: true, level: 'all', lastError: null }, aiKeys: true,
      connections: { sources: [], serviceProfiles: {}, businessConnections: [], remnawave: [{ id: 'r', name: 'R', readOnly: true }], bedolaga: { enabled: true, lastPoll: null }, minishop: { enabled: false, lastPoll: null }, sourceManagement: { queued: false, progress: null } },
    });
    expect(checks.map((c) => c.id).sort()).toEqual(['app', 'bedolaga', 'bot', 'business', 'database', 'jobs', 'kb', 'minishop', 'model', 'notifications', 'remnawave', 'servers']);
    expect(checks.find((c) => c.id === 'remnawave')!.summary).toContain('только чтение');
  });
  it('опрос — время, а не сырая строка', () => {
    expect(pollTime('1731165900000')).toBe(1731165900000);
    expect(pollTime(null)).toBeNull();
    expect(pollTime('мусор')).toBeNull();
  });
});

describe('единицы и серверы', () => {
  it('размеры словами', () => {
    expect(bytesWords(0)).toBe('0 Б');
    expect(bytesWords(180 * 1024 ** 2)).toBe('180 МБ');
    expect(bytesWords(1536 * 1024 ** 2)).toBe('1,5 ГБ');
  });
  it('сводка серверов', () => {
    expect(serversWords([node('A'), node('B', { online: false }), node('C', { disabled: true, online: false })])).toBe('1 из 3 отвечает, 1 выключен');
    expect(serversWords([node('A'), node('B')])).toBe('2 из 2 отвечают');
    expect(serversWords([])).toBe('серверов нет');
  });
  it('порядок: не отвечающие сверху, выключенные внизу; подписи состояний', () => {
    const list = sortNodes([node('Off', { disabled: true, online: false }), node('Ok'), node('Down', { online: false })]);
    expect(list.map((n) => n.name)).toEqual(['Down', 'Ok', 'Off']);
    expect(list.map(nodeStateWords)).toEqual(['не отвечает', 'в сети', 'выключен']);
  });
});

describe('обновление', () => {
  it('список изменений: простой текст пунктами, без разметки и HTML', () => {
    const md = '## Что нового\n\n- **Отчёты** и [сроки](https://example.org/x)\n* <b>Система</b>: серверы\n1. Исправлено `уведомление`\n\n---\n<script>alert(1)</script>';
    expect(parseChangelog(md)).toEqual(['Отчёты и сроки', 'Система: серверы', 'Исправлено уведомление', 'alert(1)']);
    expect(parseChangelog(null)).toEqual([]);
    expect(parseChangelog('# Только заголовок')).toEqual([]);
  });
  it('подписи шагов', () => {
    expect(['queued', 'backing_up', 'installing', 'checking', 'completed', 'rolled_back', 'failed'].map(statusWords))
      .toEqual(['Ожидает', 'Копия', 'Установка', 'Проверка', 'Готово', 'Вернули как было', 'Ошибка']);
  });
  it('ход: пройденные, текущий, оставшиеся', () => {
    const at = (status: 'queued' | 'installing' | 'completed' | 'rolled_back') => stepStates({ action: 'update', status }).map((s) => s.state);
    expect(at('queued')).toEqual(['current', 'todo', 'todo', 'todo']);
    expect(at('installing')).toEqual(['done', 'done', 'current', 'todo']);
    expect(at('completed')).toEqual(['done', 'done', 'done', 'done']);
    expect(stepStates(null).every((s) => s.state === 'todo')).toBe(true);
  });
  it('заголовок, действия и история', () => {
    const info = { enabled: true, current: '2.7.0', available: true, reinstallable: true, queued: false, latest: '2.8.0', name: null, publishedAt: null, changelog: null, progress: null };
    expect(updateHeadline(info)).toBe('Сейчас 2.7.0. Вышла 2.8.0.');
    expect(updateHeadline({ ...info, available: false })).toBe('Сейчас 2.7.0. Это последняя версия.');
    expect(actionWords('rollback')).toBe('Откат');
    const rows = historyRows([{ id: 1, action: 'update', version: '2.7.0', status: 'completed', detail: null, created_at: 1_731_165_900_000 }]);
    expect(rows[0]!.text).toBe('Обновление до 2.7.0');
    expect(rows[0]!.status).toBe('Готово');
  });
});

describe('уведомления и настройки', () => {
  it('подписи уровней различаются и непустые', () => {
    const labels = NOTIFY_LEVELS.map(levelLabel);
    expect(new Set(labels).size).toBe(3);
    expect(labels).toEqual(['Каждое событие', 'Только то, что требует вмешательства', 'Только передачи и просрочки']);
    expect(NOTIFY_LEVELS.every((l) => levelHint(l).length > 20)).toBe(true);
  });
  it('настройки поверх файла: человеческие подписи, сырой ключ отдельно', () => {
    const rows = overrideRows([{ key: 'aiMode', value: 'auto', env: 'off' }, { key: 'requireKb', value: true, env: false }, { key: 'zzz', value: 1, env: 0 }]);
    expect(rows[0]).toEqual({ key: 'aiMode', label: 'Режим помощника по умолчанию', value: 'auto' });
    expect(rows[1]!.value).toBe('да');
    expect(rows[2]!.label).toBe('Другая настройка');
  });
});
