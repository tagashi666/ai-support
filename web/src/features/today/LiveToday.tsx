import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ActivityItem, ActivityResponse, InboxItem } from '@shared/api-types';
import { RevertLine } from '@/features/assistant/AssistantScreen';
import { PauseControls, pauseText } from '@/features/assistant/PauseControls';
import { WrongSheet } from '@/features/assistant/WrongSheet';
import { t, tn } from '@/i18n/ru';
import { clock, fullDate, listTime } from '@/lib/format/format';
import { awaySince, LAST_VISIT_KEY, MODE_DOES, MODE_LABEL, verdictLines } from '@/lib/assistant/model';
import { aiMode, can, loadActivity, markedWrong, pause } from '@/lib/assistant/store';
import { getJson, readToken } from '@/lib/live/api';
import { liveChannel, liveName, livePreview, liveReasonView } from '@/lib/live/labels';
import { bootstrap, connection, liveCounts, liveItems, loading, syncedAt } from '@/lib/live/store';
import { isDesktop } from '@/lib/media';
import { navigate } from '@/lib/router';
import { now } from '@/lib/store/state';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Icon } from '@/ui/Icon';
import { Row } from '@/ui/Row';
import s from './today.module.css';

const DAY_MS = 24 * 60 * 60_000;

function greeting(at: number, name: string): string {
  const hour = new Date(at).getHours();
  const key = hour < 5 ? 'today.night' : hour < 12 ? 'today.morning' : hour < 18 ? 'today.day' : hour < 23 ? 'today.evening' : 'today.night';
  return t(key, { name });
}

/** Время прошлого визита — на устройстве (6.1); при уходе со страницы обновляется. */
function readLastVisit(): number | null {
  try { const value = Number(localStorage.getItem(LAST_VISIT_KEY)); return value > 0 ? value : null; } catch { return null; }
}
function writeLastVisit(): void {
  try { localStorage.setItem(LAST_VISIT_KEY, String(Date.now())); } catch { /* без хранилища блока «Пока вас не было» нет */ }
}
const visitAtLoad = readLastVisit();
if (typeof document !== 'undefined') {
  writeLastVisit();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') writeLastVisit(); });
}

function WaitingRow({ item }: { item: InboxItem }): JSX.Element {
  const at = now.value;
  const reason = liveReasonView(item, at);
  const preview = livePreview(item);
  const name = liveName(item);
  return (
    <Row id={String(item.id)} wrapped avatar={<Avatar name={name} channel={liveChannel(item)} />} title={name}
      time={listTime(item.activity_at, at)} who={preview.who} preview={preview.text} reason={reason.text} tone={reason.tone}
      unread={item.unread > 0} onOpen={() => navigate({ name: 'chats', id: String(item.id) })} />
  );
}

/**
 * «Сегодня» на живых данных (6.1): одна-две фразы и карточки — кому
 * ответить, что было без вас, что делает помощник, что требует внимания,
 * всё ли работает. compact — сводка справа от списка, пока диалог не выбран.
 */
