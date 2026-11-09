import type { Store } from './store.js';

/**
 * Пауза помощника везде (план редизайна, 10.4 п.1, ответ на вопрос 14.6а):
 * клиентам помощник сам не отвечает и «ожидайте» не шлёт, черновики для
 * людей пишет. Хранится отдельно от режима — настроенный режим не меняется,
 * и после паузы всё работает как было.
 *
 * Хранится в таблице setting под своим ключом, без миграции: старый образ
 * этот ключ просто не читает, поэтому откат образа паузу снимает.
 */
export interface AssistantPause {
  /** Конец паузы; null — «пока не включу». */
  until: number | null;
  /** Когда поставлена. */
  at: number;
  /** Кто поставил: ключ оператора (`op:N`, `root`) и имя для подписи. */
  by: string | null;
  byName: string | null;
}

export const PAUSE_KEY = 'aiPause';
/** Дальше месяца пауза — это уже «пока не включу». */
export const PAUSE_MAX_MS = 31 * 24 * 60 * 60_000;

let current: AssistantPause | null = null;

function parse(raw: unknown): AssistantPause | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const until = value['until'] === null ? null : Number(value['until']);
  const at = Number(value['at']);
  if (until !== null && !Number.isSafeInteger(until)) return null;
  if (!Number.isSafeInteger(at)) return null;
  return {
    until,
    at,
    by: typeof value['by'] === 'string' ? value['by'] : null,
    byName: typeof value['byName'] === 'string' ? value['byName'] : null,
  };
}

/** Прочитать паузу из базы (при старте, рядом с loadSettings). */
export function loadPause(store: Store): void {
  current = parse(store.getSetting(PAUSE_KEY));
}

/** Действующая пауза или null: истёкшая пауза считается снятой. */
export function pauseState(now = Date.now()): AssistantPause | null {
  if (!current) return null;
  if (current.until !== null && current.until <= now) return null;
  return current;
}

export const isPaused = (now = Date.now()): boolean => pauseState(now) !== null;

/** Поставить паузу. until — конец (мс) или null «пока не включу». */
export function setPause(store: Store, until: number | null, actor: { key: string; name: string }, now = Date.now()): AssistantPause {
  const next: AssistantPause = { until, at: now, by: actor.key, byName: actor.name };
  store.setSetting(PAUSE_KEY, next);
  current = next;
  return next;
}

/** Снять паузу. Возвращает, была ли действующая пауза. */
export function clearPause(store: Store, now = Date.now()): boolean {
  const was = pauseState(now) !== null;
  store.db.prepare('DELETE FROM setting WHERE key = ?').run(PAUSE_KEY);
  current = null;
  return was;
}

/** Проверка тела запроса: until в будущем и не дальше месяца, либо null. */
export function validPauseUntil(value: unknown, now = Date.now()): number | null | undefined {
  if (value === null) return null;
  const until = Number(value);
  if (!Number.isSafeInteger(until) || until <= now || until > now + PAUSE_MAX_MS) return undefined;
  return until;
}
