/** «Подключения» (6.11): карточки словом, шаги мастера, проверка полей, пример для клиента, папки. */
import { describe, expect, it } from 'vitest';
import { tr } from '@/i18n/sections/connections';
import type { ConnectionsResponse } from '@shared/api-types';
import {
  businessVerdict, cardsOf, checkFields, checkFolderName, checkProfile, clientPreview, emptyFields, folderChannels, FOLDER_COLORS,
  isEmpty, isFinished, pollTime, requestBody, RUN_STEPS, runStep, safeColor, STALE_POLL_MS, wizardPosition,
} from './model';

const NOW = new Date(2026, 10, 10, 17, 0).getTime();
const at = (h: number, m: number, day = 10): string => String(new Date(2026, 10, day, h, m).getTime());

const base = (): ConnectionsResponse => ({
  sources: [{ id: 'telegram-dev', kind: 'telegram_bot', name: 'Поддержка', enabled: true }],
  serviceProfiles: {},
  businessConnections: [{ id: 'dev-bc', name: 'Анна', username: 'anna_example', enabled: true }],
  remnawave: [{ id: 'remnawave', name: 'Remnawave', readOnly: true }],
  bedolaga: { enabled: true, lastPoll: at(16, 24) },
  minishop: { enabled: false, lastPoll: null },
  sourceManagement: { queued: false, progress: null },
});

describe('карточки: состояние словом', () => {
  it('бот работает, Business подключён, Remnawave — только чтение, MiniShop не подключён', () => {
    const cards = cardsOf(base(), NOW);
    expect(cards.map((card) => [card.title, card.state])).toEqual([
      ['Telegram-бот «Поддержка»', 'работает'],
      ['Telegram Business', 'подключён'],
      ['Bedolaga', 'последний опрос в 16:24'],
      ['Remnawave', 'подключено · только чтение'],
      ['MiniShop', 'не подключён'],
    ]);
  });
  it('выключенный бот, Business выключен или не подключён, Remnawave с действиями', () => {
    const data = base();
    data.sources = [{ id: 'b', kind: 'telegram_bot', name: 'Запасной', enabled: false }];
    data.businessConnections = [{ id: 'x', name: null, username: null, enabled: false }];
    data.remnawave = [{ id: 'r1', name: 'Основная', readOnly: false }, { id: 'r2', name: 'Вторая', readOnly: true }];
    const cards = cardsOf(data, NOW);
    expect(cards[0]?.state).toBe('выключен');
    expect(cards[1]?.state).toBe('выключен');
    expect(cards[3]).toMatchObject({ title: 'Remnawave «Основная»', state: 'подключено · действия разрешены' });
    data.businessConnections = [];
    expect(cardsOf(data, NOW)[1]?.state).toBe('не подключён');
  });
  it('без панели Remnawave и без Bedolaga — «не подключена»', () => {
    const data = base();
    data.remnawave = [];
    data.bedolaga = { enabled: false, lastPoll: null };
    const cards = cardsOf(data, NOW);
    expect(cards.find((card) => card.kind === 'remnawave')).toMatchObject({ state: 'не подключена', connected: false });
    expect(cards.find((card) => card.kind === 'bedolaga')?.state).toBe('не подключена');
  });
  it('время опроса: миллисекунды строкой; вчерашний и давний опрос — с датой и просьбой проверить', () => {
    expect(pollTime(at(16, 24))).toBe(new Date(2026, 10, 10, 16, 24).getTime());
    expect(pollTime('2026-11-10T13:24:00Z')).toBe(Date.parse('2026-11-10T13:24:00Z'));
    expect(pollTime(null)).toBeNull();
    expect(pollTime('не число')).toBeNull();
    const data = base();
    data.bedolaga = { enabled: true, lastPoll: null };
    expect(cardsOf(data, NOW)[2]?.state).toBe('работает');
    data.bedolaga = { enabled: true, lastPoll: at(9, 5) };
    expect(NOW - Number(at(9, 5))).toBeGreaterThan(STALE_POLL_MS);
    const old = cardsOf(data, NOW)[2];
    expect(old?.tone).toBe('attention');
    expect(old?.state).toContain('9:05');
    expect(old?.state).toContain('Проверьте адрес и ключ');
  });
  it('пусто: нет ни одного канала; Business проверяется по включённым', () => {
    const data = base();
    expect(isEmpty(data)).toBe(false);
    const none: ConnectionsResponse = { ...data, sources: [], businessConnections: [], remnawave: [], bedolaga: { enabled: false, lastPoll: null } };
    expect(isEmpty(none)).toBe(true);
    expect(businessVerdict(none)).toBe(false);
    expect(businessVerdict(data)).toBe(true);
  });
});

