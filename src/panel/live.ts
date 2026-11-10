import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { factsQuery, LISTED_SQL, type FactsRow } from '../core/attention.js';
import type { AiMode } from '../shared/attention.js';
import type { Permission } from '../core/operations.js';
import type { AssistantPauseView, InboxCounts, InboxProjection, InvalidateScope, LiveFrame, SystemProblem } from '../shared/api-types.js';
import { materialize, openProjections, projectRows } from './inbox.js';

/**
 * Живые данные новой панели (план редизайна, 7.2 и 10.2 п.1–2).
 *
 * EventLog — номер кадра seq и эпоха процесса, буфер последних кадров для
 * догона через GET /api/events. AttentionWatcher — пересчёт проекции строк
 * по событиям Store и по шагу 15 с: переходы по времени («Помощник не
 * ответил», сроки, конец паузы и закрепления) видны не позже чем через шаг.
 *
 * В буфере лежат кадры без полей получателя: секцию и ранг досчитывает
 * frameFor() для каждого сокета и каждого запроса догона отдельно.
 */

export type StoredFrame =
  | { type: 'inbox_item'; item: InboxProjection }
  | { type: 'inbox_remove'; id: number }
  | { type: 'settings'; aiMode: AiMode; minConfidence: number; keys?: string[];
      actor?: { id: string; name: string } | null; pause?: AssistantPauseView | null }
  /** Раздел изменился (L-4): только scope, данные панель берёт своим GET с проверкой прав. */
  | { type: 'invalidate'; scope: InvalidateScope }
  /** Неполадки изменились (L-3): тот же список, что GET /api/system/problems. */
  | { type: 'problems'; problems: SystemProblem[]; at: number };

interface Entry { seq: number; at: number; frame: StoredFrame }

export const EVENT_BUFFER_MAX = 5000;
export const EVENT_BUFFER_MS = 60 * 60_000;

export class EventLog {
  /** Меняется при каждом запуске процесса: панель понимает, что буфер начат заново. */
  readonly epoch: string;
  private current = 0;
  /** seq последнего выброшенного из буфера кадра: догон от более раннего — только перечитыванием. */
  private floor = 0;
  private readonly entries: Entry[] = [];

  constructor(private readonly max = EVENT_BUFFER_MAX, private readonly maxAgeMs = EVENT_BUFFER_MS, epoch?: string) {
    this.epoch = epoch ?? randomBytes(6).toString('base64url');
  }

  get seq(): number { return this.current; }

  push(frame: StoredFrame, now = Date.now()): number {
    this.current += 1;
    this.entries.push({ seq: this.current, at: now, frame });
    this.prune(now);
    return this.current;
  }

  private prune(now: number): void {
    let drop = 0;
    while (drop < this.entries.length
      && (this.entries.length - drop > this.max || now - (this.entries[drop]?.at ?? now) > this.maxAgeMs)) drop += 1;
    if (drop === 0) return;
    this.floor = this.entries[drop - 1]?.seq ?? this.floor;
    this.entries.splice(0, drop);
  }

  /** Кадры после `since`. null — догнать нельзя (другая эпоха, пропуск старше буфера или seq из будущего). */
  since(since: number, epoch: string, now = Date.now()): Entry[] | null {
    this.prune(now);
    if (epoch !== this.epoch || !Number.isSafeInteger(since) || since < this.floor || since > this.current) return null;
    return this.entries.filter((entry) => entry.seq > since);
  }
}

/** Получатель кадра: ключ (секция и ранг строки) и его права (что ему положено). */
export interface Viewer {
  key: string;
  can(permission: Permission): boolean;
}

/**
 * Право, с которым панель читает раздел: тот же GET, что панель вызовет по кадру
 * invalidate (src/panel/permissions.ts). Без права кадр приходит пустым (noop).
 */
export const SCOPE_PERMISSION: Record<InvalidateScope, Permission> = {
  kb: 'knowledge:read',
  templates: 'templates:read',
  ideas: 'knowledge:review',
  team: 'team:read',
  roles: 'roles:manage',
  nodes: 'settings:read',
  connections: 'settings:read',
};

/** Настройки, которые видит любой оператор (bootstrap.assistant): их имена уходят в кадр всем. */
const PUBLIC_SETTINGS = new Set(['aiMode', 'minConfidence', 'aiPause']);

/**
 * Кадр для конкретного получателя; counts — его счётчики на момент отправки.
 * Кадр, который получателю не положен по правам, становится noop: seq идёт без пропуска.
 */
