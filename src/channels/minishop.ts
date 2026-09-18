import { config, log } from '../config.js';
import type { AttachmentPayload, ChannelSender, SendPayload, SendResult } from '../core/outbox.js';
import type { Conversation, Store } from '../core/store.js';
import { readLimitedBody } from '../core/http.js';

const PAGE_LIMIT = 100;
const MAX_PAGES = 100;
const ACTIVE_STATUSES = new Set(['open', 'awaiting_user', 'awaiting_admin']);
const SOURCE_ID = 'minishop-default';

export type MinishopApiMode = 'plugin' | 'admin';
export type MinishopTicketStatus = 'open' | 'awaiting_user' | 'awaiting_admin' | 'resolved' | 'closed';

export interface MinishopUser {
  user_id?: number;
  telegram_id?: number | null;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  registration_date?: string | null;
}

export interface MinishopTicket {
  ticket_id: number;
  user_id: number;
  subject: string;
  category: string;
  priority: string;
  status: string;
  last_message_at?: string | null;
  last_message_role?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  user?: MinishopUser;
}

export interface MinishopMessage {
  message_id: number;
  ticket_id: number;
  author_role: string;
  author_user_id?: number | null;
  author_name?: string | null;
  body: string;
  body_format?: string;
  image_id?: string | null;
  is_internal_note: boolean;
  created_at?: string | null;
}

export interface MinishopTicketDetail {
  ok: boolean;
  ticket: MinishopTicket;
  messages: MinishopMessage[];
  user_snapshot?: Record<string, unknown>;
  peer_typing?: boolean;
}

interface JsonRecord { [key: string]: unknown }

