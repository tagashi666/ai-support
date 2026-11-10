/**
 * «Подключения» (6.11): чистая модель — состояние карточки словом, шаги мастера,
 * проверка полей до отправки, пример «Так это увидит клиент», цвета папок.
 */
import { tr } from '@/i18n/sections/connections';
import { clock, dayMonth, sameDay } from '@/lib/format/format';
import type { ConnectionsResponse } from '@shared/api-types';

export type Tone = 'ok' | 'off' | 'attention';
export type CardKind = 'bot' | 'business' | 'bedolaga' | 'remnawave' | 'minishop';

export interface ConnectionCard {
  id: string;
  kind: CardKind;
  title: string;
  /** Состояние словом: «работает», «подключён», «последний опрос в 16:24»… */
  state: string;
  tone: Tone;
  /** Есть что подключить / настроить (пустая карточка MiniShop, Bedolaga). */
  connected: boolean;
  sourceId?: string;
}

/** Опрос старше этого срока считаем давним: карточка просит проверить. */
export const STALE_POLL_MS = 2 * 60 * 60_000;

/** Время последнего опроса из состояния сервера: миллисекунды строкой («1731234567890») или дата. */
export function pollTime(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const text = raw.trim();
  const value = /^\d{9,}$/.test(text) ? Number(text) : Date.parse(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** «16:24» сегодня, «5 ноября, 16:24» раньше. */
export function pollMoment(at: number, now: number): string {
  return sameDay(at, now) ? clock(at) : `${dayMonth(at)}, ${clock(at)}`;
}

function polled(connection: { enabled: boolean; lastPoll: string | null }, now: number): { state: string; tone: Tone } {
  const at = pollTime(connection.lastPoll);
  if (at === null) return { state: tr('connections.state.working'), tone: 'ok' };
  if (now - at > STALE_POLL_MS) return { state: tr('connections.state.pollOld', { at: pollMoment(at, now) }), tone: 'attention' };
  return { state: tr('connections.state.pollAt', { at: pollMoment(at, now) }), tone: 'ok' };
}

/** Карточки по ответу /api/connections. Порядок: боты, Business, Bedolaga, Remnawave, MiniShop. */
export function cardsOf(data: ConnectionsResponse, now: number): ConnectionCard[] {
  const cards: ConnectionCard[] = [];
  for (const source of data.sources.filter((item) => item.kind === 'telegram_bot')) {
    cards.push({
      id: `bot:${source.id}`, kind: 'bot', sourceId: source.id, connected: true,
      title: tr('connections.card.bot', { name: source.name }),
      state: source.enabled ? tr('connections.state.working') : tr('connections.state.disabled'),
      tone: source.enabled ? 'ok' : 'off',
    });
  }
  const business = data.businessConnections;
  const active = business.filter((item) => item.enabled);
  cards.push({
    id: 'business', kind: 'business', connected: active.length > 0, title: tr('connections.card.business'),
    state: active.length > 0 ? tr('connections.state.connected') : business.length > 0 ? tr('connections.state.disabled') : tr('connections.state.none'),
    tone: active.length > 0 ? 'ok' : 'off',
  });
  if (data.bedolaga.enabled) {
    cards.push({ id: 'bedolaga', kind: 'bedolaga', connected: true, title: tr('connections.card.bedolaga'), ...polled(data.bedolaga, now) });
  } else {
    cards.push({ id: 'bedolaga', kind: 'bedolaga', connected: false, title: tr('connections.card.bedolaga'), state: tr('connections.state.noneF'), tone: 'off' });
  }
  for (const panel of data.remnawave) {
    cards.push({
      id: `remnawave:${panel.id}`, kind: 'remnawave', connected: true, title: data.remnawave.length > 1 ? tr('connections.card.remnawaveNamed', { name: panel.name }) : tr('connections.card.remnawave'),
      state: panel.readOnly ? tr('connections.state.readOnly') : tr('connections.state.actions'), tone: 'ok',
    });
  }
  if (data.remnawave.length === 0) {
    cards.push({ id: 'remnawave', kind: 'remnawave', connected: false, title: tr('connections.card.remnawave'), state: tr('connections.state.noneF'), tone: 'off' });
  }
  if (data.minishop.enabled) {
    cards.push({ id: 'minishop', kind: 'minishop', connected: true, title: tr('connections.card.minishop'), ...polled(data.minishop, now) });
  } else {
    cards.push({ id: 'minishop', kind: 'minishop', connected: false, title: tr('connections.card.minishop'), state: tr('connections.state.none'), tone: 'off' });
  }
  return cards;
}

/** Нет ни одного подключённого канала или источника — экран пустого состояния. */
export function isEmpty(data: ConnectionsResponse): boolean {
  return data.sources.length === 0 && data.businessConnections.every((item) => !item.enabled)
    && !data.bedolaga.enabled && !data.minishop.enabled && data.remnawave.length === 0;
}

/** Ответ «Проверить подключение» у Business. */
export function businessVerdict(data: ConnectionsResponse): boolean {
  return data.businessConnections.some((item) => item.enabled);
}

// --- мастер ---------------------------------------------------------------

export type WizardKind = 'telegram_bot' | 'business' | 'remnawave' | 'minishop';
export const WIZARD_KINDS: readonly WizardKind[] = ['telegram_bot', 'business', 'remnawave', 'minishop'];
export type SourceStatus = 'queued' | 'backing_up' | 'applying' | 'checking' | 'completed' | 'rolled_back' | 'failed';

/** Ключи подписей хода: Ожидает → Копия → Применяется → Проверяется → Подключено. */
export const RUN_STEPS = [
  'connections.run.queued', 'connections.run.backup', 'connections.run.applying', 'connections.run.checking', 'connections.run.done',
] as const;

/** Номер шага хода по статусу сервера; null — откат или сбой. */
export function runStep(status: string): number | null {
  switch (status) {
    case 'queued': return 0;
    case 'backing_up': return 1;
    case 'applying': return 2;
    case 'checking': return 3;
    case 'completed': return 4;
    default: return null;
  }
}

export const isFinished = (status: string): boolean => status === 'completed' || status === 'rolled_back' || status === 'failed';

/** Номер шага мастера из трёх: выбор, поля (инструкция), ход (проверка). */
export function wizardPosition(stage: 'pick' | 'fields' | 'run'): number {
  return stage === 'pick' ? 1 : stage === 'fields' ? 2 : 3;
}

export interface WizardFields {
  name: string;
  url: string;
  token: string;
  readOnly: boolean;
  mode: 'plugin' | 'admin';
}

export const emptyFields = (): WizardFields => ({ name: '', url: '', token: '', readOnly: true, mode: 'plugin' });

export type FieldCode = 'empty' | 'long' | 'chars' | 'botKey' | 'https' | 'short';
export type FieldErrors = Partial<Record<'name' | 'url' | 'token', FieldCode>>;

/** Ключ бота вида 123456789:AAAA… — как проверяет сервер. */
export const BOT_KEY = /^\d{5,15}:[A-Za-z0-9_-]{20,}$/;

function addressCode(value: string): FieldCode | null {
  const text = value.trim();
  if (!text) return 'empty';
  if (text.length > 1000 || /[\r\n\0#]/.test(text)) return 'chars';
  let parsed: URL;
  try { parsed = new URL(text); } catch { return 'https'; }
  if (parsed.protocol === 'https:') return null;
  return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname) ? null : 'https';
}

/** Проверка полей до отправки: те же правила, что у сервера (src/core/sources.ts). */
export function checkFields(kind: WizardKind, fields: WizardFields): FieldErrors {
  const errors: FieldErrors = {};
  if (kind === 'business') return errors;
  const name = fields.name.trim();
  if (!name) errors.name = 'empty';
  else if (name.length > 120) errors.name = 'long';
  else if (/[\r\n\0#]/.test(name)) errors.name = 'chars';
  const token = fields.token.trim();
  if (kind === 'telegram_bot') {
    if (!token) errors.token = 'empty';
    else if (!BOT_KEY.test(token)) errors.token = 'botKey';
  } else {
    const address = addressCode(fields.url);
    if (address) errors.url = address;
    if (!token) errors.token = 'empty';
    else if (/[\r\n\0#]/.test(token)) errors.token = 'chars';
    else if (kind === 'minishop' && fields.mode === 'plugin' && token.length < 24) errors.token = 'short';
  }
  return errors;
}

/** Тело POST /api/sources/request. Ключ попадает только сюда. */
export function requestBody(kind: Exclude<WizardKind, 'business'>, fields: WizardFields): Record<string, unknown> {
  const base = { kind, name: fields.name.trim(), token: fields.token.trim() };
  if (kind === 'telegram_bot') return base;
  const url = fields.url.trim();
  return kind === 'remnawave' ? { ...base, url, readOnly: fields.readOnly } : { ...base, url, mode: fields.mode };
}

// --- «Как мы представляемся» ----------------------------------------------

export interface Profile {
  serviceName: string;
  greetingMessage: string;
  handoffMessage: string;
}

export const PROFILE_LIMITS = { name: 80, greeting: 600, handoffMin: 5, handoff: 600 } as const;
export type ProfileCode = 'empty' | 'long' | 'short';
export type ProfileErrors = Partial<Record<'serviceName' | 'greetingMessage' | 'handoffMessage', ProfileCode>>;

export function checkProfile(profile: Profile): ProfileErrors {
  const errors: ProfileErrors = {};
  const name = profile.serviceName.trim();
  if (!name) errors.serviceName = 'empty';
  else if (name.length > PROFILE_LIMITS.name) errors.serviceName = 'long';
  if (profile.greetingMessage.trim().length > PROFILE_LIMITS.greeting) errors.greetingMessage = 'long';
  const handoff = profile.handoffMessage.trim();
  if (handoff && handoff.length < PROFILE_LIMITS.handoffMin) errors.handoffMessage = 'short';
  else if (handoff.length > PROFILE_LIMITS.handoff) errors.handoffMessage = 'long';
  return errors;
}

export const sameProfile = (a: Profile, b: Profile): boolean =>
  a.serviceName.trim() === b.serviceName.trim() && a.greetingMessage.trim() === b.greetingMessage.trim() && a.handoffMessage.trim() === b.handoffMessage.trim();

export interface PreviewLine {
  who: 'client' | 'bot';
  text: string;
  /** Подпись над репликой бота — название сервиса. */
  label?: string;
}

/** «Так это увидит клиент»: вопрос, приветствие, просьба позвать человека, фраза передачи. */
export function clientPreview(profile: Profile): PreviewLine[] {
  const name = profile.serviceName.trim() || tr('connections.preview.noName');
  const greeting = profile.greetingMessage.trim();
  const handoff = profile.handoffMessage.trim();
  return [
    { who: 'client', text: tr('connections.preview.hello') },
    { who: 'bot', label: name, text: greeting || tr('connections.preview.noGreeting') },
    { who: 'client', text: tr('connections.preview.human') },
    { who: 'bot', label: name, text: handoff || tr('connections.preview.noHandoff') },
  ];
}

// --- папки ----------------------------------------------------------------

/** Образцы цвета папки: в базе лежит строка #rrggbb, имена — для чтения с экрана. */
export const FOLDER_COLORS: ReadonlyArray<{ value: string; name: Parameters<typeof tr>[0] }> = [
  { value: '#2563eb', name: 'connections.color.blue' },
  { value: '#0f766e', name: 'connections.color.teal' },
  { value: '#15803d', name: 'connections.color.green' },
  { value: '#b45309', name: 'connections.color.amber' },
  { value: '#c2410c', name: 'connections.color.orange' },
  { value: '#be123c', name: 'connections.color.red' },
  { value: '#7c3aed', name: 'connections.color.violet' },
  { value: '#475569', name: 'connections.color.gray' },
];

const HEX = /^#[0-9a-f]{6}$/i;
export const safeColor = (value: string | null | undefined): string | null => (value && HEX.test(value) ? value.toLowerCase() : null);

/** Название папки для списка: «Бот» и каналы через « · ». */
export function folderChannels(sourceIds: readonly string[], sources: ReadonlyArray<{ id: string; name: string }>): string {
  const names = sourceIds.map((id) => sources.find((source) => source.id === id)?.name).filter((name): name is string => Boolean(name));
  return names.length > 0 ? names.join(' · ') : tr('connections.folders.noChannels');
}

export function checkFolderName(name: string): 'empty' | 'long' | null {
  const text = name.trim();
  return !text ? 'empty' : text.length > 80 ? 'long' : null;
}
