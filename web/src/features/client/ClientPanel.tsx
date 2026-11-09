import type { JSX } from 'preact';
import { t, tn } from '@/i18n/ru';
import { dayMonth, monthYear } from '@/lib/format/format';
import { channelLabel } from '@/lib/labels';
import { now } from '@/lib/store/state';
import type { Chat } from '@/lib/types';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import s from './client.module.css';

const DAY = 24 * 60 * 60_000;

/** «Клиент» — минимум для прототипа: подписка, трафик, устройства (полностью — этап 3б). */
export function ClientPanel({ chat, onClose, embedded = false }: { chat: Chat; onClose?: () => void; embedded?: boolean }): JSX.Element {
  const info = chat.client;
  const days = Math.max(0, Math.round((info.subscriptionUntil - now.value) / DAY));
  const percent = Math.round((info.trafficUsed / Math.max(1, info.trafficTotal)) * 100);
  return (
    <div class={s.panel} data-embedded={embedded ? 'true' : 'false'}>
      {!embedded && (
        <header class={s.head}>
          <h2 class={s.title}>{t('client.title')}</h2>
          {onClose && <Button variant="quiet" size="sm" icon="close" label={t('sheet.close')} onClick={onClose} />}
        </header>
      )}
      <div class={s.who}>
        <Avatar name={chat.name} size="l" />
        <div>
          <p class={s.name}>{chat.name}</p>
          <p class={s.meta}>{channelLabel(chat.channel)} · {t('client.since', { when: monthYear(info.since) })}</p>
        </div>
      </div>
      <dl class={s.facts}>
        <div class={s.fact}>
          <dt>{t('client.subscription')}</dt>
          <dd>
            <span class={s.okDot} aria-hidden="true" />
            {t('client.until', { date: dayMonth(info.subscriptionUntil) })}
            <span class={s.factSub}>{t('client.daysLeft', { n: days, days: tn('plural.days', days) })}</span>
          </dd>
        </div>
        <div class={s.fact}>
          <dt>{t('client.traffic')}</dt>
          <dd>
            {t('client.trafficValue', { used: info.trafficUsed, total: info.trafficTotal })}
            <span class={s.meter} aria-hidden="true"><span class={s.meterFill} data-p={String(Math.min(100, Math.round(percent / 10) * 10))} /></span>
          </dd>
        </div>
        <div class={s.fact}>
          <dt>{t('client.devices')}</dt>
          <dd>{t('client.devicesValue', { used: info.devicesUsed, total: info.devicesTotal })}</dd>
        </div>
        <div class={s.fact}><dt>{t('client.server')}</dt><dd>{info.server}</dd></div>
        <div class={s.fact}><dt>{t('client.balance')}</dt><dd class="num">{info.balance}</dd></div>
      </dl>
      <p class={s.later}>{t('client.later')}</p>
    </div>
  );
}
