import type { BedolagaClient, BedolagaPage } from '../channels/bedolaga.js';
import { ticketIdOf } from '../channels/bedolaga.js';
import type { Conversation } from '../core/store.js';

type JsonRecord = Record<string, unknown>;

export interface SafeBedolagaSubscription {
  id: number;
  userId?: number;
  status?: string;
  actualStatus?: string;
  isTrial: boolean;
  startDate?: string;
  endDate?: string;
  trafficLimitGb?: number;
  trafficUsedGb?: number;
  deviceLimit?: number;
  autopayEnabled: boolean;
  autopayDaysBefore?: number;
  tariffId?: number;
  tariffName?: string;
  connectedSquadsCount: number;
  hasAccessLink: boolean;
}

export interface BedolagaCustomerCard {
  loadedAt: number;
  /** Изменяющие операции разрешены только для личности, подтверждённой ID. */
  identityVerified: boolean;
  user: {
    id: number;
    telegramId?: number;
    username?: string;
    fullName?: string;
    email?: string;
    status?: string;
    language?: string;
    balanceRubles?: number;
    referralCode?: string;
    referredById?: number;
    hasHadPaidSubscription: boolean;
    hasMadeFirstTopup: boolean;
    createdAt?: string;
    updatedAt?: string;
    lastActivity?: string;
    promoGroup?: {
      id?: number;
      name?: string;
      serverDiscountPercent?: number;
      trafficDiscountPercent?: number;
      deviceDiscountPercent?: number;
      applyDiscountsToAddons: boolean;
    };
  };
  subscriptions: { items: SafeBedolagaSubscription[]; total: number; truncated: boolean };
  transactions: {
    items: Array<{
      id: number;
      type?: string;
      amountRubles?: number;
      description?: string;
      paymentMethod?: string;
      isCompleted: boolean;
      createdAt?: string;
      completedAt?: string;
    }>;
    total: number;
    truncated: boolean;
  };
  tickets: {
    items: Array<{
      id: number;
      title?: string;
      status?: string;
      priority?: string;
      createdAt?: string;
      updatedAt?: string;
      closedAt?: string;
      messageCount: number;
    }>;
    total: number;
    truncated: boolean;
  };
  referrals: {
    invitedCount: number;
    activeReferrals: number;
    totalEarnedRubles?: number;
    monthEarnedRubles?: number;
    commissionPercent?: number;
    items: Array<{
      id: number;
      telegramId?: number;
      fullName?: string;
      username?: string;
      status?: string;
      balanceRubles?: number;
      totalEarnedRubles?: number;
      topupsCount?: number;
      createdAt?: string;
      lastActivity?: string;
    }>;
    total: number;
    truncated: boolean;
  };
  activity: {
    items: Array<{
      id: number;
      eventType?: string;
      subscriptionId?: number;
      transactionId?: number;
      ticketId?: number;
      amountRubles?: number;
      currency?: string;
      occurredAt?: string;
      createdAt?: string;
    }>;
    total: number;
  };
  gifts: {
    items: Array<{
      id: number;
      subscriptionId?: number;
      notificationType?: string;
      discountPercent?: number;
      bonusAmountRubles?: number;
      effectType?: string;
      expiresAt?: string;
      claimedAt?: string;
      isActive: boolean;
      createdAt?: string;
    }>;
    total: number;
    available: boolean;
    reason?: string;
  };
  warnings: string[];
}

const record = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;

const text = (value: unknown, max = 240): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const result = String(value).trim();
  return result ? result.slice(0, max) : undefined;
};

