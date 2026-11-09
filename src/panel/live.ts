import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { factsQuery, LISTED_SQL, type FactsRow } from '../core/attention.js';
import type { AiMode } from '../shared/attention.js';
import type { InboxProjection, LiveFrame } from '../shared/api-types.js';
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
  | { type: 'settings'; aiMode: AiMode; minConfidence: number };

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

/** Кадр для конкретного получателя. */
export function frameFor(entry: { seq: number; frame: StoredFrame }, epoch: string, viewerKey: string): LiveFrame {
  const { frame, seq } = entry;
  switch (frame.type) {
    case 'inbox_item': return { type: 'inbox_item', seq, epoch, item: materialize(frame.item, viewerKey) };
    case 'inbox_remove': return { type: 'inbox_remove', seq, epoch, id: frame.id };
    case 'settings': return { type: 'settings', seq, epoch, aiMode: frame.aiMode, minConfidence: frame.minConfidence };
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
  private readonly sent = new Map<number, string>();
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
    for (const item of openProjections(db, clock())) this.sent.set(item.id, JSON.stringify(item));
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
    const raw = this.sent.get(id);
    return raw ? JSON.parse(raw) as InboxProjection : undefined;
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
      if (this.sent.get(item.id) === json) continue;
      this.sent.set(item.id, json);
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
  settingsChanged(keys: readonly string[], values: { aiMode: AiMode; minConfidence: number }): void;
}

/** Настройки, от которых зависит состояние строк (src/shared/attention.ts, src/core/attention.ts). */
const ATTENTION_SETTINGS = new Set(['aiMode', 'minConfidence', 'humanHoldMinutes']);

export function createLiveHub(db: Database.Database, send: (entry: { seq: number; frame: StoredFrame }, epoch: string) => void): LiveHub {
  const events = new EventLog();
  const publish = (frame: StoredFrame): void => {
    const seq = events.push(frame);
    send({ seq, frame }, events.epoch);
  };
  const watcher = new AttentionWatcher(db, publish);
  return {
    events,
    watcher,
    touch: (ids) => watcher.touch(ids),
    settingsChanged(keys, values) {
      if (keys.includes('aiMode') || keys.includes('minConfidence')) {
        publish({ type: 'settings', aiMode: values.aiMode, minConfidence: values.minConfidence });
      }
      if (keys.some((key) => ATTENTION_SETTINGS.has(key))) watcher.touch();
    },
  };
}