function positiveId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label}: нужен положительный целый ID`);
  return id;
}

export function localStatusForMinishop(status: unknown): 'open' | 'pending' | 'resolved' | undefined {
  if (status === 'open' || status === 'awaiting_admin') return 'open';
  if (status === 'awaiting_user') return 'pending';
  if (status === 'resolved' || status === 'closed') return 'resolved';
  return undefined;
}

export function minishopStatusForLocal(status: string): MinishopTicketStatus {
  if (status === 'resolved') return 'resolved';
  if (status === 'pending') return 'awaiting_user';
  return 'awaiting_admin';
}

export function minishopTicketId(conversation: Conversation): number {
  return positiveId(conversation.remote_external_id ?? conversation.external_id, 'Тикет MiniShop');
}

export function parseMinishopTimestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** MiniShop stores a Telegram-safe HTML subset; the local thread is plain text. */
export function minishopMessageText(message: Pick<MinishopMessage, 'body' | 'body_format'>): string {
  if (message.body_format !== 'html') return message.body ?? '';
  return (message.body ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function displayName(user?: MinishopUser): string | undefined {
  if (!user) return undefined;
  const name = [user.first_name, user.last_name].filter((part): part is string => Boolean(part?.trim())).join(' ').trim();
  return name || user.username?.trim() || user.email?.trim() || undefined;
}

/**
 * Клиент двух поддерживаемых контрактов:
 * - plugin — постоянный service token плагина ai-support (рекомендуется);
 * - admin — штатный, ограниченный по времени AdminBearer MiniShop.
 */
export class MinishopClient {
  private readonly rootUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly mode: MinishopApiMode = 'plugin',
    private readonly timeoutMs = 30_000,
  ) {
    this.rootUrl = baseUrl.trim().replace(/\/+$/, '').replace(/\/api$/, '');
  }

  private prefix(): string {
    return this.mode === 'plugin' ? '/api/plugins/ai-support/v1' : '/api/admin';
  }

  private url(path: string, params?: Record<string, string | number>): string {
    const url = new URL(`${this.rootUrl}${this.prefix()}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));
    return url.toString();
  }

  private headers(extra?: RequestInit['headers']): Headers {
    const headers = new Headers(extra);
    if (this.mode === 'plugin') headers.set('X-API-Key', this.token);
    else headers.set('Authorization', `Bearer ${this.token}`);
    return headers;
  }

  private async request(
    path: string,
    init: RequestInit & { params?: Record<string, string | number> } = {},
    retries = 2,
  ): Promise<Response> {
    const { params, ...rest } = init;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(this.url(path, params), {
          ...rest,
          headers: this.headers(rest.headers),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
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

  private async json<T>(path: string, init: RequestInit & { params?: Record<string, string | number> } = {}, retries = 2): Promise<T> {
    const response = await this.request(path, init, retries);
    const body = await response.json().catch(() => null) as (JsonRecord & { message?: string; error?: string }) | null;
    if (!response.ok || body?.['ok'] === false) {
      const detail = body?.message ?? body?.error ?? `HTTP ${response.status}`;
      throw new Error(`${init.method ?? 'GET'} ${path} → ${detail}`);
    }
    return body as T;
  }

  async probe(): Promise<string> {
    if (this.mode === 'plugin') {
      const body = await this.json<{ ok: boolean; plugin?: string; version?: string }>('/health');
      return `${body.plugin ?? 'ai-support'}${body.version ? ` ${body.version}` : ''}`;
    }
    const body = await this.json<{ stats?: { active?: number } }>('/support/stats');
    return `Admin API, активных тикетов ${Number(body.stats?.active ?? 0)}`;
  }

  async activeTickets(): Promise<MinishopTicket[]> {
    const tickets: MinishopTicket[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await this.json<{ tickets?: MinishopTicket[] }>('/support/tickets', {
        params: { status: 'active', limit: PAGE_LIMIT, offset: page * PAGE_LIMIT },
      });
      const batch = Array.isArray(body.tickets) ? body.tickets : [];
      tickets.push(...batch);
      if (batch.length < PAGE_LIMIT) return tickets;
    }
    log.warn(`MiniShop: активных тикетов больше ${PAGE_LIMIT * MAX_PAGES} — хвост не обработан`);
    return tickets;
  }

  ticket(id: number): Promise<MinishopTicketDetail> {
    return this.json<MinishopTicketDetail>(`/support/tickets/${positiveId(id, 'Тикет MiniShop')}`);
  }

  async reply(ticketId: number, text: string): Promise<string | undefined> {
    const body = await this.json<{ message?: MinishopMessage }>(
      `/support/tickets/${positiveId(ticketId, 'Тикет MiniShop')}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: text, body_format: 'text', is_internal_note: false }),
      },
      0,
    );
    return body.message?.message_id !== undefined ? String(body.message.message_id) : undefined;
  }

  async replyWithImage(ticketId: number, payload: AttachmentPayload): Promise<string | undefined> {
    if (!payload.mimeType.startsWith('image/')) throw new Error('MiniShop принимает в тикетах только изображения');
    const form = new FormData();
    form.set('body', payload.caption ?? '');
    form.set('body_format', 'text');
    form.set('is_internal_note', 'false');
    form.set('image', new Blob([new Uint8Array(payload.bytes)], { type: payload.mimeType }), payload.fileName);
    const body = await this.json<{ message?: MinishopMessage }>(
      `/support/tickets/${positiveId(ticketId, 'Тикет MiniShop')}/messages`,
      { method: 'POST', body: form },
      0,
    );
    return body.message?.message_id !== undefined ? String(body.message.message_id) : undefined;
  }

  async setStatus(ticketId: number, status: MinishopTicketStatus): Promise<void> {
    await this.json(`/support/tickets/${positiveId(ticketId, 'Тикет MiniShop')}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    }, 0);
  }

  async markRead(ticketId: number): Promise<void> {
    await this.json(`/support/tickets/${positiveId(ticketId, 'Тикет MiniShop')}/read`, { method: 'POST' }, 0);
  }

  async downloadImage(imageId: string): Promise<Buffer | null> {
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(imageId)) return null;
    const response = await this.request(`/message-images/${encodeURIComponent(imageId)}`);
    if (!response.ok) return null;
    return readLimitedBody(response, config.mediaMaxFileBytes);
  }
}

export class MinishopSender implements ChannelSender {
  constructor(private readonly client: MinishopClient) {}

  async send(conversation: Conversation, payload: SendPayload): Promise<SendResult> {
    return { externalMsgId: await this.client.reply(minishopTicketId(conversation), payload.text) };
  }

  async sendAttachment(conversation: Conversation, payload: AttachmentPayload): Promise<SendResult> {
    return {
      externalMsgId: await this.client.replyWithImage(minishopTicketId(conversation), payload),
      mediaType: 'photo',
    };
  }
}

