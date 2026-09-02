import { config, log } from '../config.js';
import type { ChannelSender, SendPayload, SendResult } from '../core/outbox.js';
import type { Conversation, Store } from '../core/store.js';
import { readLimitedBody } from '../core/http.js';

/**
 * Клиент webapi бедолаги. Авторизация — заголовок X-API-Key.
 *
 * Ретраи здесь не одинаковые. Чтение можно повторять сколько угодно, а
 * POST /reply — нельзя: сообщение коммитится до ответа эндпоинта, поэтому
 * повтор после обрыва отправит клиенту второй экземпляр ответа.
 */

const PAGE_LIMIT = 200;
const MAX_PAGES = 50;
/** Все состояния, в которых тикет ещё не закрыт. */
const ACTIVE_STATUSES = ['open', 'answered', 'pending'] as const;
const MEDIA_REPAIR_STATE = 'bedolaga:media_repair:rc6-outbound';
export type BedolagaTicketStatus = 'open' | 'answered' | 'closed' | 'pending';

export function localStatusForTicket(status: unknown): 'open' | 'pending' | 'resolved' | undefined {
  if (status === 'open') return 'open';
  if (status === 'answered' || status === 'pending') return 'pending';
  if (status === 'closed') return 'resolved';
  return undefined;
}

export interface BedolagaTicket {
  id: number;
  title?: string;
  status?: string;
  priority?: string;
  user_id?: number;
  messages?: BedolagaMessage[];
  user_reply_block_permanent?: boolean;
  user_reply_block_until?: string | null;
}

export interface BedolagaMessage {
  id: number;
  message_text?: string;
  is_from_admin?: boolean;
  user_id?: number;
  has_media?: boolean;
  media_type?: string;
  media_file_id?: string | number;
  [key: string]: unknown;
}

function mediaFileId(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Локальный external_id включает источник, API Bedolaga ждёт только номер. */
export function ticketIdOf(conversation: Conversation): number {
  const ticketId = Number(conversation.remote_external_id ?? conversation.external_id);
  if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
    throw new Error('У диалога нет корректного ID тикета Bedolaga');
  }
  return ticketId;
}

