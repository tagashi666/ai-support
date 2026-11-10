/**
 * Помощник на живых данных: настройки (GET/POST /api/settings), пауза
 * (10.4 п.1), «Вернуть как было», лента и «Это неверно». Права — из
 * bootstrap: без права кнопки не рисуются, сервер всё равно проверит.
 */
import { computed, effect, signal } from '@preact/signals';
import { t } from '@/i18n/ru';
import { showToast, undoToast } from '@/lib/actions/toasts';
import { ApiError, getJson, readToken, sendJson } from '@/lib/live/api';
import { liveName } from '@/lib/live/labels';
import { bootstrap, connection, listenSettings, liveItems, mode } from '@/lib/live/store';
import type {
  ActivityResponse, AssistantPauseResponse, AssistantSettingsResponse, FeedbackReason, FeedbackResponse,
} from '@shared/api-types';
import {
  changedSince, dropRevert, IMMEDIATE, pauseActive, pauseUntil, readRevert, saveRevert,
  type AssistantSettings, type PausePreset, type RevertMemo, type SettingKey,
} from './model';

const token = (): string => readToken() ?? '';
const KEYS: readonly SettingKey[] = [
  'aiMode', 'minConfidence', 'requireKb', 'humanHoldMinutes', 'maxAgeMinutes', 'autoPerHour', 'handoffRepeatMinutes',
  'autoLearn', 'brand', 'replyStyle', 'handoffMessage', 'model', 'fallbackModel', 'customerLinks',
];

export const settings = signal<AssistantSettings | null>(null);
export const settingsState = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
/** Прочие сведения из /api/settings для «Для специалистов». */
export const aiInfo = signal<{ keys: number; kb: number } | null>(null);
/** «Вернуть как было» — сутки на этом устройстве (6.7). */
export const revertMemo = signal<RevertMemo | null>(readRevert(Date.now()));
/** Кто последним менял режим или паузу из другого места (кадр settings). */
export const changedBy = signal<{ name: string; at: number } | null>(null);
/** Тик для пересчёта «пауза истекла» без кадра. */
export const clockTick = signal(Date.now());
if (typeof setInterval === 'function') setInterval(() => { clockTick.value = Date.now(); }, 30_000);
// L-10: конец паузы — ровно в срок, а не на следующем тике раз в 30 с.
let pauseTimer: ReturnType<typeof setTimeout> | undefined;
effect(() => {
  const until = bootstrap.value?.assistant.pause?.until ?? null;
  clearTimeout(pauseTimer);
  if (until !== null && until > Date.now()) pauseTimer = setTimeout(() => { clockTick.value = Date.now(); }, Math.min(until - Date.now() + 50, 2 ** 31 - 1));
});

export const perms = computed(() => new Set(bootstrap.value?.me.permissions ?? []));
export const can = (permission: string): boolean => perms.value.has(permission);
/** Пауза и режим — одно право (таблица раздела 10). */
export const canPause = computed(() => perms.value.has('setting:aiMode'));
export const pause = computed(() => {
  const value = bootstrap.value?.assistant.pause ?? null;
  return pauseActive(value, clockTick.value) ? value : null;
});
export const aiMode = computed(() => settings.value?.aiMode ?? bootstrap.value?.assistant.mode ?? 'suggest');
/** Без связи всё только для чтения (6.7, состояния). */
export const offline = computed(() => mode.value === 'live' && connection.value !== 'live' && connection.value !== 'connecting');

function pick(runtime: Record<string, unknown>): AssistantSettings {
  return Object.fromEntries(KEYS.map((key) => [key, runtime[key]])) as AssistantSettings;
}

export async function loadSettings(): Promise<void> {
  if (!can('settings:read')) return;
  settingsState.value = settings.peek() ? 'ready' : 'loading';
  try {
    const body = await getJson<AssistantSettingsResponse>('/api/assistant/settings', token());
    settings.value = pick(body.runtime);
    aiInfo.value = { keys: body.ai.keys, kb: body.kb };
    settingsState.value = 'ready';
  } catch {
    settingsState.value = settings.peek() ? 'ready' : 'error';
  }
}

export type SaveResult = { ok: true } | { ok: false; error: string };

/**
 * Сохранить пакет ключей одним POST: сервер применяет его целиком или никак.
 * remember — запомнить «было» для «Вернуть как было» (всё, что меняет ответы клиентам).
 */
export async function saveSettings(values: Partial<AssistantSettings>, remember = true): Promise<SaveResult> {
  if (!settings.peek()) await loadSettings();
  const before = settings.peek();
  if (!before) return { ok: false, error: t('assistant.notLoaded') };
  try {
    const body = await sendJson<{ runtime: Record<string, unknown> }>('/api/settings', token(), values);
    settings.value = body.runtime ? pick(body.runtime) : { ...before, ...values };
    const keys = Object.keys(values) as SettingKey[];
    if (remember && keys.some((key) => !IMMEDIATE.has(key))) {
      const memo: RevertMemo = {
        at: Date.now(),
        before: Object.fromEntries(keys.map((key) => [key, before[key]])),
        after: Object.fromEntries(keys.map((key) => [key, (settings.peek() ?? before)[key]])),
      };
      saveRevert(memo);
      revertMemo.value = memo;
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t('error.network') };
  }
}

/** Ключи, которые с тех пор поменял кто-то ещё: панель спросит «Вернуть всё равно?». */
export async function revertConflicts(): Promise<SettingKey[]> {
  const memo = revertMemo.peek();
  if (!memo) return [];
  await loadSettings();
  const current = settings.peek();
  return current ? changedSince(memo, current) : [];
}

