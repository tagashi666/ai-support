/**
 * LiveClient — живое соединение новой панели (план, 7.2 и 11.3). Обычный
 * класс без Preact: его проверяют тесты с поддельным WebSocket и таймерами.
 *
 * Механика соединения перенесена из классики (public/js/live.js):
 * билет обновляется без окна без событий (сначала новый сокет, потом закрытие
 * старого), переподключение с растущими паузами, «мёртвый» сокет — нет кадров
 * дольше 50 с, возврат во вкладку и в сеть. Новое: номер кадра seq, эпоха,
 * обнаружение пропуска и догон одним запросом GET /api/events?since=.
 *
 * Состояния связи (6.14): live — в норме, строки состояния нет;
 * restoring — «Восстанавливаем связь…»; offline — «Нет связи · данные на …»;
 * syncing — «Связь есть, обновляем…».
 */
import type { ControlFrame, EventsResponse, InboxCounts, LiveFrame, ThreadFrame } from '@shared/api-types';

export type ConnectionState = 'connecting' | 'live' | 'restoring' | 'offline' | 'syncing';

export interface Position {
  seq: number;
  epoch: string;
}

interface SocketLike {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(code?: number, reason?: string): void;
}

export interface LiveClientDeps {
  /** Адрес сокета по билету. */
  socketUrl(ticket: string): string;
  /** Новый билет (GET /api/ticket). */
  ticket(): Promise<string>;
  /** Догон (GET /api/events?since=&epoch=). */
  events(since: number, epoch: string): Promise<EventsResponse>;
  /** Перечитать видимую страницу (/api/inbox) и вернуть её позицию. */
  reload(): Promise<Position>;
  /** Кадры по порядку seq; counts — свежие счётчики получателя, если пришли. */
  onFrames(frames: LiveFrame[], counts?: InboxCounts): void;
  onState(state: ConnectionState): void;
  /** Кадр ленты открытого диалога (без seq). */
  onThread?(frame: ThreadFrame): void;
  /** Сервер закрыл сокет из-за прав (1008): панель перечитывает bootstrap. */
  onPermission?(): void;
  createSocket?(url: string): SocketLike;
  now?(): number;
}

export const DEAD_SOCKET_MS = 50_000;
export const DEAD_CHECK_MS = 10_000;
export const OFFLINE_AFTER_MS = 15_000;
export const POLL_MS = 20_000;
export const TICKET_ROTATE_MS = 8 * 60_000;
export const TICKET_STALE_MS = 6 * 60_000;
const OPEN = 1;

export class LiveClient {
  private seq = 0;
  private epoch = '';
  private ticketValue = '';
  private ticketAt = 0;
  private live: SocketLike | null = null;
  private pending: SocketLike | null = null;
  private failures = 0;
  private frameAt = 0;
  private outageAt: number | null = null;
  private state: ConnectionState = 'connecting';
  private syncing = false;
  private syncAgain = false;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private offlineTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private deadTimer: ReturnType<typeof setInterval> | null = null;
  private rotateTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: LiveClientDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  get position(): Position { return { seq: this.seq, epoch: this.epoch }; }
  get connection(): ConnectionState { return this.state; }

  /** Запуск с позиции снимка: кадры с seq больше неё применяются поверх снимка. */
  start(position: Position): void {
    this.seq = position.seq;
    this.epoch = position.epoch;
    this.stopped = false;
    this.deadTimer = setInterval(() => this.checkDead(), DEAD_CHECK_MS);
    this.rotateTimer = setInterval(() => { void this.rotateTicket(); }, TICKET_ROTATE_MS);
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    for (const timer of [this.retryTimer, this.offlineTimer]) if (timer) clearTimeout(timer);
    for (const timer of [this.pollTimer, this.deadTimer, this.rotateTimer]) if (timer) clearInterval(timer);
    this.retryTimer = this.offlineTimer = this.pollTimer = this.deadTimer = this.rotateTimer = null;
    for (const socket of [this.live, this.pending]) {
      if (!socket) continue;
      socket.onclose = null; socket.onmessage = null;
      try { socket.close(1000, 'Stopped'); } catch { /* уже закрыт */ }
    }
    this.live = this.pending = null;
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.deps.onState(next);
  }

  private async ensureTicket(force = false): Promise<string> {
    if (force || !this.ticketValue || this.now() - this.ticketAt > TICKET_STALE_MS) {
      this.ticketValue = await this.deps.ticket();
      this.ticketAt = this.now();
    }
    return this.ticketValue;
  }