/** Поля времени в разных ручках названы по-разному — берём первое похожее. */
export function parseTimestamp(source: Record<string, unknown>, fallback = Date.now()): number {
  for (const key of ['created_at', 'createdAt', 'date', 'timestamp', 'sent_at']) {
    const value = source[key];
    if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return fallback;
}

export class BedolagaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 30_000,
  ) {}

  private url(path: string, params?: Record<string, string | number>): string {
    const url = new URL(this.baseUrl.replace(/\/+$/, '') + path);
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));
    return url.toString();
  }

  private async request(path: string, init: RequestInit & { params?: Record<string, string | number> } = {}, retries = 2): Promise<Response> {
    const { params, ...rest } = init;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(this.url(path, params), {
          ...rest,
          headers: { 'X-API-Key': this.token, ...(rest.headers ?? {}) },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        // 5xx имеет смысл повторить, 4xx — нет.
        if (response.status >= 500 && attempt < retries) {
          lastError = new Error(`HTTP ${response.status}`);
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
          continue;
        }
        return response;
      } catch (err) {
        lastError = err;
        if (attempt === retries) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async json<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const response = await this.request(path, { params });
    if (!response.ok) throw new Error(`GET ${path} → HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  /** Все незакрытые тикеты. Листаем каждый живой статус до исчерпания. */
  async activeTickets(): Promise<BedolagaTicket[]> {
    const seen = new Map<number, BedolagaTicket>();
    for (const status of ACTIVE_STATUSES) {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const batch = await this.json<BedolagaTicket[]>('/tickets', {
          status,
          limit: PAGE_LIMIT,
          offset: page * PAGE_LIMIT,
        });
        if (!Array.isArray(batch)) break;
        for (const ticket of batch) seen.set(ticket.id, ticket);
        if (batch.length < PAGE_LIMIT) break;
        if (page === MAX_PAGES - 1) {
          log.warn(`Тикетов в статусе ${status} больше ${MAX_PAGES * PAGE_LIMIT} — хвост не обработан`);
        }
      }
    }
    return [...seen.values()];
  }

  /**
   * Тикеты в произвольном статусе — для разбора архива.
   * Поллер сюда не ходит: ему нужны только живые.
   */
  async ticketsByStatus(status: string, limit: number): Promise<BedolagaTicket[]> {
    const collected: BedolagaTicket[] = [];
    for (let page = 0; page < MAX_PAGES && collected.length < limit; page += 1) {
      const batch = await this.json<BedolagaTicket[]>('/tickets', {
        status,
        limit: Math.min(PAGE_LIMIT, limit - collected.length),
        offset: page * PAGE_LIMIT,
      });
      if (!Array.isArray(batch) || !batch.length) break;
      collected.push(...batch);
      if (batch.length < PAGE_LIMIT) break;
    }
    return collected.slice(0, limit);
  }

  ticket(id: number): Promise<BedolagaTicket> {
    return this.json<BedolagaTicket>(`/tickets/${id}`);
  }

  /** Ответить клиенту. Без ретраев намеренно — эндпоинт не идемпотентен. */
  async reply(ticketId: number, text: string): Promise<string | undefined> {
    const response = await this.request(
      `/tickets/${ticketId}/reply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message_text: text }),
      },
      0,
    );
    if (!response.ok) throw new Error(`POST /tickets/${ticketId}/reply → HTTP ${response.status}`);
    const body = (await response.json().catch(() => null)) as { message?: { id?: number } } | null;
    return body?.message?.id !== undefined ? String(body.message.id) : undefined;
  }

  async setPriority(ticketId: number, priority: string): Promise<void> {
    const response = await this.request(`/tickets/${ticketId}/priority`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ priority }),
    });
    if (!response.ok) throw new Error(`POST /tickets/${ticketId}/priority → HTTP ${response.status}`);
  }

  /** Меняет состояние исходного тикета, а не только локальной карточки. */
  async setStatus(ticketId: number, status: BedolagaTicketStatus): Promise<void> {
    const response = await this.request(`/tickets/${ticketId}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!response.ok) throw new Error(`POST /tickets/${ticketId}/status → HTTP ${response.status}`);
  }

  async messageMedia(ticketId: number, messageId: number): Promise<Record<string, unknown> | null> {
    const response = await this.request(`/tickets/${ticketId}/messages/${messageId}/media`);
    if (response.status === 404) return null;
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  }

  /** Вложения закрыты тем же токеном, поэтому URL модели отдать нельзя. */
  async downloadMedia(fileId: string): Promise<Buffer | null> {
    const response = await this.request(`/media/${encodeURIComponent(fileId)}`);
    if (!response.ok) return null;
    return readLimitedBody(response, config.mediaMaxFileBytes);
  }

  async userByTelegramId(telegramId: number): Promise<Record<string, unknown> | null> {
    const response = await this.request(`/users/by-telegram-id/${telegramId}`);
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  }

  /**
   * Поиск клиента по нику. Из лички telegram_id известен всегда, но если
   * бедолага его не знает (клиент писал только в личку), остаётся ник.
   */
  async searchUsers(query: string, limit = 5): Promise<Record<string, unknown>[]> {
    const response = await this.request('/users', { params: { search: query, limit } });
    if (!response.ok) return [];
    const body = (await response.json().catch(() => null)) as unknown;
    if (Array.isArray(body)) return body as Record<string, unknown>[];
    const record = body as Record<string, unknown> | null;
    for (const key of ['items', 'users', 'data']) {
      if (Array.isArray(record?.[key])) return record[key] as Record<string, unknown>[];
    }
    return [];
  }

  /** Транзакции клиента — из них видно первые платежи и активность. */
  async userTransactions(userId: number, limit = 20): Promise<Record<string, unknown>[]> {
    const response = await this.request(`/users/${userId}/transactions`, { params: { limit } });
    if (!response.ok) return [];
    const body = (await response.json().catch(() => null)) as unknown;
    if (Array.isArray(body)) return body as Record<string, unknown>[];
    const record = body as Record<string, unknown> | null;
    for (const key of ['items', 'transactions', 'data']) {
      if (Array.isArray(record?.[key])) return record[key] as Record<string, unknown>[];
    }
    return [];
  }

  async user(userId: number): Promise<Record<string, unknown> | null> {
    const response = await this.request(`/users/${userId}`);
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  }

  /** Встроенный FAQ бота — живой источник базы знаний. */
  async faqPages(language: string): Promise<{ items: Record<string, unknown>[] }> {
    return this.json<{ items: Record<string, unknown>[] }>('/pages/faq', {
      language,
      include_inactive: 'false',
      fallback: 'true',
    });
  }
}

export class BedolagaSender implements ChannelSender {
  constructor(private readonly client: BedolagaClient) {}

  async send(conversation: Conversation, payload: SendPayload): Promise<SendResult> {
    const externalMsgId = await this.client.reply(ticketIdOf(conversation), payload.text);
    return { externalMsgId };
  }
}

export class BedolagaPoller {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private mediaRepairFinished = false;

  constructor(
    private readonly client: BedolagaClient,
    private readonly store: Store,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Один проход. Публичный, чтобы дёргать из selfcheck и тестов. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let ingested = 0;
    try {
      const tickets = await this.client.activeTickets();
      for (const summary of tickets) {
        try {
          ingested += await this.ingestTicket(summary);
        } catch (err) {
          log.error(`Тикет ${summary.id}: не удалось обработать`, err);
        }
      }
      const checkedIds = new Set(tickets.map((ticket) => ticket.id));
      await this.syncMissingActiveTickets(checkedIds);
      await this.repairKnownTickets(checkedIds);
      this.store.setState('bedolaga:last_poll', String(Date.now()));
    } catch (err) {
      log.error('Опрос бедолаги не удался', err);
    } finally {
      this.running = false;
    }
    return ingested;
  }

  /**
   * Закрытые тикеты не входят в activeTickets. Поэтому каждый локально ещё
   * активный тикет, пропавший из живых списков, проверяем точечной ручкой.
   * Если его закрыли в Bedolaga, карточка сразу станет resolved; если тикет
   * снова откроют, он опять попадёт в обычный active poll.
   */
  private async syncMissingActiveTickets(checkedIds: Set<number>): Promise<void> {
    for (const conversation of this.store.listConversationsByChannel('bedolaga')) {
      if (conversation.status === 'closed' || conversation.status === 'resolved') continue;
      let ticketId: number;
      try {
        ticketId = ticketIdOf(conversation);
      } catch (err) {
        log.warn(`Диалог ${conversation.id}: синхронизация статуса Bedolaga пропущена`, err);
        continue;
      }
      if (checkedIds.has(ticketId)) continue;
      try {
        const ticket = await this.client.ticket(ticketId);
        checkedIds.add(ticketId);
        await this.ingestTicket(ticket, true);
      } catch (err) {
        log.warn(`Диалог ${conversation.id}: не удалось обновить статус Bedolaga`, err);
      }
    }
  }

  private async repairKnownTickets(activeIds: Set<number>): Promise<void> {
    if (this.mediaRepairFinished) return;
    if (this.store.getState(MEDIA_REPAIR_STATE)) {
      this.mediaRepairFinished = true;
      return;
    }

    let failed = 0;
    let checked = 0;
    for (const conversation of this.store.listConversationsByChannel('bedolaga')) {
      let ticketId: number;
      try {
        ticketId = ticketIdOf(conversation);
      } catch (err) {
        failed += 1;
        log.warn(`Диалог ${conversation.id}: repair Bedolaga пропущен`, err);
        continue;
      }
      // Живые тикеты уже обработаны выше тем же проходом.
      if (activeIds.has(ticketId)) continue;
      try {
        const ticket = await this.client.ticket(ticketId);
        activeIds.add(ticketId);
        await this.ingestTicket(ticket, true);
        checked += 1;
      } catch (err) {
        failed += 1;
        log.warn(`Диалог ${conversation.id}: не удалось восстановить медиа Bedolaga`, err);
      }
    }

    if (failed === 0) {
      this.store.setState(MEDIA_REPAIR_STATE, String(Date.now()));
      this.mediaRepairFinished = true;
      if (checked > 0) log.info(`Bedolaga: проверено архивных тикетов для восстановления медиа: ${checked}`);
    }
  }

  private async ingestTicket(summary: BedolagaTicket, forceBackfill = false): Promise<number> {
    const ticket = summary.messages?.length ? summary : await this.client.ticket(summary.id);
    const externalId = String(ticket.id);

    let conversation = this.store.findConversation('bedolaga', externalId, 'bedolaga-default');
    // Первая встреча с тикетом — вся его переписка это история, а не новые
    // события. Без этой отметки AI ответил бы на каждое сообщение архива,
    // а SLA прислал бы уведомление по каждому старому тикету.
    const backfill = forceBackfill || !conversation;
    if (!conversation) {
      conversation = this.store.upsertConversation({
        channel: 'bedolaga',
        externalId,
        subject: ticket.title ?? `Тикет #${ticket.id}`,
      });
    }

    // telegram_id в тикете нет — резолвим один раз через /users/{id}.
    if (!conversation.tg_user_id && ticket.user_id) {
      const user = await this.client.user(ticket.user_id);
      const telegramId = Number(user?.['telegram_id'] ?? user?.['tg_id'] ?? 0);
      if (telegramId) {
        this.store.setConversationUser(conversation.id, telegramId, user?.['username'] as string | undefined);
        conversation = this.store.getConversation(conversation.id)!;
      }
    }

    if (ticket.priority && ticket.priority !== conversation.priority) {
      this.store.setEscalated(conversation.id, conversation.escalated === 1, ticket.priority);
    }

    let ingested = 0;
    for (const message of ticket.messages ?? []) {
      const at = parseTimestamp(message);
      const text = message.message_text ?? '';
      const fileId = await this.resolveMediaFileId(ticket.id, message);

      if (message.is_from_admin) {
        const recorded = this.store.recordOutbound({
          conversationId: conversation.id,
          author: 'agent',
          text,
          mediaType: message.media_type,
          mediaFileId: fileId,
          externalMsgId: String(message.id),
          sentAt: at,
          dedupe: true,
          backfill,
        });
        if (recorded) {
          ingested += 1;
        } else if (fileId) {
          // Как и у входящих, старое сообщение могло быть записано до того,
          // как импорт научился сохранять вложения исходящих сообщений.
          const existing = this.store.findMessageByExternalId(conversation.id, String(message.id), 'out');
          if (existing) this.store.addAttachment(existing.id, message.media_type, `bedolaga:${fileId}`);
        }
        continue;
      }

      const recorded = this.store.recordInbound({
        channel: 'bedolaga',
        externalId,
        subject: ticket.title,
        text,
        mediaType: message.media_type,
        mediaFileId: fileId,
        externalMsgId: String(message.id),
        sentAt: at,
        backfill,
      });
      if (!recorded) {
        // Старые версии записывали сообщение до вложения. При повторном
        // опросе INSERT уже дедуплицируется, поэтому отдельно ремонтируем
        // ранее сохранённую картинку вместо того, чтобы терять её навсегда.
        const existing = fileId
          ? this.store.findMessageByExternalId(conversation.id, String(message.id), 'in')
          : undefined;
        if (existing && fileId) {
          this.store.addAttachment(existing.id, message.media_type, `bedolaga:${fileId}`);
        }
        continue;
      }
      ingested += 1;
    }
    const localStatus = localStatusForTicket(ticket.status);
    if (localStatus) this.store.setStatus(conversation.id, localStatus);
    return ingested;
  }

  private async resolveMediaFileId(ticketId: number, message: BedolagaMessage): Promise<string | undefined> {
    const direct = mediaFileId(message.media_file_id);
    if (direct || !message.has_media) return direct;
    const media = await this.client.messageMedia(ticketId, message.id);
    return mediaFileId(media?.['media_file_id'] ?? media?.['file_id'] ?? media?.['id']);
  }
}
