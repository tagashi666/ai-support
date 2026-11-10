import type { JSX } from 'preact';
import { t, type Key } from '@/i18n/ru';
import { tr } from '@/i18n/sections/reports';
import { duration, listTime } from '@/lib/format/format';
import type { OperatorStat } from '@/lib/reports/model';
import { loadPeople, people } from '@/lib/reports/store';
import { Button } from '@/ui/Button';
import r from './reports.module.css';

const ROLE: Record<string, Key> = {
  root: 'nav.role.owner', admin: 'role.admin', lead: 'role.lead', agent: 'role.agent', viewer: 'role.viewer',
};
const roleName = (row: OperatorStat): string => t(ROLE[row.role] ?? ROLE[row.key] ?? 'role.unknown');
const median = (row: OperatorStat): string => (row.median_response_ms === null ? '—' : duration(row.median_response_ms));
const lastAt = (row: OperatorStat): string => (row.last_activity_at ? listTime(row.last_activity_at, Date.now()) : '—');

/** «По людям» (6.8): таблица на компьютере, карточки на телефоне. */
export function PeoplePanel(): JSX.Element {
  const res = people.value;
  const rows = res.data?.operators ?? [];
  return (
    <div class={r.panel}>
      {res.state === 'error' && (
        <p class={r.error} role="alert">
          {tr('reports.loadFailed', { reason: res.error })} <Button variant="link" size="sm" onClick={() => void loadPeople()}>{t('live.retry')}</Button>
        </p>
      )}
      {!res.data && res.state !== 'error' && <div class={r.skeleton} aria-hidden="true" />}
      {res.data && rows.length === 0 && <p class={r.muted}>{tr('reports.people.empty')}</p>}
      {rows.length > 0 && (
        <>
          <div class={r.wide}>
            <div class={r.tableWrap}>
              <table class={r.table}>
                <caption>{tr('reports.people.caption', { n: res.data?.days ?? 0 })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{tr('reports.people.name')}</th>
                    <th scope="col" class={r.num}>{tr('reports.people.handled')}</th>
                    <th scope="col" class={r.num}>{tr('reports.people.resolved')}</th>
                    <th scope="col" class={r.num}>{tr('reports.people.replies')}</th>
                    <th scope="col" class={r.num}>{tr('reports.people.median')}</th>
                    <th scope="col" class={r.num}>{tr('reports.people.now')}</th>
                    <th scope="col">{tr('reports.people.last')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">{row.name}<br /><span class={r.hint}>{roleName(row)}</span></th>
                      <td class={r.num}>{row.handled}</td>
                      <td class={r.num}>{row.resolved}</td>
                      <td class={r.num}>{row.replies}</td>
                      <td class={r.num}>{median(row)}</td>
                      <td class={r.num}>{row.active_assigned}</td>
                      <td>{lastAt(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <ul class={`${r.people} ${r.narrow}`} aria-label={tr('reports.people.list')} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {rows.map((row) => (
              <li key={row.key} class={r.person}>
                <span class={r.personName}>{row.name} <span class={r.hint}>{roleName(row)}</span></span>
                <span class={r.line}>{tr('reports.people.cardA', { handled: row.handled, resolved: row.resolved, replies: row.replies })}</span>
                <span class={r.line}>{tr('reports.people.cardB', { median: median(row), now: row.active_assigned })}</span>
                <span class={r.hint}>{tr('reports.people.cardC', { last: lastAt(row) })}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