export function frameFor(entry: { seq: number; frame: StoredFrame }, epoch: string, viewer: Viewer, counts?: InboxCounts): LiveFrame {
  const { frame, seq } = entry;
  switch (frame.type) {
    case 'inbox_item': return { type: 'inbox_item', seq, epoch, item: materialize(frame.item, viewer.key), ...(counts ? { counts } : {}) };
    case 'inbox_remove': return { type: 'inbox_remove', seq, epoch, id: frame.id, ...(counts ? { counts } : {}) };
    case 'settings': {
      // Имена прочих настроек — только тем, кто читает GET /api/settings.
      const keys = frame.keys && !viewer.can('settings:read') ? frame.keys.filter((key) => PUBLIC_SETTINGS.has(key)) : frame.keys;
      if (frame.keys && keys?.length === 0) return { type: 'noop', seq, epoch };
      return {
        type: 'settings', seq, epoch, aiMode: frame.aiMode, minConfidence: frame.minConfidence,
        ...(keys ? { keys } : {}),
        ...(frame.actor !== undefined ? { actor: frame.actor } : {}),
        ...(frame.pause !== undefined ? { pause: frame.pause } : {}),
      };
    }
    case 'invalidate':
      return viewer.can(SCOPE_PERMISSION[frame.scope]) ? { type: 'invalidate', seq, epoch, scope: frame.scope } : { type: 'noop', seq, epoch };
    case 'problems':
      return viewer.can('diagnostics:read') ? { type: 'problems', seq, epoch, problems: frame.problems, at: frame.at } : { type: 'noop', seq, epoch };
  }
}

export const ATTENTION_STEP_MS = 15_000;
const DONE_MEMORY = 2000;

/**
 * Держит последнюю отправленную проекцию каждого открытого диалога и шлёт
 * кадр только по изменившимся. Пропущенный повод для пересчёта исправляется
 * на следующем шаге.
 */
export class AttentionWatcher {
  private readonly sent = new Map<number, { json: string; item: InboxProjection }>();
  /** Последние отправленные решённые строки: повторный повод без изменений кадра не даёт. */
  private readonly doneSent = new Map<number, string>();
  private readonly dirty = new Set<number>();
  private dirtyAll = false;
  private scheduled = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly emit: (frame: StoredFrame) => void,
    private readonly clock: () => number = Date.now,
  ) {
    // Стартовая проекция без кадров: панель всё равно начинает со снимка /api/inbox.
    for (const item of openProjections(db, clock())) this.sent.set(item.id, { json: JSON.stringify(item), item });
  }

  start(stepMs = ATTENTION_STEP_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.step(), stepMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Повод пересчитать: событие Store, закрепление, смена режима. Без аргумента — все открытые. */
  touch(ids?: readonly number[]): void {
    if (ids) for (const id of ids) this.dirty.add(id);
    else this.dirtyAll = true;
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => this.flush());
  }

  /** Применить накопленные поводы сейчас (тесты и шаг). */
  flush(): void {
    this.scheduled = false;
    if (this.dirtyAll) {
      this.dirtyAll = false;
      this.dirty.clear();
      this.recompute();
    } else if (this.dirty.size) {
      const ids = [...this.dirty];
      this.dirty.clear();
      this.recompute(ids);
    }
  }

  /** Шаг по времени: пересчёт всех открытых. */
  step(): void {
    this.dirty.clear();
    this.dirtyAll = false;
    this.recompute();
  }

  /** Последняя отправленная проекция (сверка в тестах). */
  sentProjection(id: number): InboxProjection | undefined {
    return this.sent.get(id)?.item;
  }

  /** Все открытые строки, как их видят панели: по ним сервер считает счётчики в кадрах. */
  projections(): InboxProjection[] {
    return [...this.sent.values()].map((entry) => entry.item);
  }

  get size(): number { return this.sent.size; }

  private recompute(ids?: readonly number[]): void {
    const now = this.clock();
    const fresh = openProjections(this.db, now, ids);
    const seen = new Set<number>();
    for (const item of fresh) {
      seen.add(item.id);
      this.doneSent.delete(item.id);
      const json = JSON.stringify(item);
      if (this.sent.get(item.id)?.json === json) continue;
      this.sent.set(item.id, { json, item });
      this.emit({ type: 'inbox_item', item });
    }
    const gone = (ids ?? [...this.sent.keys()]).filter((id) => !seen.has(id));
    if (gone.length === 0) return;
    // Ушёл из открытых: решён — последняя проекция в «Решённые»; скрыт или удалён — снять строку.
    const done = new Map(projectRows(this.db, this.db.prepare(factsQuery(
      `${LISTED_SQL} AND c.id IN (${gone.map((id) => Number(id)).join(',')})`)).all() as FactsRow[], now)
      .map((item) => [item.id, item]));
    for (const id of gone) {
      const item = done.get(id);
      const known = this.sent.delete(id);
      if (item) {
        const json = JSON.stringify(item);
        if (this.doneSent.get(id) === json) continue;
        this.doneSent.delete(id);
        this.doneSent.set(id, json);
        if (this.doneSent.size > DONE_MEMORY) this.doneSent.delete(this.doneSent.keys().next().value as number);
        this.emit({ type: 'inbox_item', item });
      } else if (known || this.doneSent.delete(id)) {
        this.emit({ type: 'inbox_remove', id });
      }
    }
  }
}