describe('мастер: шаги и подписи хода', () => {
  it('Ожидает → Копия → Применяется → Проверяется → Подключено', () => {
    expect(RUN_STEPS.map((key) => tr(key))).toEqual(['Ожидает', 'Копия', 'Применяется', 'Проверяется', 'Подключено']);
    expect(['queued', 'backing_up', 'applying', 'checking', 'completed'].map(runStep)).toEqual([0, 1, 2, 3, 4]);
  });
  it('откат и сбой — не шаг, а итог', () => {
    expect(runStep('rolled_back')).toBeNull();
    expect(runStep('failed')).toBeNull();
    expect(['rolled_back', 'failed', 'completed'].every(isFinished)).toBe(true);
    expect(isFinished('checking')).toBe(false);
  });
  it('«1 из 3», «2 из 3», «3 из 3»', () => {
    expect((['pick', 'fields', 'run'] as const).map((stage) => tr('connections.wizard.step', { n: wizardPosition(stage), total: 3 })))
      .toEqual(['1 из 3', '2 из 3', '3 из 3']);
  });
  it('откат со словами сервера', () => {
    expect(tr('connections.run.failed', { detail: 'Проверка не прошла: ключ не подошёл' }))
      .toBe('Не подключилось, вернули как было: Проверка не прошла: ключ не подошёл');
  });
});

describe('проверка полей до отправки', () => {
  const fields = (patch: Partial<ReturnType<typeof emptyFields>>) => ({ ...emptyFields(), ...patch });
  it('бот: ключ вида 123456789:AAAA… (≥20 знаков после двоеточия)', () => {
    const key = `123456789:${'A'.repeat(20)}`;
    expect(checkFields('telegram_bot', fields({ name: 'Поддержка', token: key }))).toEqual({});
    expect(checkFields('telegram_bot', fields({ name: 'Поддержка', token: `123456789:${'A'.repeat(19)}` }))).toEqual({ token: 'botKey' });
    expect(checkFields('telegram_bot', fields({ name: 'Поддержка', token: 'без двоеточия' }))).toEqual({ token: 'botKey' });
    expect(checkFields('telegram_bot', fields({ name: '', token: '' }))).toEqual({ name: 'empty', token: 'empty' });
    expect(checkFields('telegram_bot', fields({ name: 'Имя #1', token: key }))).toEqual({ name: 'chars' });
    expect(checkFields('telegram_bot', fields({ name: 'я'.repeat(121), token: key }))).toEqual({ name: 'long' });
  });
  it('Remnawave и MiniShop: адрес только https (http — лишь для своего компьютера)', () => {
    const ok = { name: 'Панель', token: 'k'.repeat(30) };
    expect(checkFields('remnawave', fields({ ...ok, url: 'https://panel.example.org' }))).toEqual({});
    expect(checkFields('remnawave', fields({ ...ok, url: 'http://panel.example.org' }))).toEqual({ url: 'https' });
    expect(checkFields('remnawave', fields({ ...ok, url: 'http://127.0.0.1:3000' }))).toEqual({});
    expect(checkFields('remnawave', fields({ ...ok, url: 'panel.example.org' }))).toEqual({ url: 'https' });
    expect(checkFields('remnawave', fields({ ...ok, url: '' }))).toEqual({ url: 'empty' });
  });
  it('MiniShop: через плагин ключ не короче 24, в режиме для специалистов — любой', () => {
    const shop = { name: 'Магазин', url: 'https://shop.example.org', token: 'коротко'.padEnd(10, 'x') };
    expect(checkFields('minishop', fields(shop))).toEqual({ token: 'short' });
    expect(checkFields('minishop', fields({ ...shop, mode: 'admin' }))).toEqual({});
    expect(checkFields('minishop', fields({ ...shop, token: 'x'.repeat(24) }))).toEqual({});
  });
  it('Business полей не имеет', () => {
    expect(checkFields('business', emptyFields())).toEqual({});
  });
  it('тело запроса: только нужные поля, «только чтение» по умолчанию включено', () => {
    const key = `123456789:${'B'.repeat(24)}`;
    expect(requestBody('telegram_bot', fields({ name: ' Бот ', token: ` ${key} ` }))).toEqual({ kind: 'telegram_bot', name: 'Бот', token: key });
    expect(requestBody('remnawave', fields({ name: 'П', url: ' https://p.example.org ', token: 'k' }))).toEqual({ kind: 'remnawave', name: 'П', url: 'https://p.example.org', token: 'k', readOnly: true });
    expect(requestBody('minishop', fields({ name: 'М', url: 'https://m.example.org', token: 'k', mode: 'admin' }))).toMatchObject({ kind: 'minishop', mode: 'admin' });
  });
});