const safeNote = (value: unknown): string | undefined => {
  const valueText = text(value, 500);
  if (!valueText) return undefined;
  return valueText
    // В описании платежа или теме тикета может оказаться не только HTTP,
    // но и рабочая ссылка vless://, tg:// и т.п. Любая URI-схема здесь
    // потенциально является credential, поэтому оператору показываем лишь
    // факт наличия ссылки.
    .replace(/\b[a-z][a-z0-9+.-]{1,31}:\/\/\S+/gi, '[ссылка скрыта]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [скрыто]')
    .replace(/\b(token|secret|api[_-]?key|password|subscription[_-]?(?:url|link))\s*[:=]\s*\S+/gi, '$1=[скрыто]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g, '[токен скрыт]');
};

const number = (value: unknown): number | undefined => {
  if (value === '' || value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const integer = (value: unknown): number | undefined => {
  const parsed = number(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
};

const positiveInteger = (value: unknown): number | undefined => {
  const parsed = integer(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
};

const CARD_PAGE_LIMIT = 200;
const CARD_MAX_ITEMS = 10_000;

export interface CollectedBedolagaPage<T extends JsonRecord = JsonRecord> extends BedolagaPage<T> {
  truncated: boolean;
}

/**
 * Карточка обещает историю целиком, поэтому проходим все страницы API.
 * Жёсткий предел защищает панель от ошибочного/враждебного `total`; если он
 * достигнут, UI получает явный `truncated`, а не молча выдаёт первые 100 за
 * полный список.
 */
export async function collectBedolagaPages<T extends JsonRecord>(
  fetchPage: (limit: number, offset: number) => Promise<BedolagaPage<T>>,
  maxItems = CARD_MAX_ITEMS,
): Promise<CollectedBedolagaPage<T>> {
  const items: T[] = [];
  let total = 0;
  let offset = 0;
  let previousSignature = '';

  while (items.length < maxItems) {
    const limit = Math.min(CARD_PAGE_LIMIT, maxItems - items.length);
    const page = await fetchPage(limit, offset);
    const batch = Array.isArray(page.items) ? page.items : [];
    const reportedTotal = Number.isSafeInteger(page.total) && page.total >= 0 ? page.total : 0;
    if (!batch.length) {
      // Для старого массивного контракта полная страница временно задаёт
      // total=offset+limit+1, чтобы запросить следующую. Пустая следующая
      // страница доказывает точное окончание списка и должна убрать этот
      // служебный «+1», иначе полный результат ошибочно выглядит обрезанным.
      total = reportedTotal <= offset
        ? Math.max(items.length, reportedTotal)
        : Math.max(total, reportedTotal);
      break;
    }
    total = Math.max(total, reportedTotal, offset + batch.length);

    // Если удалённый endpoint игнорирует offset, не набиваем карточку
    // повторениями до предела и честно помечаем результат неполным.
    const signature = batch.map((item) => positiveInteger(item['id']) ?? '?').join(',');
    if (offset > 0 && signature === previousSignature) break;
    previousSignature = signature;

    items.push(...batch.slice(0, maxItems - items.length));
    offset += batch.length;
    if (offset >= total) break;
  }

  return {
    items,
    total: Math.max(total, items.length),
    limit: CARD_PAGE_LIMIT,
    offset: 0,
    truncated: items.length < total,
  };
}

const boolean = (value: unknown): boolean => value === true || value === 1 || value === 'true';

const date = (value: unknown): string | undefined => {
  const candidate = text(value, 80);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : undefined;
};

const rubles = (source: JsonRecord, rublesKey: string, kopeksKey: string): number | undefined => {
  const direct = number(source[rublesKey]);
  if (direct !== undefined) return direct;
  const kopeks = number(source[kopeksKey]);
  return kopeks !== undefined ? kopeks / 100 : undefined;
};

function fullName(source: JsonRecord): string | undefined {
  const explicit = text(source['full_name']);
  if (explicit) return explicit;
  const joined = [text(source['first_name']), text(source['last_name'])].filter(Boolean).join(' ').trim();
  return joined || undefined;
}

export function bedolagaSubscriptionRecords(user: JsonRecord, fetched: JsonRecord[] = []): JsonRecord[] {
  const embedded = Array.isArray(user['subscriptions']) ? user['subscriptions'].map(record).filter((item): item is JsonRecord => !!item) : [];
  const current = record(user['subscription']);
  const seen = new Set<number>();
  const result: JsonRecord[] = [];
  for (const item of [...fetched, ...embedded, ...(current ? [current] : [])]) {
    const id = positiveInteger(item['id']);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

export function normalizeBedolagaSubscription(source: JsonRecord): SafeBedolagaSubscription | null {
  const id = positiveInteger(source['id']);
  if (!id) return null;
  const squads = source['connected_squads'];
  const count = Array.isArray(squads) ? squads.length : Math.max(0, integer(source['connected_squads_count']) ?? 0);
  return {
    id,
    userId: positiveInteger(source['user_id']),
    status: text(source['status'], 40),
    actualStatus: text(source['actual_status'], 40),
    isTrial: boolean(source['is_trial']),
    startDate: date(source['start_date']),
    endDate: date(source['end_date']),
    trafficLimitGb: number(source['traffic_limit_gb']),
    trafficUsedGb: number(source['traffic_used_gb']),
    deviceLimit: integer(source['device_limit']),
    autopayEnabled: boolean(source['autopay_enabled']),
    autopayDaysBefore: integer(source['autopay_days_before']),
    tariffId: positiveInteger(source['tariff_id']),
    tariffName: text(source['tariff_name'], 120),
    connectedSquadsCount: count,
    // Ссылка — живой credential. Клиенту панели сообщаем только наличие.
    hasAccessLink: Boolean(text(source['subscription_url']) || text(source['subscription_crypto_link'])),
  };
}

/**
 * Находим пользователя через наиболее надёжный идентификатор. Для тикета
 * Bedolaga `external_id` — ID тикета, не пользователя, поэтому сначала
 * запрашиваем сам тикет и лишь затем `/users/{ticket.user_id}`.
 */
export interface BedolagaUserResolution {
  user: JsonRecord;
  source: 'telegram_id' | 'ticket_user_id' | 'username';
  verified: boolean;
}

async function resolveBedolagaUserIdentity(
  client: BedolagaClient,
  conversation: Conversation,
  allowUsername: boolean,
): Promise<BedolagaUserResolution | null> {
  if (conversation.channel === 'bedolaga') {
    // В Bedolaga-диалоге сохранённый tg_user_id может устареть или быть
    // повреждён. Для финансовой операции доверяем только владельцу самого
    // тикета; fallback по Telegram/username остаётся лишь для других каналов
    // и read-only поиска соответственно.
    const ticket = await client.ticket(ticketIdOf(conversation));
    const userId = positiveInteger(ticket.user_id);
    if (userId) {
      const byTicket = await client.user(userId);
      if (byTicket && positiveInteger(byTicket['id']) === userId) {
        return { user: byTicket, source: 'ticket_user_id', verified: true };
      }
    }
    if (!allowUsername) return null;
  } else if (conversation.tg_user_id && Number.isSafeInteger(conversation.tg_user_id)) {
    const byTelegram = await client.userByTelegramId(conversation.tg_user_id);
    if (byTelegram && positiveInteger(byTelegram['telegram_id']) === conversation.tg_user_id) {
      return { user: byTelegram, source: 'telegram_id', verified: true };
    }
  }
  if (!allowUsername) return null;
  const username = conversation.username?.replace(/^@/, '').trim().toLowerCase();
  if (!username) return null;
  const candidates = await client.searchUsers(username, 20);
  const user = candidates.find((item) => text(item['username'])?.replace(/^@/, '').toLowerCase() === username);
  return user ? { user, source: 'username', verified: false } : null;
}

export async function resolveBedolagaUser(
  client: BedolagaClient,
  conversation: Conversation,
): Promise<JsonRecord | null> {
  return (await resolveBedolagaUserIdentity(client, conversation, true))?.user ?? null;
}

/** Username пригоден для read-only подсказки, но не для финансовой мутации. */
export async function resolveVerifiedBedolagaUser(
  client: BedolagaClient,
  conversation: Conversation,
): Promise<JsonRecord | null> {
  return (await resolveBedolagaUserIdentity(client, conversation, false))?.user ?? null;
}

type SectionName = 'subscriptions' | 'transactions' | 'tickets' | 'referrals';

export async function loadBedolagaCustomer(
  client: BedolagaClient,
  conversation: Conversation,
): Promise<BedolagaCustomerCard | null> {
  const resolution = await resolveBedolagaUserIdentity(client, conversation, true);
  if (!resolution) return null;
  const user = resolution.user;
  const userId = positiveInteger(user['id']);
  if (!userId) throw new Error('Bedolaga вернула пользователя без корректного ID');

  let referralSummary: JsonRecord = {};
  const tasks = {
    subscriptions: collectBedolagaPages((limit, offset) => client.subscriptions(userId, limit, offset)),
    transactions: collectBedolagaPages((limit, offset) => client.transactions(userId, limit, offset)),
    tickets: collectBedolagaPages((limit, offset) => client.ticketsForUser(userId, limit, offset)),
    referrals: collectBedolagaPages(async (limit, offset) => {
      const root = record(await client.referralDetails(userId, limit, offset)) ?? {};
      const referrals = record(root['referrals']) ?? {};
      if (offset === 0) referralSummary = record(root['referrer']) ?? {};
      const items = Array.isArray(referrals['items'])
        ? referrals['items'].map(record).filter((item): item is JsonRecord => !!item)
        : [];
      return {
        items,
        total: Math.max(0, integer(referrals['total']) ?? items.length),
        limit,
        offset,
      };
    }),
  };
  const names = Object.keys(tasks) as SectionName[];
  const settled = await Promise.allSettled(names.map((name) => tasks[name]));
  const values = new Map<SectionName, unknown>();
  const warnings: string[] = [];
  const labels: Record<SectionName, string> = {
    subscriptions: 'подписки', transactions: 'платежи', tickets: 'тикеты', referrals: 'рефералы',
  };
  settled.forEach((result, index) => {
    const name = names[index]!;
    if (result.status === 'fulfilled') values.set(name, result.value);
    else warnings.push(`Не удалось загрузить: ${labels[name]}`);
  });

  const page = (name: SectionName): CollectedBedolagaPage => {
    const value = values.get(name);
    return value && typeof value === 'object' && Array.isArray((value as CollectedBedolagaPage).items)
      ? value as CollectedBedolagaPage
      : { items: [], total: 0, limit: CARD_PAGE_LIMIT, offset: 0, truncated: false };
  };

  const subscriptionPage = page('subscriptions');
  const subscriptionRecords = bedolagaSubscriptionRecords(user, subscriptionPage.items);
  const subscriptions = subscriptionRecords
    .map(normalizeBedolagaSubscription)
    .filter((item): item is SafeBedolagaSubscription => !!item);
  const transactionPage = page('transactions');
  const ticketPage = page('tickets');

  const referralCollected = page('referrals');
  const referrer = referralSummary;
  const referralItems = referralCollected.items;
  const promo = record(user['promo_group']);
  const transactionItems = transactionPage.items.map((item) => ({
    id: positiveInteger(item['id']) ?? 0,
    type: text(item['type'], 60),
    amountRubles: rubles(item, 'amount_rubles', 'amount_kopeks'),
    description: safeNote(item['description']),
    paymentMethod: text(item['payment_method'], 80),
    isCompleted: boolean(item['is_completed']) || text(item['status'], 40) === 'completed',
    createdAt: date(item['created_at']),
    completedAt: date(item['completed_at']),
  })).filter((item) => item.id > 0);
  const ticketItems = ticketPage.items.map((item) => ({
    id: positiveInteger(item['id']) ?? 0,
    title: safeNote(item['title']),
    status: text(item['status'], 40),
    priority: text(item['priority'], 40),
    createdAt: date(item['created_at']),
    updatedAt: date(item['updated_at']),
    closedAt: date(item['closed_at']),
    messageCount: Array.isArray(item['messages']) ? item['messages'].length : Math.max(0, integer(item['messages_count']) ?? 0),
  })).filter((item) => item.id > 0);
  const normalizedReferrals = referralItems.map((item) => ({
    id: positiveInteger(item['id']) ?? 0,
    telegramId: positiveInteger(item['telegram_id']),
    fullName: fullName(item),
    username: text(item['username'], 80)?.replace(/^@/, ''),
    status: text(item['status'], 40),
    balanceRubles: rubles(item, 'balance_rubles', 'balance_kopeks'),
    totalEarnedRubles: rubles(item, 'total_earned_rubles', 'total_earned_kopeks'),
    topupsCount: Math.max(0, integer(item['topups_count']) ?? 0),
    createdAt: date(item['created_at']),
    lastActivity: date(item['last_activity']),
  })).filter((item) => item.id > 0);

  // У Bedolaga нет документированного X-API-Key endpoint общей активности.
  // Строим честную ленту из временных меток уже загруженных сущностей.
  // Так карточка не зависит от выдуманного маршрута и не скрывает частичный сбой.
  type ActivityItem = BedolagaCustomerCard['activity']['items'][number];
  const activityItems: ActivityItem[] = [];
  const addActivity = (
    eventType: string,
    occurredAt: string | undefined,
    details: Omit<Partial<ActivityItem>, 'id' | 'eventType' | 'occurredAt'> = {},
  ): void => {
    if (occurredAt) activityItems.push({ id: 0, eventType, occurredAt, ...details });
  };
  addActivity('user_registered', date(user['created_at']));
  addActivity('user_updated', date(user['updated_at']));
  addActivity('user_activity', date(user['last_activity']));
  for (const subscription of subscriptions) {
    addActivity('subscription_started', subscription.startDate, { subscriptionId: subscription.id });
  }
  for (const transaction of transactionItems) {
    addActivity(transaction.isCompleted ? 'transaction_completed' : 'transaction_created',
      transaction.completedAt ?? transaction.createdAt,
      { transactionId: transaction.id, amountRubles: transaction.amountRubles });
  }
  for (const ticket of ticketItems) {
    addActivity('ticket_opened', ticket.createdAt, { ticketId: ticket.id });
    if (ticket.closedAt) addActivity('ticket_closed', ticket.closedAt, { ticketId: ticket.id });
    else if (ticket.updatedAt && ticket.updatedAt !== ticket.createdAt) {
      addActivity('ticket_updated', ticket.updatedAt, { ticketId: ticket.id });
    }
  }
  activityItems.sort((left, right) => Date.parse(right.occurredAt ?? '') - Date.parse(left.occurredAt ?? ''));
  activityItems.forEach((item, index) => { item.id = index + 1; });
  const activityTotal = activityItems.length;

  const sectionPages: Array<[SectionName, CollectedBedolagaPage]> = [
    ['subscriptions', subscriptionPage as CollectedBedolagaPage],
    ['transactions', transactionPage as CollectedBedolagaPage],
    ['tickets', ticketPage as CollectedBedolagaPage],
    ['referrals', referralCollected as CollectedBedolagaPage],
  ];
  for (const [name, section] of sectionPages) {
    if (section.truncated) {
      warnings.push(`${labels[name]}: показаны первые ${section.items.length} из ${section.total}`);
    }
  }
  if (!resolution.verified) {
    warnings.push('Клиент найден только по username: финансовые изменения отключены до подтверждения Telegram ID или ID тикета.');
  }

  return {
    loadedAt: Date.now(),
    identityVerified: resolution.verified,
    user: {
      id: userId,
      telegramId: positiveInteger(user['telegram_id']),
      username: text(user['username'], 80)?.replace(/^@/, ''),
      fullName: fullName(user),
      email: text(user['email'], 320),
      status: text(user['status'], 40),
      language: text(user['language'], 16),
      balanceRubles: rubles(user, 'balance_rubles', 'balance_kopeks'),
      referralCode: text(user['referral_code'], 120),
      referredById: positiveInteger(user['referred_by_id']),
      hasHadPaidSubscription: boolean(user['has_had_paid_subscription']),
      hasMadeFirstTopup: boolean(user['has_made_first_topup']),
      createdAt: date(user['created_at']),
      updatedAt: date(user['updated_at']),
      lastActivity: date(user['last_activity']),
      promoGroup: promo ? {
        id: positiveInteger(promo['id']),
        name: text(promo['name'], 120),
        serverDiscountPercent: number(promo['server_discount_percent']),
        trafficDiscountPercent: number(promo['traffic_discount_percent']),
        deviceDiscountPercent: number(promo['device_discount_percent']),
        applyDiscountsToAddons: boolean(promo['apply_discounts_to_addons']),
      } : undefined,
    },
    subscriptions: {
      items: subscriptions,
      total: Math.max(subscriptionPage.total, subscriptions.length),
      truncated: Boolean((subscriptionPage as CollectedBedolagaPage).truncated),
    },
    transactions: {
      items: transactionItems,
      total: transactionPage.total,
      truncated: Boolean((transactionPage as CollectedBedolagaPage).truncated),
    },
    tickets: {
      items: ticketItems,
      total: ticketPage.total,
      truncated: Boolean((ticketPage as CollectedBedolagaPage).truncated),
    },
    referrals: {
      invitedCount: Math.max(0, integer(referrer['invited_count']) ?? referralItems.length),
      activeReferrals: Math.max(0, integer(referrer['active_referrals']) ?? 0),
      totalEarnedRubles: rubles(referrer, 'total_earned_rubles', 'total_earned_kopeks'),
      monthEarnedRubles: rubles(referrer, 'month_earned_rubles', 'month_earned_kopeks'),
      commissionPercent: number(referrer['effective_referral_commission_percent'] ?? referrer['referral_commission_percent']),
      items: normalizedReferrals,
      total: referralCollected.total,
      truncated: Boolean((referralCollected as CollectedBedolagaPage).truncated),
    },
    activity: {
      items: activityItems.slice(0, 100),
      total: activityTotal,
    },
    gifts: {
      items: [],
      total: 0,
      available: false,
      reason: 'История подарков требует отдельной авторизации кабинета Bedolaga и не запрашивается по API-ключу интеграции.',
    },
    warnings,
  };
}