  private async connect(forceTicket = false): Promise<void> {
    if (this.stopped || this.pending) return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    let ticket: string;
    try {
      ticket = await this.ensureTicket(forceTicket);
    } catch {
      this.lost(1006);
      return;
    }
    if (this.stopped || this.pending) return;
    const url = this.deps.socketUrl(ticket);
    const socket = this.deps.createSocket ? this.deps.createSocket(url) : new WebSocket(url) as unknown as SocketLike;
    this.pending = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      if (this.pending === socket) this.pending = null;
      const previous = this.live;
      this.live = socket;
      this.failures = 0;
      this.frameAt = this.now();
      if (previous && previous !== socket) { previous.onclose = null; previous.onmessage = null; previous.close(1000, 'Ticket rotated'); }
      // После обрыва — «Связь есть, обновляем…» до ответа догона (его запустит hello).
      if (this.outageAt !== null) this.setState('syncing');
      else if (this.state === 'connecting') this.setState('live');
      this.clearOutageTimers();
    };
    socket.onclose = (event) => {
      if (this.pending === socket) this.pending = null;
      // Не открывшаяся замена при живом старом сокете: попробовать позже.
      if (this.live && this.live !== socket) {
        if (!opened) this.retryTimer = setTimeout(() => { void this.connect(); }, 5000);
        return;
      }
      this.live = null;
      if (event.code === 1008 && /permission/i.test(event.reason ?? '')) this.deps.onPermission?.();
      this.lost(event.code);
    };
    socket.onmessage = (event) => {
      if (this.live !== socket) return;
      this.frameAt = this.now();
      let frame: LiveFrame | ControlFrame | ThreadFrame;
      try { frame = JSON.parse(String(event.data)) as LiveFrame | ControlFrame | ThreadFrame; } catch { return; }
      if (frame.type === 'thread') { this.deps.onThread?.(frame); return; }
      this.handle(frame);
    };
  }

  /** Сокета нет: строка состояния, переподключение, а дольше 15 с — «Нет связи» и опрос раз в 20 с. */
  private lost(code: number): void {
    if (this.stopped) return;
    if (this.outageAt === null) {
      this.outageAt = this.now();
      this.setState('restoring');
      this.offlineTimer = setTimeout(() => {
        if (this.live) return;
        this.setState('offline');
        this.pollTimer = setInterval(() => { void this.catchUp(); }, POLL_MS);
      }, OFFLINE_AFTER_MS);
    }
    const delay = this.failures ? Math.min(15_000, 1000 * 2 ** (this.failures - 1)) : 200;
    this.failures += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    // 1008 — билет истёк или сервер перезапущен с новым секретом.
    this.retryTimer = setTimeout(() => { void this.connect(code === 1008 || this.failures > 1); }, delay);
  }

  private clearOutageTimers(): void {
    if (this.offlineTimer) clearTimeout(this.offlineTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.offlineTimer = this.pollTimer = null;
  }

  private handle(frame: LiveFrame | ControlFrame): void {
    if (frame.type === 'hello' || frame.type === 'tick') {
      // Служебный кадр несёт текущий номер: отстали или сервер перезапущен — догнать.
      if (frame.epoch !== this.epoch || frame.seq > this.seq) void this.catchUp();
      else if (this.outageAt !== null || this.state === 'syncing') this.recovered();
      return;
    }
    if (frame.epoch !== this.epoch) { void this.catchUp(); return; }
    if (frame.seq <= this.seq) return;
    if (frame.seq !== this.seq + 1 || this.syncing) { void this.catchUp(); return; }
    this.seq = frame.seq;
    this.deps.onFrames([frame], 'counts' in frame ? frame.counts : undefined);
  }

  private recovered(): void {
    this.outageAt = null;
    this.clearOutageTimers();
    this.setState(this.live && this.live.readyState === OPEN ? 'live' : this.state);
  }

  /** Один запрос догона; повторный повод во время запроса — ещё один проход после него. */
  async catchUp(): Promise<void> {
    if (this.stopped) return;
    if (this.syncing) { this.syncAgain = true; return; }
    this.syncing = true;
    try {
      const response = await this.deps.events(this.seq, this.epoch);
      if (response.reset) {
        const position = await this.deps.reload();
        this.seq = position.seq;
        this.epoch = position.epoch;
      } else {
        const fresh = response.events.filter((frame) => frame.seq > this.seq).sort((a, b) => a.seq - b.seq);
        this.seq = Math.max(this.seq, response.seq);
        this.epoch = response.epoch;
        this.deps.onFrames(fresh, response.counts);
      }
      if (this.live) this.recovered();
    } catch {
      // Сеть ещё не вернулась: следующий повод (сокет, опрос, возврат во вкладку) повторит догон.
    } finally {
      this.syncing = false;
    }
    if (this.syncAgain) {
      this.syncAgain = false;
      await this.catchUp();
    }
  }

  private checkDead(): void {
    if (this.live && this.now() - this.frameAt > DEAD_SOCKET_MS) this.dropDead();
  }

  private dropDead(): void {
    const dead = this.live;
    if (!dead) return;
    dead.onclose = null; dead.onmessage = null;
    try { dead.close(); } catch { /* уже закрыт */ }
    this.live = null;
    this.lost(1006);
  }

  /** Возврат во вкладку или в сеть: проверить сокет и билет, догнать пропущенное. */
  async resume(): Promise<void> {
    if (this.stopped) return;
    if (this.now() - this.ticketAt > TICKET_STALE_MS) await this.ensureTicket(true).catch(() => undefined);
    if (this.live && this.now() - this.frameAt > 30_000) this.dropDead();
    else if (!this.live && !this.pending) await this.connect();
    await this.catchUp();
  }

  /** Плановое обновление билета: сначала новый сокет, затем закрытие старого. */
  private async rotateTicket(): Promise<void> {
    try {
      await this.ensureTicket(true);
    } catch {
      return;
    }
    if (this.live && this.live.readyState === OPEN) await this.connect();
  }
}