describe('«Как мы представляемся»', () => {
  it('пример: вопрос, приветствие, просьба позвать человека, фраза передачи', () => {
    const lines = clientPreview({ serviceName: ' Поддержка ', greetingMessage: 'Привет! Чем помочь?', handoffMessage: 'Зову коллегу.' });
    expect(lines.map((line) => [line.who, line.text])).toEqual([
      ['client', 'Здравствуйте!'], ['bot', 'Привет! Чем помочь?'], ['client', 'Позовите, пожалуйста, человека.'], ['bot', 'Зову коллегу.'],
    ]);
    expect(lines[1]?.label).toBe('Поддержка');
  });
  it('пустые поля — честная пометка, а не выдуманный текст', () => {
    const lines = clientPreview({ serviceName: '', greetingMessage: '', handoffMessage: '' });
    expect(lines[1]?.text).toBe('Приветствие не задано');
    expect(lines[3]?.text).toBe('Фраза не задана');
  });
  it('пределы из контракта: название 1..80, приветствие ≤600, фраза пусто или 5..600', () => {
    const ok = { serviceName: 'Поддержка', greetingMessage: '', handoffMessage: '' };
    expect(checkProfile(ok)).toEqual({});
    expect(checkProfile({ ...ok, serviceName: ' ' })).toEqual({ serviceName: 'empty' });
    expect(checkProfile({ ...ok, serviceName: 'я'.repeat(81) })).toEqual({ serviceName: 'long' });
    expect(checkProfile({ ...ok, greetingMessage: 'я'.repeat(601) })).toEqual({ greetingMessage: 'long' });
    expect(checkProfile({ ...ok, handoffMessage: 'Да' })).toEqual({ handoffMessage: 'short' });
    expect(checkProfile({ ...ok, handoffMessage: 'Зову' + '!'.repeat(1) })).toEqual({});
    expect(checkProfile({ ...ok, handoffMessage: 'я'.repeat(601) })).toEqual({ handoffMessage: 'long' });
  });
});

describe('папки', () => {
  it('образцов цвета 6–8, все в формате #rrggbb и с названиями', () => {
    expect(FOLDER_COLORS.length).toBeGreaterThanOrEqual(6);
    expect(FOLDER_COLORS.length).toBeLessThanOrEqual(8);
    expect(FOLDER_COLORS.every((item) => safeColor(item.value) === item.value && tr(item.name) !== item.name)).toBe(true);
    expect(safeColor('red')).toBeNull();
    expect(safeColor('#2563EB')).toBe('#2563eb');
    expect(safeColor(null)).toBeNull();
  });
  it('каналы папки через « · », пусто — словами', () => {
    const sources = [{ id: 'a', name: 'Поддержка' }, { id: 'b', name: 'Продажи' }];
    expect(folderChannels(['a', 'b'], sources)).toBe('Поддержка · Продажи');
    expect(folderChannels(['x'], sources)).toBe('каналы пока не выбраны');
    expect(folderChannels([], sources)).toBe('каналы пока не выбраны');
  });
  it('название папки 1..80', () => {
    expect(checkFolderName('  ')).toBe('empty');
    expect(checkFolderName('Я'.repeat(81))).toBe('long');
    expect(checkFolderName('VPN')).toBeNull();
  });
});
