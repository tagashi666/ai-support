import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ActivityItem, ActivityResponse, InboxItem } from '@shared/api-types';
import { RevertLine } from '@/features/assistant/AssistantScreen';
import { PauseControls, pauseText } from '@/features/assistant/PauseControls';
import { WrongSheet } from '@/features/assistant/WrongSheet';
import { t, tn } from '@/i18n/ru';
import { clock, fullDate, listTime } from '@/lib/format/format';
import { awaySince, LAST_VISIT_KEY, MODE_DOES, MODE_LABEL } from '@/lib/assistant/model';
import { aiMode, can, loadActivity, markedWrong, pause } from '@/lib/assistant/store';
import { getJson, readToken } from '@/lib/live/api';
import { liveChannel, liveName, livePreview, liveReasonView } from '@/lib/live/labels';
import { bootstrap, connection, liveCounts, liveItems, loading, syncedAt } from '@/lib/live/store';
import { href, navigate, type Route } from '@/lib/router';
import { now } from '@/lib/store/state';
import { problems, problemTarget, problemText } from '@/lib/system/problems';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Icon } from '@/ui/Icon';
import { Row } from '@/ui/Row';
import { lazyScreen } from '@/app/lazy';
import { onboardingWanted } from '@/lib/onboarding';
import s from './today.module.css';

// Первый запуск (6.13) — отдельный чанк: нужен один раз, в начальный JS не входит.
const TodayOnboarding = lazyScreen(() => import('@/features/onboarding/Onboarding').then((module) => module.TodayOnboarding), () => <span />);

const IDEAS: Route = { name: 'section', key: 'knowledge', sub: 'ideas' };
const UPDATE: Route = { name: 'section', key: 'system', sub: 'update' };
const systemRoute = (sub?: string): Route => (sub ? { name: 'section', key: 'system', sub } : { name: 'section', key: 'system' });

const DAY_MS = 24 * 60 * 60_000;

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

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** Число с подписью: состояние — фактами, без прозы (R2 B). */
function Metric({ label, value, tone }: { label: string; value: number | null; tone?: 'attention' }): JSX.Element {
  return (
    <div class={s.metric} data-tone={tone && value ? tone : undefined}>
      <dt class={s.metricLabel}>{label}</dt>
      <dd class={`${s.metricValue} num`}>{value ?? '—'}</dd>
    </div>
  );
}

/**
 * «Сегодня» на живых данных (6.1, R2): заголовок с датой, ряд чисел и
 * карточки — кому ответить, что было без вас, что делает помощник, что
 * требует внимания, всё ли работает.
 */
