/**
 * Ответы маршрутов карточки клиента (src/panel/routes/customers.ts). Сервер
 * отдаёт их без общих типов, поэтому здесь — только то, что читает панель,
 * и всё необязательное: источник может не прислать поле.
 */

/** GET /api/conversations/:id/customer — сводка из всех источников (src/integrations/customers.ts Profile). */
export interface CustomerProfile {
  found: boolean;
  identity: { telegramId?: number; username?: string; name?: string };
  subscription?: {
    status?: string;
    expiresAt?: string;
    trafficUsed?: number;
    trafficLimit?: number;
    deviceLimit?: number;
    devices?: number;
    shortId?: string;
  };
  activity?: {
    firstSeen?: string;
    dailyAverageBytes?: number;
    topNodes?: { name: string; bytes: number }[];
    lastNode?: string;
  };
  balance?: { amount?: number; currency?: string; payments?: number };
  sources: string[];
  trace?: string[];
  sourceFailed?: boolean;
}

export interface CustomerResponse { customer: CustomerProfile | null; checkedAt?: number | null }

/** GET /api/conversations/:id/profile — единый профиль: данные, теги, заметки, другие диалоги. */
export interface UnifiedProfile {
  id: number;
  display_name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  username: string | null;
  created_at: number;
  tags: string[];
  notes: Array<{ id: number; actor_key: string; author_name?: string; text: string; created_at: number }>;
  related: Array<{ id: number; channel: string; display_name: string | null; username: string | null; status: string; last_message_at: number }>;
}

/** GET /api/conversations/:id/subscription — Remnawave. */
export interface SubscriptionResponse {
  ref: string;
  panel: { id: string; name: string } | null;
  profile: {
    status?: string;
    expiresAt?: string;
    trafficUsed?: number;
    trafficLimit?: number;
    deviceLimit?: number;
    subscriptionUrl?: string;
    shortId?: string;
  } | null;
  devices: Array<{ id: string; hwid: string; platform?: string; model?: string; seenAt?: string }> | null;
  capabilities: { profile: boolean; devices: boolean; deleteDevice: boolean; resetDevices: boolean; revoke: boolean };
}

export interface ExplainResponse { ref?: string; steps: string[]; indexSize: number; near: string[] }

interface Section<T> { items: T[]; total: number; truncated: boolean }

export interface BedolagaSubscription {
  id: number;
  status?: string;
  actualStatus?: string;
  isTrial?: boolean;
  endDate?: string;
  trafficUsedGb?: number;
  trafficLimitGb?: number;
  deviceLimit?: number;
  connectedSquadsCount?: number;
  autopayEnabled?: boolean;
  hasAccessLink?: boolean;
}

/** GET /api/conversations/:id/bedolaga/customer (src/integrations/bedolaga-customer.ts BedolagaCustomerCard). */
export interface BedolagaCard {
  loadedAt: number;
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
    lastActivity?: string;
    promoGroup?: { name?: string; serverDiscountPercent?: number; trafficDiscountPercent?: number; deviceDiscountPercent?: number };
  };
  subscriptions: Section<BedolagaSubscription>;
  transactions: Section<{ id: number; type?: string; amountRubles?: number; description?: string; paymentMethod?: string; isCompleted: boolean; createdAt?: string; completedAt?: string }>;
  tickets: Section<{ id: number; title?: string; status?: string; priority?: string; messageCount?: number; createdAt?: string; closedAt?: string }>;
  referrals: Section<{ id: number; fullName?: string; username?: string; status?: string; balanceRubles?: number; totalEarnedRubles?: number; topupsCount?: number; lastActivity?: string }> & {
    invitedCount?: number; activeReferrals?: number; totalEarnedRubles?: number; monthEarnedRubles?: number; commissionPercent?: number;
  };
  activity: Section<{ id: number; eventType?: string; subscriptionId?: number; transactionId?: number; ticketId?: number; amountRubles?: number; occurredAt?: string; createdAt?: string }>;
  gifts: Section<{ id: number; notificationType?: string; subscriptionId?: number; effectType?: string; discountPercent?: number; bonusAmountRubles?: number; expiresAt?: string; isActive?: boolean; claimedAt?: string }> & {
    available?: boolean; reason?: string;
  };
  warnings?: string[];
}

export interface BedolagaResponse { customer: BedolagaCard; capabilities: { canExtendSubscription: boolean } }

export interface ExtendResponse { ok: boolean; outcome?: 'unknown'; warning?: string; subscription?: BedolagaSubscription }
