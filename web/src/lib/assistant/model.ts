/**
 * Помощник в новой панели (6.7, 6.1): режимы словами, «было → станет»,
 * пресеты паузы, «Вернуть как было» на устройстве, подписи ленты. Чистые
 * функции — их проверяет assistant.test.ts.
 */
import type { Key } from '@/i18n/ru';
import type { ActivityKind, ActivityReason, FeedbackReason } from '@shared/api-types';
import type { AiMode } from '@shared/attention';

/** От осторожного к смелому: «Выключен → Наблюдает → Подсказывает → Отвечает сам». */
export const MODES: readonly AiMode[] = ['off', 'shadow', 'suggest', 'auto'];

export const MODE_LABEL: Record<AiMode, Key> = {
  off: 'assistant.mode.off', shadow: 'assistant.mode.shadow', suggest: 'assistant.mode.suggest', auto: 'assistant.mode.auto',
};
export const MODE_DOES: Record<AiMode, Key> = {
  off: 'assistant.does.off', shadow: 'assistant.does.shadow', suggest: 'assistant.does.suggest', auto: 'assistant.does.auto',
};
export const MODE_CLIENT: Record<AiMode, Key> = {
  off: 'assistant.client.off', shadow: 'assistant.client.shadow', suggest: 'assistant.client.suggest', auto: 'assistant.client.auto',
};

/** К более смелому режиму — только через лист «Что изменится» (асимметрия трения, 6.7). */
export const isBolder = (from: AiMode, to: AiMode): boolean => MODES.indexOf(to) > MODES.indexOf(from);

// --- Осторожность (minConfidence) -----------------------------------------

/** Пять делений шкалы «Смело … Осторожно» (6.7, таблица ключей). */
export const CAUTION_STEPS = [0.4, 0.55, 0.7, 0.8, 0.9] as const;
export const CAUTION_LABEL: readonly Key[] = [
  'assistant.caution.0', 'assistant.caution.1', 'assistant.caution.2', 'assistant.caution.3', 'assistant.caution.4',
];

/** Ближайшее деление к порогу (порог мог быть задан числом в классике). */
export function cautionIndex(threshold: number): number {
  let best = 0;
  CAUTION_STEPS.forEach((step, index) => {
    if (Math.abs(step - threshold) < Math.abs((CAUTION_STEPS[best] ?? 0) - threshold)) best = index;
  });
  return best;
}

// --- Пауза ---------------------------------------------------------------

export type PausePreset = 'hour' | 'morning' | 'forever';
export const MORNING_HOUR = 9;

/** Конец паузы по пресету: «на 1 час», «до утра» (9:00 ближайшего утра), «пока не включу» (null). */
export function pauseUntil(preset: PausePreset, now: number): number | null {
  if (preset === 'forever') return null;
  if (preset === 'hour') return now + 60 * 60_000;
  const morning = new Date(now);
  morning.setHours(MORNING_HOUR, 0, 0, 0);
  // Ночью до 6 утра «до утра» — это сегодняшнее утро, иначе — завтрашнее.
  if (new Date(now).getHours() >= 6) morning.setDate(morning.getDate() + 1);
  return morning.getTime();
}

/** Пауза действует сейчас? Истёкшая — уже нет, даже если кадр о снятии не пришёл. */
export function pauseActive(pause: { until: number | null } | null | undefined, now: number): boolean {
  return Boolean(pause) && (pause!.until === null || pause!.until > now);
}

// --- Настройки и «было → станет» ------------------------------------------

/** Ключи runtime, которые правит раздел «Помощник» (6.7). */
export type SettingKey =
  | 'aiMode' | 'minConfidence' | 'requireKb' | 'humanHoldMinutes' | 'maxAgeMinutes' | 'autoPerHour' | 'handoffRepeatMinutes'
  | 'autoLearn' | 'brand' | 'replyStyle' | 'handoffMessage' | 'model' | 'fallbackModel' | 'customerLinks';

export interface CustomerLink { key: string; title: string; url: string; when: string }

export type AssistantSettings = {
  aiMode: AiMode; minConfidence: number; requireKb: boolean; humanHoldMinutes: number; maxAgeMinutes: number;
  autoPerHour: number; handoffRepeatMinutes: number; autoLearn: boolean; brand: string; replyStyle: string;
  handoffMessage: string; model: string; fallbackModel: string; customerLinks: CustomerLink[];
};

