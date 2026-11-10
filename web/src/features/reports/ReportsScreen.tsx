import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { tr } from '@/i18n/sections/reports';
import { dayMonth } from '@/lib/format/format';
import { bootstrap } from '@/lib/live/store';
import { PERIODS } from '@/lib/reports/model';
import { loadPeople, loadQueue, loadSla, loadStats, people, period, resetStats, rights, setPeriod, stats } from '@/lib/reports/store';
import { navigate } from '@/lib/router';
import { Button } from '@/ui/Button';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import { Tabs } from '@/ui/Tabs';
import { PeoplePanel } from './PeoplePanel';
import { SlaPanel } from './SlaPanel';
import { SummaryPanel } from './SummaryPanel';
import r from './reports.module.css';

type Tab = 'summary' | 'people' | 'sla';
const SUB: Record<Tab, string | undefined> = { summary: undefined, people: 'people', sla: 'sla' };

function tabsFor(): Tab[] {
  const rt = rights.value;
  const tabs: Tab[] = [];
  if (rt.stats) tabs.push('summary');
  if (rt.stats && rt.people) tabs.push('people');
  if (rt.stats && rt.sla) tabs.push('sla');
  return tabs;
}

const TAB_LABEL = { summary: 'reports.tab.summary', people: 'reports.tab.people', sla: 'reports.tab.sla' } as const;

/** «⋯» с одним пунктом — «Сбросить статистику…» (stats:reset, ярус 2). */
function MoreMenu({ onReset }: { onReset: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (event: MouseEvent): void => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const esc = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div class={r.menuWrap} ref={box}>
      <Button variant="quiet" icon="more" label={tr('reports.more')} aria-haspopup="menu" aria-expanded={open ? 'true' : 'false'} onClick={() => setOpen(!open)} />
      {open && (
        <div class={r.menu} role="menu" aria-label={tr('reports.more')}>
          <button type="button" role="menuitem" class={r.menuItem} onClick={() => { setOpen(false); onReset(); }}>{tr('reports.reset.menu')}</button>
        </div>
      )}
    </div>
  );
}

/**
 * «Отчёты» (6.8): Сводка · По людям · Сроки ответа. Один период на все вкладки;
 * адреса /next/reports, /next/reports/people, /next/reports/sla.
 */
export function ReportsScreen({ sub }: { sub?: string; item?: string }): JSX.Element {
  const ready = bootstrap.value !== null;
  const tabs = tabsFor();
  const asked = (Object.keys(SUB) as Tab[]).find((tab) => SUB[tab] === sub) ?? 'summary';
  const tab: Tab | undefined = tabs.includes(asked) ? asked : tabs[0];
  const days = period.value;
  const [resetting, setResetting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');

  useEffect(() => { if (ready && tab === 'summary') void loadStats(days); }, [ready, tab, days]);
  useEffect(() => { if (ready && tab === 'people') void loadPeople(days); }, [ready, tab, days]);
  useEffect(() => {
    if (!ready || !rights.value.sla) return;
    if (tab === 'sla' || tab === 'summary') void loadQueue();
    if (tab === 'sla') void loadSla();
  }, [ready, tab]);

  const since = tab === 'people' ? people.value.data?.since : stats.value.data?.since;
  const doReset = async (): Promise<void> => {
    setBusy(true);
    const result = await resetStats();
    setBusy(false);
    if (result.ok) { setResetting(false); setFailed(''); } else setFailed(result.error);
  };

  return (
    <div class={r.screen}>
      <div class={r.inner}>
        <div class={r.head}>
          <h1 class={r.title}>{t('nav.reports')}</h1>
          {tab === 'summary' && rights.value.reset && <MoreMenu onReset={() => { setFailed(''); setResetting(true); }} />}
        </div>
        {!ready ? <div class={r.skeleton} aria-hidden="true" /> : tabs.length === 0 ? <p class={r.muted}>{tr('reports.noAccess')}</p> : (
          <>
            <div class={r.tabsScroll}>
              <Tabs<Tab> label={t('nav.reports')} value={tab ?? 'summary'}
                onChange={(next) => navigate({ name: 'section', key: 'reports', ...(SUB[next] ? { sub: SUB[next] } : {}) }, true)}
                items={tabs.map((value) => ({ value, label: tr(TAB_LABEL[value]) }))} />
            </div>
            <div class={r.toolbar}>
              <div class={r.filters} role="radiogroup" aria-label={tr('reports.period')}>
                {PERIODS.map((value) => (
                  <label key={value} class={r.filter} data-checked={days === value ? 'true' : 'false'}>
                    <input type="radio" name="reports-period" checked={days === value} onChange={() => setPeriod(value)} />
                    {tr('reports.periodDays', { n: value })}
                  </label>
                ))}
              </div>
              {since !== undefined && tab !== 'sla' && (
                <span class={r.since}>{tr('reports.since', { date: dayMonth(since) })}</span>
              )}
            </div>
            {tab === 'summary' && <SummaryPanel />}
            {tab === 'people' && <PeoplePanel />}
            {tab === 'sla' && <SlaPanel />}
          </>
        )}
      </div>
      <Sheet open={resetting} onClose={() => setResetting(false)} title={tr('reports.reset.title')}>
        <p class={sheetStyles.text}>{tr('reports.reset.text')}</p>
        {failed && <p class={r.error} role="alert">{tr('reports.reset.failed', { reason: failed })}</p>}
        <div class={sheetStyles.actions}>
          <Button variant="quiet" onClick={() => setResetting(false)}>{tr('reports.cancel')}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void doReset()}>{tr('reports.reset.confirm')}</Button>
        </div>
      </Sheet>
    </div>
  );
}