export function LiveToday({ compact = false }: { compact?: boolean }): JSX.Element {
  const at = now.value;
  const boot = bootstrap.value;
  const counts = liveCounts.value;
  const waitingItems = liveItems.value.filter((item) => item.section === 'mine');
  const waiting = counts?.sections.mine ?? waitingItems.length;
  const aiCount = counts?.sections.ai ?? 0;
  const stats = can('stats:read');
  const [day, setDay] = useState<ActivityResponse | null>(null);
  const [dayState, setDayState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [away, setAway] = useState<ActivityResponse | null>(null);
  const [health, setHealth] = useState<'ok' | 'error' | null>(null);
  const [wrongFor, setWrongFor] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const awayFrom = compact ? null : awaySince(visitAtLoad, Date.now());

  useEffect(() => {
    if (!stats) return;
    let alive = true;
    setDayState('loading');
    void loadActivity(Date.now() - DAY_MS, { limit: 20 })
      .then((res) => { if (alive) { setDay(res); setDayState('ready'); } })
      .catch(() => { if (alive) setDayState('error'); });
    if (awayFrom !== null) void loadActivity(awayFrom, { limit: 1 }).then((res) => { if (alive) setAway(res); }).catch(() => undefined);
    return () => { alive = false; };
  }, [stats, tick]);
  useEffect(() => {
    void getJson<{ ok: boolean }>('/api/health', readToken() ?? '').then((res) => setHealth(res.ok ? 'ok' : 'error')).catch(() => setHealth('error'));
  }, []);

  const paused = pause.value;
  const quiet = !liveItems.value.some((item) => at - item.activity_at < DAY_MS);
  const lines = verdictLines({ waiting, ai: aiCount, paused: paused ? pauseText(paused.until, at) : null, quiet });
  const Heading = compact ? 'h2' : 'h1';
  const mode = aiMode.value;
  const lastAi: ActivityItem | undefined = day?.items.find((item) => item.kind === 'auto') ?? day?.items[0];
  const linked = connection.value === 'live' || connection.value === 'connecting';
  const ideas = boot?.counts.ideas ?? null;
  const update = boot?.update?.available ? boot.update.latest : null;

  const waitingCard = waiting > 0 && (
    <Card class={s.card} label={t('today.waitingCard')}>
      <h2 class={s.cardTitle}>{t('today.waitingCard')} <span class={`${s.count} num`}>{waiting}</span></h2>
      <div class={s.rows}>{waitingItems.slice(0, 5).map((item) => <WaitingRow key={item.id} item={item} />)}</div>
      <Button variant="link" size="sm" class={s.more} onClick={() => navigate({ name: 'chats', id: null })}>
        {t('today.allChats')} <Icon name="right" size={16} />
      </Button>
    </Card>
  );

  const touched = awayFrom !== null ? liveItems.value.filter((item) => item.activity_at > awayFrom).length : 0;
  const awayCard = awayFrom !== null && touched > 0 && (
    <Card class={s.card} label={t('today.away')}>
      <h2 class={s.cardTitle}>{t('today.away')} <span class={s.cardMeta}>{t('today.awaySince', { time: clock(awayFrom) })}</span></h2>
      <p class={s.text}>
        {t('today.awayLive', { n: touched, dialogs: tn('plural.dialogs', touched) })}
        {away && ` · ${t('today.awayAi', { auto: away.totals.auto, handoffs: away.totals.handoffs })}`}
      </p>
      {waitingItems[0] && (
        <div class={s.actions}>
          <Button variant="secondary" size="sm" onClick={() => navigate({ name: 'chats', id: String(waitingItems[0]!.id) })}>{t('today.openFirst')}</Button>
        </div>
      )}
    </Card>
  );

  const assistantCard = !can('settings:read') ? (
    <p class={s.system}><Icon name="spark" size={18} /><span>{t('today.assistantLine', { mode: t(MODE_LABEL[mode]) })}</span></p>
  ) : (
    <Card class={`${s.card} ${s.ai}`} label={t('today.assistant')}>
      <h2 class={s.cardTitle}>{t('today.assistant')}</h2>
      <p class={s.mode}>
        <Icon name={paused ? 'pause' : 'spark'} size={18} />
        {paused ? t('pause.state', { until: pauseText(paused.until, at) }) : t(MODE_LABEL[mode])}
      </p>
      <p class={s.text}>{paused ? t('today.modePausedHint') : t(MODE_DOES[mode])}</p>
      <div class={s.actions}>
        <PauseControls menu />
        <Button variant="quiet" size="sm" onClick={() => navigate({ name: 'section', key: 'assistant' })}>
          {t('today.change')} <Icon name="right" size={16} />
        </Button>
      </div>
      {stats && dayState === 'error' && (
        <p class={s.small} role="alert">{t('today.blockFailed')} <Button variant="link" size="sm" onClick={() => setTick(tick + 1)}>{t('live.retry')}</Button></p>
      )}
      {stats && day && (
        <p class={s.small}>{t('today.dayStatsLive', { auto: day.totals.auto, drafts: day.totals.drafts, sent: day.totals.draftsSent, handoffs: day.totals.handoffs })}</p>
      )}
      {!compact && lastAi && (
        <>
          <p class={s.small}>{t('today.lastAction', { name: lastAi.name, time: clock(lastAi.at) })}</p>
          {lastAi.text && <blockquote class={s.quote}>{lastAi.text}</blockquote>}
          <div class={s.actions}>
            <Button variant="quiet" size="sm" onClick={() => navigate({ name: 'section', key: 'assistant', sub: 'activity' })}>{t('today.look')}</Button>
            {lastAi.kind === 'auto' && lastAi.message_id !== null && can('conversation:reply') && !lastAi.wrong && !markedWrong.value.has(lastAi.message_id) && (
              <Button variant="quiet" size="sm" aria-haspopup="dialog" onClick={() => setWrongFor(lastAi.message_id)}>{t('today.wrong')}</Button>
            )}
          </div>
        </>
      )}
    </Card>
  );

  const attention = [
    ideas ? { key: 'ideas', text: t('today.ideasLive', { n: ideas }), action: t('today.ideasAction'), href: '/?ui=classic#v=kb' } : null,
    update ? { key: 'update', text: t('today.versionLive', { version: update }), action: t('today.versionAction'), href: '/?ui=classic#v=diagnostics' } : null,
  ].filter((item): item is { key: string; text: string; action: string; href: string } => item !== null);
  const attentionCard = attention.length > 0 && (
    <Card class={s.card} label={t('today.attention')}>
      <h2 class={s.cardTitle}>{t('today.attention')} <span class={`${s.cardMeta} num`}>{attention.length}</span></h2>
      <ul class={s.list}>
        {attention.map((item) => (
          <li key={item.key} class={s.item}><span class={s.itemText}>{item.text}</span><a class={s.link} href={item.href}>{item.action}</a></li>
        ))}
      </ul>
    </Card>
  );

  const systemOk = health !== 'error' && linked;
  const system = (
    <p class={s.system}>
      <span class={systemOk ? s.okDot : s.warnDot} aria-hidden="true" />
      <span><strong>{t('today.system')}:</strong> {systemOk ? t('today.systemOk')
        : linked ? t('today.systemCheck') : t('today.systemOffline', { time: syncedAt.value ? clock(syncedAt.value) : '—' })}</span>
    </p>
  );

  return (
    <div class={s.screen} data-compact={compact ? 'true' : 'false'}>
      <div class={s.inner}>
        <header class={s.head}>
          <div class={s.headRow}>
            <Heading class={s.greeting}>{greeting(at, boot?.me.name ?? '')}</Heading>
            {(isDesktop.value || compact) && <span class={s.date}>{fullDate(at)}</span>}
          </div>
          {loading.value === 'loading' && !counts
            ? <div class={s.skeletonLine} aria-hidden="true" />
            : <p class={s.verdict}>{lines.join(' ')}</p>}
        </header>
        {!compact && <RevertLine />}
        <div class={s.grid}>
          <div class={s.col}>
            {waitingCard}
            {awayCard}
            {compact ? null : attentionCard}
          </div>
          <div class={s.col}>
            {assistantCard}
            {compact && attentionCard}
            {system}
          </div>
        </div>
      </div>
      <WrongSheet messageId={wrongFor} onClose={() => setWrongFor(null)} />
    </div>
  );
}
