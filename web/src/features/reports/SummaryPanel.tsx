import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { tr } from '@/i18n/sections/reports';
import { dayMonth, plural } from '@/lib/format/format';
import { liveMine } from '@/lib/live/store';
import {
  assistantOwnShare, barHeights, channelName, dayStamp, draftsUnchanged, eventRows, fewData, fewDataNote, firstResponseLines, localHours,
  noData, overdueCount, purposeName, requestsOf, resolutionLine, resolvedLine, tokensOf, tokensText, type StatsResponse,
} from '@/lib/reports/model';
import { loadStats, queue, rights, stats } from '@/lib/reports/store';
import { href, navigate, type Route } from '@/lib/router';
import { saveFilter, type ListFilter } from '@/lib/workspace/filter';
import { Button } from '@/ui/Button';
import r from './reports.module.css';

/** Строка «Требуют внимания»: открывает «Диалоги» с нужным фильтром (6.8). */
function AttentionLink({ label, filter }: { label: string; filter: ListFilter }): JSX.Element {
  const to: Route = { name: 'chats', id: null };
  return (
    <a class={r.linkBtn} href={href(to)} onClick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      saveFilter(filter);
      navigate(to);
    }}>{label} ›</a>
  );
}

function Bars({ values, label }: { values: number[]; label: string }): JSX.Element {
  const heights = barHeights(values);
  return (
    <div class={r.bars} role="img" aria-label={label}>
      {heights.map((height, index) => (
        <span key={index} class={r.bar} data-zero={height === 0 ? 'true' : 'false'} style={height === 0 ? undefined : { transform: `scaleY(${height / 100})` }} />
      ))}
    </div>
  );
}

