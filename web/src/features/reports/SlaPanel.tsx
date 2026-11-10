import type { JSX } from 'preact';
import { Segmented } from '@/ui/Segmented';
import { useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { tr } from '@/i18n/sections/reports';
import {
  dialogName, dueText, filterQueue, minutesText, NO_QUEUE_FILTER, overdueCount, ownerText, parseMinutes, priorityName, PRIORITIES,
  type Priority, type QueueFilter, type QueueMode, type SlaPolicy,
} from '@/lib/reports/model';
import { loadQueue, loadSla, queue, rights, saveTarget, sla } from '@/lib/reports/store';
import { href, navigate } from '@/lib/router';
import { Button } from '@/ui/Button';
import { InlineField } from '@/ui/InlineField';
import r from './reports.module.css';

const MODES: { value: QueueMode; label: 'reports.mode.all' | 'reports.mode.overdue' | 'reports.mode.free' }[] = [
  { value: 'all', label: 'reports.mode.all' }, { value: 'overdue', label: 'reports.mode.overdue' }, { value: 'free', label: 'reports.mode.free' },
];

function TargetRow({ policy, manage }: { policy: SlaPolicy; manage: boolean }): JSX.Element {
  const name = priorityName(policy.priority);
  const save = (which: 'first' | 'resolution') => async (raw: string): Promise<void> => {
    const minutes = parseMinutes(raw);
    if (minutes === null) throw new Error(tr('reports.targets.invalid'));
    await saveTarget(
      policy.priority,
      which === 'first' ? minutes : policy.first_response_minutes,
      which === 'resolution' ? minutes : policy.resolution_minutes,
    );
  };
  return (
    <div class={r.target} role="group" aria-label={name}>
      <span class={r.targetName}>{name}</span>
      <div class={r.targetField}>
        <InlineField label={tr('reports.targets.first', { name })} type="number" min={1} max={10080} disabled={!manage}
          value={String(policy.first_response_minutes)} onSave={save('first')} />
        <span class={r.hint}>{tr('reports.targets.equals', { time: minutesText(policy.first_response_minutes) })}</span>
      </div>
      <div class={r.targetField}>
        <InlineField label={tr('reports.targets.resolution', { name })} type="number" min={1} max={10080} disabled={!manage}
          value={String(policy.resolution_minutes)} onSave={save('resolution')} />
        <span class={r.hint}>{tr('reports.targets.equals', { time: minutesText(policy.resolution_minutes) })}</span>
      </div>
    </div>
  );
}

/** «Сроки ответа» (6.8): цели по срочности и «Сейчас по срокам». */
export function SlaPanel(): JSX.Element {
  const [filter, setFilter] = useState<QueueFilter>(NO_QUEUE_FILTER);
  const goals = sla.value;
  const rows = queue.value;
  const policies = [...(goals.data?.policies ?? [])].sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority));
  const shown = rows.data ? filterQueue(rows.data.conversations, filter) : [];
  const now = Date.now();
  return (
    <div class={r.panel}>
      <section class={r.block} aria-label={tr('reports.targets.title')}>
        <h2 class={r.blockTitle}>{tr('reports.targets.title')}</h2>
        {goals.state === 'error' && (
          <p class={r.error} role="alert">
            {tr('reports.loadFailed', { reason: goals.error })} <Button variant="link" size="sm" onClick={() => void loadSla()}>{t('live.retry')}</Button>
          </p>
        )}
        {!goals.data && goals.state !== 'error' && <div class={r.skeleton} key="skeleton" aria-hidden="true" />}
        {policies.length > 0 && (
          <div class={r.targets}>
            {policies.map((policy) => <TargetRow key={policy.priority} policy={policy} manage={rights.value.manage} />)}
          </div>
        )}
        {!rights.value.manage && goals.data && <p class={r.hint}>{tr('reports.targets.readOnly')}</p>}
        <p class={r.hint}>{tr('reports.targets.calendar')} {tr('reports.targets.remind')}</p>
      </section>

      <section class={r.block} aria-label={tr('reports.now.title')}>
        <div class={r.blockHead}>
          <h2 class={r.blockTitle}>{tr('reports.now.title')}</h2>
          {rows.data && <span class={r.hint}>{tr('reports.now.counts', { all: rows.data.conversations.length, late: overdueCount(rows.data.conversations) })}</span>}
        </div>
        <div class={r.bar2}>
          <Segmented label={tr('reports.now.filter')} name="queue-mode" value={filter.mode} onChange={(mode) => setFilter({ ...filter, mode })}
            items={MODES.map((mode) => ({ value: mode.value, label: tr(mode.label) }))} />
          <label class={r.bar2}>
            <span class={r.hint}>{tr('reports.now.priority')}</span>
            <select class={r.select} value={filter.priority}
              onChange={(event) => setFilter({ ...filter, priority: (event.target as HTMLSelectElement).value as Priority | 'any' })}>
              <option value="any">{tr('reports.now.anyPriority')}</option>
              {PRIORITIES.map((value) => <option key={value} value={value}>{priorityName(value)}</option>)}
            </select>
          </label>
        </div>
        {rows.state === 'error' && (
          <p class={r.error} role="alert">
            {tr('reports.loadFailed', { reason: rows.error })} <Button variant="link" size="sm" onClick={() => void loadQueue()}>{t('live.retry')}</Button>
          </p>
        )}
        {!rows.data && rows.state !== 'error' && <div class={r.skeleton} key="skeleton" aria-hidden="true" />}
        {rows.data && shown.length === 0 && <p class={r.muted}>{rows.data.conversations.length === 0 ? tr('reports.now.empty') : tr('reports.now.nothing')}</p>}
        {shown.length > 0 && (
          <ul class={r.list} aria-label={tr('reports.now.title')}>
            {shown.map((row) => (
              <li key={row.id}>
                <a class={r.item} href={href({ name: 'chats', id: String(row.id) })}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                    event.preventDefault();
                    navigate({ name: 'chats', id: String(row.id) });
                  }}>
                  <span class={r.itemHead}>
                    <span class={r.itemName}>{dialogName(row)}</span>
                    <span class={row.overdue ? `${r.itemMeta} ${r.late}` : r.itemMeta}>{dueText(row, now)}</span>
                  </span>
                  <span class={r.itemMeta}>{ownerText(row)} · {priorityName(row.priority)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