export async function revertLast(): Promise<SaveResult> {
  const memo = revertMemo.peek();
  if (!memo) return { ok: true };
  const result = await saveSettings(memo.before, false);
  if (result.ok) {
    dropRevert();
    revertMemo.value = null;
    showToast({ text: t('assistant.reverted') });
  }
  return result;
}

export function forgetRevert(): void {
  dropRevert();
  revertMemo.value = null;
}

// --- Пауза -------------------------------------------------------------------

function applyPause(value: AssistantPauseResponse['pause']): void {
  const current = bootstrap.peek();
  if (current) bootstrap.value = { ...current, assistant: { ...current.assistant, pause: value } };
}

export async function pauseFor(preset: PausePreset): Promise<boolean> {
  const previous = bootstrap.peek()?.assistant.pause ?? null;
  try {
    const body = await sendJson<AssistantPauseResponse>('/api/assistant/pause', token(), { until: pauseUntil(preset, Date.now()) });
    applyPause(body.pause);
    // Отмена — снять паузу или вернуть прежнюю (ярус 0, 7.6).
    undoToast(t('pause.set'), () => {
      void (previous && pauseActive(previous, Date.now())
        ? sendJson<AssistantPauseResponse>('/api/assistant/pause', token(), { until: previous.until }).then((res) => applyPause(res.pause))
        : resumeAssistant(true));
    }, t('toast.undo'));
    return true;
  } catch (err) {
    showToast({ kind: 'error', text: err instanceof ApiError && err.code === 'permission' ? t('pause.noRight') : t('pause.failed'), ttl: null });
    return false;
  }
}

export async function resumeAssistant(quiet = false): Promise<boolean> {
  try {
    await sendJson<AssistantPauseResponse>('/api/assistant/pause', token(), {}, { method: 'DELETE' });
    applyPause(null);
    if (!quiet) showToast({ text: t('pause.resumed') });
    return true;
  } catch (err) {
    showToast({ kind: 'error', text: err instanceof ApiError && err.code === 'permission' ? t('pause.noRight') : t('pause.failed'), ttl: null });
    return false;
  }
}

// --- Лента, «Это неверно», проверка -------------------------------------------

export async function loadActivity(since: number, options: { before?: number; limit?: number } = {}): Promise<ActivityResponse> {
  const query = new URLSearchParams({ since: String(since), limit: String(options.limit ?? 50) });
  if (options.before !== undefined) query.set('before', String(options.before));
  return await getJson<ActivityResponse>(`/api/assistant/activity?${query}`, token());
}

/** Сообщения, уже отмеченные «Это неверно» в этой вкладке (чтобы кнопка сразу сменилась). */
export const markedWrong = signal<ReadonlySet<number>>(new Set());

/**
 * «Это неверно»; correct — «как правильно» (этап 5): сервер делает из него идею
 * статьи в «Идеях из диалогов» — вопрос клиента и правильный ответ, без неверного.
 */
export async function sendFeedback(messageId: number, reason: FeedbackReason | null, note: string, correct = ''): Promise<boolean> {
  try {
    const body = await sendJson<FeedbackResponse>(`/api/messages/${messageId}/feedback`, token(), {
      verdict: 'wrong', reason, ...(note.trim() ? { note: note.trim() } : {}), ...(correct.trim() ? { correct: correct.trim() } : {}),
    });
    markedWrong.value = new Set([...markedWrong.peek(), messageId]);
    if (typeof body.idea_id === 'number') {
      const boot = bootstrap.peek();
      if (boot && boot.counts.ideas !== null) bootstrap.value = { ...boot, counts: { ...boot.counts, ideas: boot.counts.ideas + 1 } };
    }
    showToast({ text: typeof body.idea_id === 'number' ? t('wrong.doneIdea') : t('wrong.done') });
    return true;
  } catch {
    showToast({ kind: 'error', text: t('wrong.failed'), ttl: null });
    return false;
  }
}

export interface TryResult {
  draft: { reply: string; confidence: number; needsHuman: boolean; noRequest?: boolean; operatorNote?: string; explanation?: string };
  ms: number;
  model: string;
  sources: string[];
  usedSources: string[];
  verdict: { action: string; reason: string };
}

/** «Попробовать» и «Как бы он ответил»: вердикт режима «Отвечает сам» (assume: auto). */
export async function tryQuestion(text: string): Promise<TryResult> {
  return await sendJson<TryResult>('/api/ai/try', token(), { text, assume: 'auto' });
}

export async function pingModel(): Promise<{ ok: true; ms: number; model: string } | { ok: false; error: string }> {
  try {
    const body = await sendJson<{ ms: number; model: string }>('/api/ai/ping', token(), {});
    return { ok: true, ms: body.ms, model: body.model };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : t('error.network') };
  }
}

/** Последние вопросы клиентов из списка — для «Как бы он ответил на 5 последних диалогах». */
export const recentQuestions = computed(() => liveItems.value
  .filter((item) => item.last?.author === 'client' && item.last.kind === 'text' && item.last.text.trim().length > 2)
  .sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0))
  .slice(0, 5)
  .map((item) => ({ id: item.id, name: liveName(item), text: item.last!.text })));

// Кадр settings от другого человека: перечитать настройки и сказать, кто менял.
listenSettings((frame) => {
  const me = bootstrap.peek()?.me.id;
  if (frame.actor && frame.actor.id !== me) changedBy.value = { name: frame.actor.name, at: Date.now() };
  if (settings.peek() && frame.keys?.some((key) => key !== 'aiPause')) void loadSettings();
});