export const SETTING_LABEL: Record<SettingKey, Key> = {
  aiMode: 'assistant.key.aiMode', minConfidence: 'assistant.key.minConfidence', requireKb: 'assistant.key.requireKb',
  humanHoldMinutes: 'assistant.key.humanHold', maxAgeMinutes: 'assistant.key.maxAge', autoPerHour: 'assistant.key.autoPerHour',
  handoffRepeatMinutes: 'assistant.key.handoffRepeat', autoLearn: 'assistant.key.autoLearn', brand: 'assistant.key.brand',
  replyStyle: 'assistant.key.replyStyle', handoffMessage: 'assistant.key.handoffMessage', model: 'assistant.key.model',
  fallbackModel: 'assistant.key.fallbackModel', customerLinks: 'assistant.key.links',
};

/** Внутреннее (не меняет ответы клиентам) сохраняется сразу с «Отменить» (6.7, правило 2). */
export const IMMEDIATE: ReadonlySet<SettingKey> = new Set(['autoLearn']);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Изменённые ключи: то, что попадёт в «Изменено: N». */
export function changedKeys(saved: Partial<AssistantSettings>, draft: Partial<AssistantSettings>): SettingKey[] {
  return (Object.keys(draft) as SettingKey[]).filter((key) => key in saved && !same(saved[key], draft[key]));
}

/** Значение словами для строки «было → станет». t — словарь (подставляется снаружи, чтобы функция осталась чистой). */
export function valueWords(key: SettingKey, value: unknown, t: (key: Key, vars?: Record<string, string | number>) => string): string {
  switch (key) {
    case 'aiMode': return t(MODE_LABEL[value as AiMode] ?? 'assistant.mode.suggest');
    case 'minConfidence': return t(CAUTION_LABEL[cautionIndex(Number(value))] ?? 'assistant.caution.2');
    case 'requireKb':
    case 'autoLearn': return t(value ? 'assistant.on' : 'assistant.off');
    case 'humanHoldMinutes':
    case 'handoffRepeatMinutes': return t('assistant.minutes', { n: Number(value) });
    case 'maxAgeMinutes': return Number(value) % 60 === 0 ? t('assistant.hours', { n: Number(value) / 60 }) : t('assistant.minutes', { n: Number(value) });
    case 'autoPerHour': return Number(value) === 0 ? t('assistant.noLimit') : String(value);
    case 'customerLinks': return t('assistant.linksCount', { n: Array.isArray(value) ? value.length : 0 });
    default: {
      const text = String(value ?? '').replace(/\s+/g, ' ').trim();
      return text.length > 40 ? `«${text.slice(0, 39)}…»` : `«${text}»`;
    }
  }
}

/** «Молчит после ответа: 15 → 30 мин» — строки полосы изменений. */
export function diffLines(saved: Partial<AssistantSettings>, draft: Partial<AssistantSettings>,
  t: (key: Key, vars?: Record<string, string | number>) => string): string[] {
  return changedKeys(saved, draft).map((key) => `${t(SETTING_LABEL[key])}: ${valueWords(key, saved[key], t)} → ${valueWords(key, draft[key], t)}`);
}

// --- «Вернуть как было» (сутки, на этом устройстве) -----------------------

export interface RevertMemo {
  at: number;
  before: Partial<AssistantSettings>;
  after: Partial<AssistantSettings>;
}

export const REVERT_KEY = 'next.assistant.revert';
export const REVERT_MS = 24 * 60 * 60_000;

export function saveRevert(memo: RevertMemo, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try { storage?.setItem(REVERT_KEY, JSON.stringify(memo)); } catch { /* только до перезагрузки */ }
}

export function readRevert(now: number, storage: Pick<Storage, 'getItem'> | null = safeStorage()): RevertMemo | null {
  try {
    const memo = JSON.parse(storage?.getItem(REVERT_KEY) ?? 'null') as RevertMemo | null;
    if (!memo || typeof memo.at !== 'number' || now - memo.at > REVERT_MS || !memo.before || !memo.after) return null;
    return memo;
  } catch { return null; }
}

export function dropRevert(storage: Pick<Storage, 'removeItem'> | null = safeStorage()): void {
  try { storage?.removeItem(REVERT_KEY); } catch { /* нечего чистить */ }
}