export class MinishopPoller {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly client: MinishopClient,
    private readonly store: Store,
    private readonly intervalMs: number,
    private readonly sourceName = 'MiniShop',
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let ingested = 0;
    const baselineReady = Boolean(this.store.getState('minishop:last_poll'));
    try {
      const tickets = await this.client.activeTickets();
      for (const summary of tickets) {
        try {
          ingested += await this.ingestTicket(summary.ticket_id, false, baselineReady);
        } catch (err) {
          log.error(`MiniShop: тикет ${summary.ticket_id} не удалось обработать`, err);
        }
      }
      const activeIds = new Set(tickets.map((ticket) => ticket.ticket_id));
      await this.syncMissingActiveTickets(activeIds);
      this.store.setState('minishop:last_poll', String(Date.now()));
    } catch (err) {
      log.error('Опрос MiniShop не удался', err);
    } finally {
      this.running = false;
    }
    return ingested;
  }

  private async syncMissingActiveTickets(activeIds: Set<number>): Promise<void> {
    for (const conversation of this.store.listConversationsByChannel('minishop')) {
      if (conversation.status === 'closed' || conversation.status === 'resolved') continue;
      const ticketId = minishopTicketId(conversation);
      if (activeIds.has(ticketId)) continue;
      try {
        await this.ingestTicket(ticketId, true, true);
      } catch (err) {
        log.warn(`MiniShop: статус тикета ${ticketId} не удалось обновить`, err);
      }
    }
  }

  private async ingestTicket(ticketId: number, forceBackfill: boolean, baselineReady: boolean): Promise<number> {
    const detail = await this.client.ticket(ticketId);
    const ticket = detail.ticket;
    const externalId = String(ticket.ticket_id);
    let conversation = this.store.findConversation('minishop', externalId, SOURCE_ID);
    const firstSeen = !conversation;
    const visibleMessages = (detail.messages ?? []).filter((message) => !message.is_internal_note);
    const latest = firstSeen && baselineReady && !forceBackfill
      ? visibleMessages.reduce<MinishopMessage | undefined>((best, message) => {
          if (!best) return message;
          const messageAt = parseMinishopTimestamp(message.created_at, 0);
          const bestAt = parseMinishopTimestamp(best.created_at, 0);
          if (messageAt !== bestAt) return messageAt > bestAt ? message : best;
          return message.message_id >= best.message_id ? message : best;
        }, undefined)
      : undefined;
    const liveMessageId = latest?.author_role === 'user' ? String(latest.message_id) : undefined;
    const user = ticket.user ?? {};

    if (!conversation) {
      conversation = this.store.upsertConversation({
        channel: 'minishop',
        externalId,
        sourceId: SOURCE_ID,
        sourceName: this.sourceName,
        sourceKind: 'minishop',
        subject: ticket.subject || `Тикет #${ticket.ticket_id}`,
        tgUserId: user.telegram_id ? Number(user.telegram_id) : undefined,
        username: user.username ?? undefined,
        displayName: displayName(user),
      });
    }

    if (!conversation.tg_user_id && user.telegram_id) {
      this.store.setConversationUser(conversation.id, Number(user.telegram_id), user.username ?? undefined);
      conversation = this.store.getConversation(conversation.id)!;
    }
    if (ticket.priority && ticket.priority !== conversation.priority) {
      this.store.setEscalated(conversation.id, conversation.escalated === 1, ticket.priority);
    }

    let ingested = 0;
    for (const message of visibleMessages) {
      const messageId = String(message.message_id);
      const at = parseMinishopTimestamp(message.created_at);
      const text = minishopMessageText(message);
      const imageId = message.image_id?.trim() || undefined;
      const backfill = forceBackfill || (firstSeen && (!baselineReady || messageId !== liveMessageId));

      if (message.author_role !== 'user') {
        const recorded = this.store.recordOutbound({
          conversationId: conversation.id,
          author: 'agent',
          text,
          mediaType: imageId ? 'photo' : undefined,
          mediaFileId: imageId,
          externalMsgId: messageId,
          sentAt: at,
          dedupe: true,
          backfill,
        });
        if (recorded) ingested += 1;
        continue;
      }

      const recorded = this.store.recordInbound({
        channel: 'minishop',
        externalId,
        sourceId: SOURCE_ID,
        sourceName: this.sourceName,
        sourceKind: 'minishop',
        tgUserId: user.telegram_id ? Number(user.telegram_id) : undefined,
        username: user.username ?? undefined,
        displayName: displayName(user),
        subject: ticket.subject,
        text,
        mediaType: imageId ? 'photo' : undefined,
        mediaFileId: imageId,
        externalMsgId: messageId,
        sentAt: at,
        backfill,
      });
      if (recorded) ingested += 1;
    }

    const localStatus = localStatusForMinishop(ticket.status);
    if (localStatus) this.store.setStatus(conversation.id, localStatus);
    return ingested;
  }
}

export function isActiveMinishopStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}