function Charts({ data }: { data: StatsResponse }): JSX.Element {
  const [table, setTable] = useState(false);
  const days = data.volume;
  const hours = localHours(data.hours);
  const nonEmptyHours = hours.filter((row) => row.n > 0);
  return (
    <section class={r.block} aria-label={tr('reports.charts')}>
      <div class={r.blockHead}>
        <h2 class={r.blockTitle}>{tr('reports.charts')}</h2>
        <Button variant="secondary" size="sm" onClick={() => setTable(!table)}>
          {table ? tr('reports.showBars') : tr('reports.showTable')}
        </Button>
      </div>
      {!table ? (
        <div class={r.charts}>
          <div class={r.panel}>
            <span class={r.cardTitle}>{tr('reports.byDay')}</span>
            <Bars values={days.map((row) => row.incoming)} label={tr('reports.byDay')} />
            {days.length > 1 && (
              <div class={r.axis} aria-hidden="true">
                <span>{dayMonth(dayStamp(days[0]!.day))}</span><span>{dayMonth(dayStamp(days[days.length - 1]!.day))}</span>
              </div>
            )}
          </div>
          <div class={r.panel}>
            <span class={r.cardTitle}>{tr('reports.byHour')}</span>
            <Bars values={hours.map((row) => row.n)} label={tr('reports.byHour')} />
            <div class={r.axis} aria-hidden="true"><span>0:00</span><span>12:00</span><span>23:00</span></div>
          </div>
        </div>
      ) : (
        <div class={r.charts}>
          <div class={r.tableWrap} tabIndex={0} role="region" aria-label={tr('reports.byDay')}>
            <table class={r.table}>
              <caption>{tr('reports.byDay')}</caption>
              <thead><tr><th scope="col">{tr('reports.col.day')}</th><th scope="col" class={r.num}>{tr('reports.col.incoming')}</th><th scope="col" class={r.num}>{tr('reports.col.outgoing')}</th></tr></thead>
              <tbody>
                {days.map((row) => (
                  <tr key={row.day}><td>{dayMonth(dayStamp(row.day))}</td><td class={r.num}>{row.incoming}</td><td class={r.num}>{row.outgoing}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div class={r.tableWrap} tabIndex={0} role="region" aria-label={tr('reports.byHour')}>
            <table class={r.table}>
              <caption>{tr('reports.byHour')}</caption>
              <thead><tr><th scope="col">{tr('reports.col.hour')}</th><th scope="col" class={r.num}>{tr('reports.col.incoming')}</th></tr></thead>
              <tbody>
                {nonEmptyHours.map((row) => (
                  <tr key={row.hour}><td>{`${row.hour}:00`}</td><td class={r.num}>{row.n}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function Cards({ data }: { data: StatsResponse }): JSX.Element {
  const few = fewData(data);
  const first = firstResponseLines(data);
  const resolution = resolutionLine(data);
  const own = assistantOwnShare(data);
  const drafts = draftsUnchanged(data.suggestions);
  const overdue = queue.value.data ? overdueCount(queue.value.data.conversations) : 0;
  const empty = noData(data);
  return (
    <div class={r.cards}>
      {!empty && (
        <section class={r.card} aria-label={tr('reports.card.first')}>
          <span class={r.cardTitle}>{tr('reports.card.first')}</span>
          {first ? (
            <>
              <span class={r.big}>{first.median}</span>
              {first.slowest && <span class={r.line}>{first.slowest}</span>}
            </>
          ) : <span class={r.line}>{tr('reports.noAnswers')}</span>}
          {few && <span class={r.few}>{fewDataNote()}</span>}
        </section>
      )}
      {!empty && (
        <section class={r.card} aria-label={tr('reports.card.resolved')}>
          <span class={r.cardTitle}>{tr('reports.card.resolved')}</span>
          <span class={r.big}>{resolvedLine(data)}</span>
          {resolution && <span class={r.line}>{resolution}</span>}
          {few && <span class={r.few}>{fewDataNote()}</span>}
        </section>
      )}
      <section class={r.card} aria-label={tr('reports.card.waiting')}>
        <span class={r.cardTitle}>{tr('reports.card.waiting')}</span>
        <span class={r.big}>{plural(data.totals.waiting, 'plural.dialogs')}</span>
        {rights.value.sla && overdue > 0 && (
          <a class={r.linkBtn} href={href({ name: 'section', key: 'reports', sub: 'sla' })} onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            navigate({ name: 'section', key: 'reports', sub: 'sla' });
          }}>{tr('reports.overdueLink', { n: overdue })} ›</a>
        )}
      </section>
      {!empty && (
        <section class={r.card} aria-label={tr('reports.card.assistant')}>
          <span class={r.cardTitle}>{tr('reports.card.assistant')}</span>
          <span class={r.big}>{own ? tr('reports.assistantOwn', { share: own }) : tr('reports.noOutgoing')}</span>
          <span class={r.line}>{drafts ? tr('reports.draftsClean', { share: drafts.share }) : tr('reports.noDrafts')}</span>
          {drafts && <span class={r.hint}>{tr('reports.draftsOf', { n: drafts.of })}</span>}
          {few && <span class={r.few}>{fewDataNote()}</span>}
        </section>
      )}
    </div>
  );
}

function Attention(): JSX.Element {
  const mine = liveMine.value;
  return (
    <section class={r.block} aria-label={tr('reports.attention')}>
      <h2 class={r.blockTitle}>{tr('reports.attention')}</h2>
      <div class={r.attention}>
        <AttentionLink label={tr('reports.att.mine', { n: mine })} filter={{}} />
        <AttentionLink label={tr('reports.att.handed')} filter={{ assignee: 'me' }} />
        <AttentionLink label={tr('reports.att.important')} filter={{ important: true }} />
        <AttentionLink label={tr('reports.att.notFound')} filter={{ notFound: true }} />
      </div>
    </section>
  );
}

function Lists({ data }: { data: StatsResponse }): JSX.Element {
  const week = data.aiUsage.week;
  const events = eventRows(data.events);
  const empty = noData(data);
  return (
    <div class={r.two}>
      {!empty && (
        <section class={r.block} aria-label={tr('reports.channels')}>
          <h2 class={r.blockTitle}>{tr('reports.channels')}</h2>
          {data.byChannel.length === 0 ? <p class={r.muted}>{tr('reports.nothing')}</p> : (
            <ul class={r.facts}>{data.byChannel.map((row) => <li key={row.channel}><span>{channelName(row.channel)}</span><span class="num">{row.n}</span></li>)}</ul>
          )}
        </section>
      )}
      {!empty && (
        <section class={r.block} aria-label={tr('reports.sources')}>
          <h2 class={r.blockTitle}>{tr('reports.sources')}</h2>
          {data.topSources.length === 0 ? <p class={r.muted}>{tr('reports.noSources')}</p> : (
            <ul class={r.facts}>{data.topSources.map((row) => <li key={row.title}><span>{`«${row.title}»`}</span><span class="num">{row.n}</span></li>)}</ul>
          )}
        </section>
      )}
      <section class={r.block} aria-label={tr('reports.usage')}>
        <h2 class={r.blockTitle}>{tr('reports.usage')}</h2>
        {week.length === 0 ? <p class={r.muted}>{tr('reports.noUsage')}</p> : (
          <>
            <p class={r.line}>{tr('reports.usageWeek', { tokens: tokensText(tokensOf(week)), n: requestsOf(week) })}</p>
            <ul class={r.facts}>{week.map((row) => <li key={row.purpose}><span>{purposeName(row.purpose)}</span><span class="num">{tokensText(row.prompt + row.completion)}</span></li>)}</ul>
            <p class={r.hint}>{tr('reports.usageToday', { tokens: tokensText(tokensOf(data.aiUsage.today)) })} · {tr('reports.usageFixed')}</p>
          </>
        )}
      </section>
      {!empty && (
        <section class={r.block} aria-label={tr('reports.events')}>
          <h2 class={r.blockTitle}>{tr('reports.events')}</h2>
          {events.length === 0 ? <p class={r.muted}>{tr('reports.nothing')}</p> : (
            <ul class={r.facts}>{events.map((row) => <li key={row.label}><span>{row.label}</span><span class="num">{row.n}</span></li>)}</ul>
          )}
        </section>
      )}
    </div>
  );
}

/** «Сводка» (6.8): карточки, графики, «Требуют внимания», откуда пишут, статьи, расход, события. */
export function SummaryPanel(): JSX.Element {
  const res = stats.value;
  const data = res.data;
  return (
    <div class={r.panel}>
      {res.state === 'error' && (
        <p class={r.error} role="alert">
          {tr('reports.loadFailed', { reason: res.error })} <Button variant="link" size="sm" onClick={() => void loadStats()}>{t('live.retry')}</Button>
        </p>
      )}
      {!data && res.state !== 'error' && <div class={r.skeleton} key="skeleton" aria-hidden="true" />}
      {data && (
        <>
          {noData(data) && <p class={`${r.muted} ${r.empty}`}>{tr('reports.noDialogs', { n: data.days })}</p>}
          <Cards data={data} />
          {!noData(data) && <Charts data={data} />}
          <Attention />
          <Lists data={data} />
        </>
      )}
      {!data && res.state === 'error' && <Attention />}
    </div>
  );
}
