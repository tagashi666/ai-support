import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ActivityItem, ActivityResponse } from '@shared/api-types';
import { t, type Key } from '@/i18n/ru';
import { clock, dayMonth, sameDay } from '@/lib/format/format';
import { filterActivity, KIND_LABEL, periodSince, REASON_LABEL, type ActivityFilter, type Period } from '@/lib/assistant/model';
import { can, loadActivity, markedWrong } from '@/lib/assistant/store';
import { navigate } from '@/lib/router';
import { Button } from '@/ui/Button';
import { Tabs } from '@/ui/Tabs';
import { WrongSheet } from './WrongSheet';
import a from './assistant.module.css';

/** Причины «Не подходит» (WorkDraft) — те же подписи. */
const REJECT: Record<string, Key> = {
  wrong_fact: 'reject.wrongFact', tone: 'reject.tone', off_topic: 'reject.offTopic', not_in_kb: 'reject.notInKb', not_needed: 'reject.notNeeded',
};

/** Что под строкой: ответ помощника, причина передачи или отказа. */
function detail(item: ActivityItem): string | null {
  if (item.kind === 'draft_rejected' && item.reject_reason) {
    const key = REJECT[item.reject_reason];
    return t('activity.rejectReason', { reason: key ? t(key) : item.reject_reason });
  }
  if (item.text) return `«${item.text}»`;
  return item.reason ? t(REASON_LABEL[item.reason]) : null;
}

export function ActivityRow({ item, onWrong }: { item: ActivityItem; onWrong: (messageId: number) => void }): JSX.Element {
  const now = Date.now();
  const when = sameDay(item.at, now) ? clock(item.at) : `${dayMonth(item.at)}, ${clock(item.at)}`;
  const wrong = item.wrong || (item.message_id !== null && markedWrong.value.has(item.message_id));
  const reason = item.text && item.reason ? t(REASON_LABEL[item.reason]) : null;
  return (
    <li class={a.activityRow} data-kind={item.kind}>
      <span class={`${a.activityTime} num`}>{when}</span>
      <span class={a.activityMain}>
        <span><strong>{item.name}</strong> · {t(KIND_LABEL[item.kind])}{reason ? ` · ${reason}` : ''}</span>
        {detail(item) && <span class={a.activityText}>{detail(item)}</span>}
      </span>
      <span class={a.activityActions}>
        <Button variant="quiet" size="sm" onClick={() => navigate({ name: 'chats', id: String(item.conversation_id) })}>{t('activity.open')}</Button>
        {item.kind === 'auto' && item.message_id !== null && can('conversation:reply') && (
          wrong
            ? <span class={a.muted}>{t('activity.markedWrong')}</span>
            : <Button variant="quiet" size="sm" aria-haspopup="dialog" onClick={() => onWrong(item.message_id!)}>{t('today.wrong')}</Button>
        )}
      </span>
    </li>
  );
}

/** «Что делал помощник» (6.7): лента за период, фильтр и итоги словами. */
export function ActivityPanel(): JSX.Element {
  const [period, setPeriod] = useState<Period>('today');
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [wrongFor, setWrongFor] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setState('loading');
    void loadActivity(periodSince(period, Date.now()), { limit: 100 })
      .then((res) => { if (alive) { setData(res); setState('ready'); } })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [period, tick]);

  const more = async (): Promise<void> => {
    if (!data?.next) return;
    try {
      const page = await loadActivity(data.since, { before: data.next, limit: 100 });
      setData({ ...page, items: [...data.items, ...page.items] });
    } catch { setState('error'); }
  };

  const items = data ? filterActivity(data.items, filter) : [];
  const totals = data?.totals;
  return (
    <div class={a.panel}>
      <div class={a.activityBar}>
        <div class={a.tabsScroll}>
          <Tabs<Period> label={t('activity.period')} value={period} onChange={setPeriod}
            items={[{ value: 'today', label: t('activity.today') }, { value: 'week', label: t('activity.week') }, { value: 'month', label: t('activity.month') }]} />
        </div>
        <div class={a.filters} role="radiogroup" aria-label={t('activity.show')}>
          {(['all', 'auto', 'handoff'] as const).map((value) => (
            <label key={value} class={a.filter} data-checked={filter === value ? 'true' : 'false'}>
              <input type="radio" name="activity-filter" checked={filter === value} onChange={() => setFilter(value)} />
              {t(value === 'all' ? 'activity.all' : value === 'auto' ? 'activity.onlyAuto' : 'activity.onlyHandoff')}
            </label>
          ))}
        </div>
      </div>
      {state === 'loading' && !data && <div class={a.skeleton} key="skeleton" aria-hidden="true" />}
      {state === 'error' && (
        <p class={a.error} role="alert">{t('activity.failed')} <Button variant="link" size="sm" onClick={() => setTick(tick + 1)}>{t('live.retry')}</Button></p>
      )}
      {data && items.length === 0 && <p class={a.muted}>{t('activity.empty')}</p>}
      {items.length > 0 && (
        <ul class={a.activity} aria-label={t('activity.title')}>
          {items.map((item) => <ActivityRow key={item.id} item={item} onWrong={setWrongFor} />)}
        </ul>
      )}
      {data?.next && <Button variant="secondary" size="sm" onClick={() => void more()}>{t('activity.more')}</Button>}
      {totals && (
        <p class={a.totals}>
          {t(period === 'today' ? 'activity.totalsToday' : period === 'week' ? 'activity.totalsWeek' : 'activity.totalsMonth', {
            auto: totals.auto, drafts: totals.drafts, sent: totals.draftsSent, edited: totals.draftsEdited,
            rejected: totals.draftsRejected, handoffs: totals.handoffs,
          })}
        </p>
      )}
      <WrongSheet messageId={wrongFor} onClose={() => setWrongFor(null)} />
    </div>
  );
}
