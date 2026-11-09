/** Чистые функции панели «Клиент»: подписи, вкладки Bedolaga, числа (тесты — client.test.ts). */
import { t, type Key } from '@/i18n/ru';
import type { BedolagaCard } from './types';

const GB = 1024 ** 3;
export const DAY = 86_400_000;

export type SubStatus = 'active' | 'expired' | 'disabled' | 'limited';

/** Статус подписки из Remnawave или Bedolaga словами; null — неизвестное значение (показываем как есть). */
export function statusWords(raw: string | undefined): SubStatus | null {
  const value = (raw ?? '').toLowerCase();
  if (value === 'active') return 'active';
  if (value === 'expired') return 'expired';
  if (value === 'disabled' || value === 'blocked') return 'disabled';
  if (value === 'limited') return 'limited';
  return null;
}

const STATUS_KEY: Record<SubStatus, Key> = {
  active: 'client.status.active', expired: 'client.status.expired', disabled: 'client.status.disabled', limited: 'client.status.limited',
};
export function statusLabel(raw: string | undefined): string {
  const code = statusWords(raw);
  return code ? t(STATUS_KEY[code]) : (raw ?? '—');
}

/** «41» или «12,5» — гигабайты без лишних нулей. */
export function gb(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  const value = bytes / GB;
  return (value >= 10 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, '')).replace('.', ',');
}

const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 });
export function rubles(value: number | undefined | null): string {
  return value === undefined || value === null || !Number.isFinite(Number(value)) ? '—' : money.format(Number(value));
}

const dateFmt = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric' });
export function longDate(value: string | number | undefined): string {
  if (value === undefined || value === '') return '—';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? dateFmt.format(ms).replace(/\s*г\.?$/, '') : '—';
}

/** Целых дней до даты; отрицательное — истекла. */
export function daysUntil(value: string | undefined, now: number): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.ceil((ms - now) / DAY) : null;
}

export type BedTab = 'overview' | 'subscriptions' | 'transactions' | 'tickets' | 'referrals' | 'activity' | 'gifts';

/** Подпись вкладки со счётчиком; у обрезанного раздела — «N из M». */
function tabLabel(key: Key, section: { items: unknown[]; total: number; truncated?: boolean } | undefined): string {
  const total = section?.total ?? 0;
  return section?.truncated ? `${t(key)} · ${section.items.length} из ${total}` : `${t(key)} · ${total}`;
}

/** Семь вкладок поимённо, как в классике (прил. А.I). */
export function tabsOf(card: BedolagaCard): Array<{ value: BedTab; label: string }> {
  return [
    { value: 'overview', label: t('bed.tab.overview') },
    { value: 'subscriptions', label: tabLabel('bed.tab.subscriptions', card.subscriptions) },
    { value: 'transactions', label: tabLabel('bed.tab.transactions', card.transactions) },
    { value: 'tickets', label: tabLabel('bed.tab.tickets', card.tickets) },
    { value: 'referrals', label: tabLabel('bed.tab.referrals', card.referrals) },
    { value: 'activity', label: tabLabel('bed.tab.activity', card.activity) },
    { value: 'gifts', label: tabLabel('bed.tab.gifts', card.gifts) },
  ];
}

/**
 * «Подарки»: при недоступной истории — причина от сервера (например, нужна
 * отдельная авторизация кабинета); без причины — null, и панель пишет
 * «История подарков недоступна для этой интеграции». undefined — история есть.
 */
export function giftsView(gifts: BedolagaCard['gifts'] | undefined): { unavailable: string | null | undefined } {
  if (gifts?.available === false) return { unavailable: gifts.reason ?? null };
  return { unavailable: undefined };
}

const BED_STATUS: Record<string, Key> = {
  active: 'bed.st.active', disabled: 'bed.st.disabled', blocked: 'bed.st.blocked', open: 'bed.st.open', answered: 'bed.st.answered',
  pending: 'bed.st.pending', closed: 'bed.st.closed', completed: 'bed.st.completed', expired: 'bed.st.expired',
};
export function bedStatus(value: string | undefined): string {
  if (!value) return '—';
  const key = BED_STATUS[value.toLowerCase()];
  return key ? t(key) : value;
}

const BED_EVENT: Record<string, Key> = {
  user_registered: 'bed.ev.registered', user_updated: 'bed.ev.updated', user_activity: 'bed.ev.activity',
  subscription_started: 'bed.ev.subStarted', transaction_completed: 'bed.ev.paid', transaction_created: 'bed.ev.payCreated',
  ticket_opened: 'bed.ev.ticketOpened', ticket_updated: 'bed.ev.ticketUpdated', ticket_closed: 'bed.ev.ticketClosed',
};
export function bedEvent(value: string | undefined): string {
  if (!value) return '—';
  const key = BED_EVENT[value];
  return key ? t(key) : value;
}