/** Ключи, которые с тех пор поменял кто-то другой: значение сейчас ≠ то, что поставили мы. */
export function changedSince(memo: RevertMemo, current: Partial<AssistantSettings>): SettingKey[] {
  return (Object.keys(memo.after) as SettingKey[]).filter((key) => !same(memo.after[key], current[key]));
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

// --- Ссылки для клиентов ---------------------------------------------------

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

/** Метка [[link:…]] из названия: латиница, цифры, «-»; уникальна среди taken. */
export function linkKey(title: string, taken: ReadonlySet<string>): string {
  const base = [...title.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'link';
  let key = base;
  for (let i = 2; taken.has(key); i += 1) key = `${base}-${i}`;
  return key;
}

export const validLinkUrl = (url: string): boolean => /^(?:https?|tg):\/\/\S+$/i.test(url.trim()) && url.trim().length <= 600;

// --- Лента «Что делал помощник» -------------------------------------------

export const KIND_LABEL: Record<ActivityKind, Key> = {
  auto: 'activity.auto', draft: 'activity.draft', draft_sent: 'activity.draftSent', draft_edited: 'activity.draftEdited',
  draft_rejected: 'activity.draftRejected', shadow: 'activity.shadow', handoff: 'activity.handoff', yielded: 'activity.yielded',
  blocked: 'activity.blocked', error: 'activity.error', skipped_old: 'activity.skippedOld',
};

export const REASON_LABEL: Record<ActivityReason, Key> = {
  pause: 'activity.reason.pause', mode: 'activity.reason.mode', sensitive: 'activity.reason.sensitive',
  low_confidence: 'activity.reason.lowConfidence', no_kb: 'activity.reason.noKb', asked_human: 'activity.reason.askedHuman',
  tone: 'activity.reason.tone', important: 'activity.reason.important', hold: 'activity.reason.hold',
  waiting_human: 'activity.reason.waitingHuman', limit: 'activity.reason.limit', window: 'activity.reason.window',
  clarify_again: 'activity.reason.clarifyAgain', internal_data: 'activity.reason.internalData', error: 'activity.reason.error',
  other: 'activity.reason.other',
};

export const FEEDBACK_REASONS: readonly FeedbackReason[] = ['fact', 'tone', 'topic', 'no_kb'];
export const FEEDBACK_LABEL: Record<FeedbackReason, Key> = {
  fact: 'reject.wrongFact', tone: 'reject.tone', topic: 'reject.offTopic', no_kb: 'reject.notInKb',
};

/** Фильтр ленты: всё / ответил сам / передал вам (6.7). */
export type ActivityFilter = 'all' | 'auto' | 'handoff';
export function filterActivity<T extends { kind: ActivityKind }>(items: readonly T[], filter: ActivityFilter): T[] {
  if (filter === 'all') return [...items];
  return items.filter((item) => item.kind === filter);
}

export type Period = 'today' | 'week' | 'month';
/** Начало периода: «Сегодня» — с полуночи, 7 и 30 дней — назад от сейчас. */
export function periodSince(period: Period, now: number): number {
  if (period === 'week') return now - 7 * 24 * 60 * 60_000;
  if (period === 'month') return now - 30 * 24 * 60 * 60_000;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

// --- «Попробовать» и «Как бы он ответил» ----------------------------------

export type TryOutcome = 'send' | 'draft' | 'handoff' | 'skip';

/** Вердикт ворот словами: ушёл бы сразу / лёг бы черновиком / передал бы вам / не ответил бы. */
export function tryOutcome(verdict: { action: string } | undefined, needsHuman: boolean): TryOutcome {
  if (!verdict) return 'skip';
  if (verdict.action === 'auto') return 'send';
  if (verdict.action === 'skip') return 'skip';
  return needsHuman ? 'handoff' : 'draft';
}

export const OUTCOME_LABEL: Record<TryOutcome, Key> = {
  send: 'try.outcome.send', draft: 'try.outcome.draft', handoff: 'try.outcome.handoff', skip: 'try.outcome.skip',
};

// --- «Сегодня» ---------------------------------------------------------------

/** «Пока вас не было» — если вы отсутствовали дольше 30 минут (6.1). */
export const AWAY_MS = 30 * 60_000;
export const LAST_VISIT_KEY = 'next.lastVisit';

export function awaySince(lastVisit: number | null, now: number): number | null {
  if (lastVisit === null || !Number.isFinite(lastVisit)) return null;
  return now - lastVisit > AWAY_MS ? lastVisit : null;
}