/** Живые данные панели: журнал кадров, пересчёт строк и поводы для него. */
export interface LiveHub {
  readonly events: EventLog;
  readonly watcher: AttentionWatcher;
  /** Пересчитать строки этих диалогов (или всех открытых). */
  touch(ids?: readonly number[]): void;
  /** Изменились настройки: режим помощника меняет состояние сразу всех строк. */
  settingsChanged(keys: readonly string[], values: SettingsValues): void;
  /** Разделы изменились (L-4): по кадру на scope, повторы в одном шаге цикла склеиваются. */
  invalidate(scopes: readonly InvalidateScope[]): void;
  /** Свежий список неполадок: кадр, только если он отличается от последнего отправленного. */
  problems(list: SystemProblem[], at?: number): void;
}

/** Что уходит в кадр settings: режим, порог и (10.4 п.7) кто менял и пауза. */
export interface SettingsValues {
  aiMode: AiMode;
  minConfidence: number;
  actor?: { id: string; name: string } | null;
  pause?: AssistantPauseView | null;
}

/** Настройки, от которых зависит состояние строк (src/shared/attention.ts, src/core/attention.ts). */
const ATTENTION_SETTINGS = new Set(['aiMode', 'minConfidence', 'humanHoldMinutes', 'aiPause']);
/**
 * Кадры уходят пачкой на следующем шаге цикла (L-13): пересчёт после смены
 * режима даёт десятки кадров, а счётчики получателя считаются один раз на
 * пачку и едут в последнем кадре строки.
 */
export function createLiveHub(db: Database.Database, send: (batch: Array<{ seq: number; frame: StoredFrame }>, epoch: string) => void): LiveHub {
  const events = new EventLog();
  let batch: Array<{ seq: number; frame: StoredFrame }> = [];
  const publish = (frame: StoredFrame): void => {
    const seq = events.push(frame);
    batch.push({ seq, frame });
    if (batch.length > 1) return;
    setImmediate(() => {
      const ready = batch;
      batch = [];
      send(ready, events.epoch);
    });
  };
  const watcher = new AttentionWatcher(db, publish);
  const scopes = new Set<InvalidateScope>();
  let lastProblems: string | null = null;
  return {
    events,
    watcher,
    touch: (ids) => watcher.touch(ids),
    invalidate(list) {
      const first = scopes.size === 0;
      for (const scope of list) scopes.add(scope);
      if (!first || scopes.size === 0) return;
      setImmediate(() => {
        for (const scope of scopes) publish({ type: 'invalidate', scope });
        scopes.clear();
      });
    },
    problems(list, at = Date.now()) {
      const json = JSON.stringify(list);
      // Первый замер — точка отсчёта: панели начинают со списка из bootstrap.
      if (lastProblems === null) { lastProblems = json; return; }
      if (json === lastProblems) return;
      lastProblems = json;
      publish({ type: 'problems', problems: list, at });
    },
    settingsChanged(keys, values) {
      // L-6: кадр на любую запись — экран «Помощник» в других вкладках перечитывает свои ключи.
      if (keys.length > 0) {
        publish({
          type: 'settings', aiMode: values.aiMode, minConfidence: values.minConfidence, keys: [...keys],
          ...(values.actor !== undefined ? { actor: values.actor } : {}),
          ...(values.pause !== undefined ? { pause: values.pause } : {}),
        });
      }
      if (keys.some((key) => ATTENTION_SETTINGS.has(key))) watcher.touch();
    },
  };
}
