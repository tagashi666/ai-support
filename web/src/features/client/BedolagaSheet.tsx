import type { ComponentChildren, JSX } from 'preact';
import { useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { clock } from '@/lib/format/format';
import { extensions } from '@/lib/client/extend';
import type { BedolagaCard, BedolagaSubscription } from '@/lib/client/types';
import { bedEvent, bedStatus, giftsView, longDate, rubles, tabsOf, type BedTab } from '@/lib/client/view';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import { Tabs } from '@/ui/Tabs';
import s from './client.module.css';

const v = (value: unknown): string => (value === undefined || value === null || value === '' ? '—' : String(value));
const pct = (value: number | undefined | null): string => (value === undefined || value === null ? '—' : `${value}%`);

function Kpi({ label, value }: { label: string; value: unknown }): JSX.Element {
  return <div class={s.kpi}><dt>{label}</dt><dd>{v(value)}</dd></div>;
}

/** Строки разделов — карточками, а не таблицей: на 390 px без горизонтальной прокрутки. */
function Rows<T>({ items, render }: { items: T[]; render: (item: T) => { title: string; meta: Array<string | null | undefined> } }): JSX.Element {
  if (!items.length) return <p class={s.empty}>{t('bed.emptySection')}</p>;
  return (
    <ul class={s.bedRows}>
      {items.map((item, index) => {
        const row = render(item);
        return (
          <li key={index} class={s.bedRow}>
            <b>{row.title}</b>
            <span class={s.bedMeta}>{row.meta.filter((part): part is string => Boolean(part) && part !== '—').map((part, i) => <span key={i}>{part}</span>)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Body({ card, tab, canExtend, onExtend }: { card: BedolagaCard; tab: BedTab; canExtend: boolean; onExtend: (sub: BedolagaSubscription) => void }): JSX.Element {
  const user = card.user;
  switch (tab) {
    case 'overview': {
      const promo = user.promoGroup;
      return (
        <>
          <dl class={s.kpis}>
            <Kpi label={t('bed.status')} value={bedStatus(user.status)} />
            <Kpi label={t('bed.language')} value={user.language} />
            <Kpi label={t('bed.registered')} value={longDate(user.createdAt)} />
            <Kpi label={t('bed.lastActivity')} value={longDate(user.lastActivity)} />
            <Kpi label={t('bed.paidBefore')} value={user.hasHadPaidSubscription ? t('bed.yesWas') : t('bed.noWas')} />
            <Kpi label={t('bed.firstTopup')} value={user.hasMadeFirstTopup ? t('bed.yes') : t('bed.no')} />
            <Kpi label={t('bed.refCode')} value={user.referralCode} />
            <Kpi label={t('bed.invitedBy')} value={user.referredById ? `#${user.referredById}` : '—'} />
          </dl>
          {promo && (
            <>
              <h3 class={s.subhead}>{t('bed.promo')}</h3>
              <dl class={s.kpis}>
                <Kpi label={t('bed.promoName')} value={promo.name} />
                <Kpi label={t('bed.discountServer')} value={pct(promo.serverDiscountPercent)} />
                <Kpi label={t('bed.discountTraffic')} value={pct(promo.trafficDiscountPercent)} />
                <Kpi label={t('bed.discountDevices')} value={pct(promo.deviceDiscountPercent)} />
              </dl>
            </>
          )}
        </>
      );
    }
    case 'subscriptions': {
      const items = card.subscriptions.items;
      if (!items.length) return <p class={s.empty}>{t('bed.noSubscriptions')}</p>;
      return (
        <ul class={s.bedRows}>
          {items.map((sub) => {
            const state = extensions.state(sub.id);
            return (
              <li key={sub.id} class={s.bedRow}>
                <b>{t('bed.subTitle', { id: sub.id, status: bedStatus(sub.actualStatus ?? sub.status) })}</b>
                <span class={s.bedMeta}>
                  <span>{sub.isTrial ? t('bed.trial') : t('bed.regular')}</span>
                  <span>{t('bed.until', { date: longDate(sub.endDate) })}</span>
                  <span>{t('bed.trafficGb', { used: v(sub.trafficUsedGb), total: v(sub.trafficLimitGb) })}</span>
                  <span>{t('bed.deviceLimit', { n: v(sub.deviceLimit) })}</span>
                  <span>{sub.autopayEnabled ? t('bed.autopayOn') : t('bed.autopayOff')}</span>
                  <span>{sub.hasAccessLink ? t('bed.linkIssued') : t('bed.noLink')}</span>
                </span>
                {canExtend && (
                  <Button variant="secondary" size="sm" disabled={state !== 'idle'} onClick={() => onExtend(sub)}>
                    {state === 'pending' ? t('extend.running') : state === 'uncertain' ? t('extend.checkFirst') : t('extend.button')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      );
    }
    case 'transactions':
      return <Rows items={card.transactions.items} render={(item) => ({
        title: `${rubles(item.amountRubles)} · ${v(item.description ?? item.type)}`,
        meta: [`#${item.id}`, item.paymentMethod, item.isCompleted ? t('bed.payDone') : t('bed.payNotDone'), longDate(item.completedAt ?? item.createdAt)],
      })} />;
    case 'tickets':
      return <Rows items={card.tickets.items} render={(item) => ({
        title: `#${item.id} · ${v(item.title)}`,
        meta: [bedStatus(item.status), item.priority, item.messageCount !== undefined ? t('bed.messages', { n: item.messageCount }) : null,
          t('bed.created', { date: longDate(item.createdAt) }), item.closedAt ? t('bed.closed', { date: longDate(item.closedAt) }) : null],
      })} />;
    case 'referrals':
      return (
        <>
          <dl class={s.kpis}>
            <Kpi label={t('bed.invited')} value={card.referrals.invitedCount} />
            <Kpi label={t('bed.activeRefs')} value={card.referrals.activeReferrals} />
            <Kpi label={t('bed.earned')} value={rubles(card.referrals.totalEarnedRubles)} />
            <Kpi label={t('bed.monthEarned')} value={rubles(card.referrals.monthEarnedRubles)} />
            <Kpi label={t('bed.commission')} value={pct(card.referrals.commissionPercent)} />
          </dl>
          <Rows items={card.referrals.items} render={(item) => ({
            title: `${v(item.fullName ?? (item.username ? `@${item.username}` : `#${item.id}`))}`,
            meta: [bedStatus(item.status), t('bed.balanceShort', { sum: rubles(item.balanceRubles) }), t('bed.earnedShort', { sum: rubles(item.totalEarnedRubles) }),
              item.topupsCount !== undefined ? t('bed.topups', { n: item.topupsCount }) : null, longDate(item.lastActivity)],
          })} />
        </>
      );
    case 'activity':
      return <Rows items={card.activity.items} render={(item) => ({
        title: bedEvent(item.eventType),
        meta: [item.subscriptionId ? t('bed.refSub', { id: item.subscriptionId }) : null, item.transactionId ? t('bed.refPay', { id: item.transactionId }) : null,
          item.ticketId ? t('bed.refTicket', { id: item.ticketId }) : null, item.amountRubles !== undefined ? rubles(item.amountRubles) : null,
          longDate(item.occurredAt ?? item.createdAt)],
      })} />;
    case 'gifts': {
      const view = giftsView(card.gifts);
      if (view.unavailable !== undefined) return <p class={s.empty}>{view.unavailable ?? t('bed.giftsUnavailable')}</p>;
      return <Rows items={card.gifts.items} render={(item) => ({
        title: `#${item.id} · ${v(item.notificationType)}`,
        meta: [item.subscriptionId ? t('bed.refSub', { id: item.subscriptionId }) : null, item.effectType, item.discountPercent != null ? pct(item.discountPercent) : null,
          item.bonusAmountRubles != null ? rubles(item.bonusAmountRubles) : null, item.expiresAt ? t('bed.expires', { date: longDate(item.expiresAt) }) : null,
          item.isActive ? t('bed.giftActive') : item.claimedAt ? t('bed.giftClaimed') : t('bed.giftInactive')],
      })} />;
    }
  }
}

/** «Подробно в Bedolaga» — семь вкладок, как в классике (6.4, прил. А.I). */
export function BedolagaSheet({ open, onClose, card, canExtend, onExtend, initialTab = 'overview' }: {
  open: boolean; onClose: () => void; card: BedolagaCard | null; canExtend: boolean; onExtend: (sub: BedolagaSubscription) => void; initialTab?: BedTab;
}): JSX.Element {
  const [tab, setTab] = useState<BedTab>(initialTab);
  extensions.tick.value;
  let body: ComponentChildren = null;
  if (card) {
    const user = card.user;
    const display = user.fullName || (user.username ? `@${user.username}` : `#${user.id}`);
    body = (
      <div class={s.bed}>
        <div class={s.bedSummary}>
          <div>
            <b>{display}</b>
            <p class={s.meta}>{[user.username ? `@${user.username}` : null, t('bed.idLine', { id: user.id }), user.email].filter(Boolean).join(' · ')}</p>
          </div>
          <div class={s.bedBalance}><b class="num">{rubles(user.balanceRubles)}</b><span>{t('bed.balance')}</span></div>
        </div>
        {(card.warnings ?? []).map((warning) => <p key={warning} class={s.warn} role="status">{warning}</p>)}
        <div class={s.tabsScroll}>
          <Tabs<BedTab> label={t('bed.tabs')} value={tab} onChange={setTab} items={tabsOf(card)} />
        </div>
        <div role="tabpanel" aria-label={tabsOf(card).find((item) => item.value === tab)?.label}>
          <Body card={card} tab={tab} canExtend={canExtend} onExtend={onExtend} />
        </div>
        <p class={s.meta}>{t('bed.loadedAt', { time: clock(card.loadedAt) })}</p>
      </div>
    );
  }
  return <Sheet open={open} onClose={onClose} title={t('bed.title')} size="wide">{body}</Sheet>;
}