export function LiveToday(): JSX.Element {
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
  const awayFrom = awaySince(visitAtLoad, Date.now());

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
  const issues = problems.value;
  const firstIssue = issues[0] ?? null;
  // Пока не пришли bootstrap и счётчики, карточки не знают, будут ли они (J-6): место держат заглушки той же раскладки.
  const pending = loading.value === 'loading' && (!counts || !boot);
  const mode = aiMode.value;
  const lastAi: ActivityItem | undefined = day?.items.find((item) => item.kind === 'auto') ?? day?.items[0];
  const linked = connection.value === 'live' || connection.value === 'connecting';
  const ideas = boot?.counts.ideas ?? null;
  const update = boot?.update?.available ? boot.update.latest : null;

  const waitingCard = waiting > 0 && (
    <Card class={`${s.card} ${s.wide}`} label={t('today.waitingCard')}>
      <h2 class={s.cardTitle}>{t('today.waitingCard')}</h2>
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
      {stats && dayState === 'loading' && <div class={s.lastSkeleton} aria-hidden="true" />}
      {lastAi && (
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

  // Неполадки первыми (6.1, этап 6), затем идеи и новая версия — всё ведёт в новую панель.
  const attention = [
    ...issues.map((issue) => {
      const route = systemRoute(problemTarget(issue));
      return { key: `problem-${issue.code}`, text: problemText(issue), action: t('problem.more'), href: href(route), route };
    }),
    ideas ? { key: 'ideas', text: t('today.ideasLive', { n: ideas }), action: t('today.ideasAction'), href: href(IDEAS), route: IDEAS } : null,
    update ? { key: 'update', text: t('today.versionLive', { version: update }), action: t('today.versionAction'), href: href(UPDATE), route: UPDATE } : null,
  ].filter((item): item is { key: string; text: string; action: string; href: string; route: Route } => item !== null);
  const attentionCard = attention.length > 0 && (
    <Card class={s.card} label={t('today.attention')}>
      <h2 class={s.cardTitle}>{t('today.attention')} <span class={`${s.cardMeta} num`}>{attention.length}</span></h2>
      <ul class={s.list}>
        {attention.map((item) => (
          <li key={item.key} class={s.item}><span class={s.itemText}>{item.text}</span><a class={s.link} href={item.href} onClick={(event) => {
            if (!item.route || event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            navigate(item.route);
          }}>{item.action}</a></li>
        ))}
      </ul>
    </Card>
  );

  const systemOk = health !== 'error' && linked && firstIssue === null;
  const system = (
    <p class={s.system}>
      <span class={systemOk ? s.okDot : s.warnDot} aria-hidden="true" />
      <span><strong>{t('today.system')}:</strong> {systemOk ? t('today.systemOk')
        : !linked ? t('today.systemOffline', { time: syncedAt.value ? clock(syncedAt.value) : '—' })
          : firstIssue ? lowerFirst(problemText(firstIssue)) : t('today.systemCheck')}
      {linked && firstIssue && can('diagnostics:read') && (
        <> · <a class={s.link} href={href(systemRoute(problemTarget(firstIssue)))} onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          navigate(systemRoute(problemTarget(firstIssue)));
        }}>{t('problem.more')}</a></>
      )}</span>
    </p>
  );

  return (
    <div class={s.screen}>
      <div class={s.inner}>
        <header class={s.head}>
          <h1 class={s.title}>{t('nav.today')}</h1>
          <span class={s.date}>{fullDate(at)}</span>
        </header>
        {/* До bootstrap неизвестно, сколько чисел и карточек будет: ниже заголовка — пусто, а не
            заглушки другой раскладки, которые потом сдвинутся (CLS, R2 D). Появляется целиком. */}
        {boot && (
          <div class={s.body}>
            {onboardingWanted(boot?.me) && <TodayOnboarding dialogs={liveItems.value.length} />}
            <RevertLine />
            {/* Числа держат место и до ответа сервера (J-6): «—», а не появление со сдвигом. */}
            <dl class={s.metrics}>
              <Metric label={t('today.metric.waiting')} value={pending ? null : waiting} tone="attention" />
              <Metric label={t('today.metric.ai')} value={pending ? null : aiCount} />
              {stats && <Metric label={t('today.metric.auto')} value={day ? day.totals.auto : null} />}
              {stats && <Metric label={t('today.metric.drafts')} value={day ? day.totals.drafts : null} />}
              {stats && <Metric label={t('today.metric.handoffs')} value={day ? day.totals.handoffs : null} />}
            </dl>
            <div class={s.grid}>
              {pending ? <div class={`${s.cardSkeleton} ${s.wide}`} data-tall="true" aria-busy="true" aria-label={t('live.loading')} /> : waitingCard}
              {pending ? <div class={s.cardSkeleton} aria-busy="true" aria-label={t('live.loading')} /> : assistantCard}
              {!pending && attentionCard}
              {!pending && awayCard}
            </div>
            {/* Строка «Система» — только с готовыми карточками: под заглушками её сдвигало бы (CLS, R2 D). */}
            {!pending && system}
          </div>
        )}
      </div>
      <WrongSheet messageId={wrongFor} onClose={() => setWrongFor(null)} />
    </div>
  );
}
