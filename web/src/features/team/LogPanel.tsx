import type { JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { tr } from '@/i18n/sections/team';
import { clock, dayMonth, sameDay } from '@/lib/format/format';
import { actorsOf, AUDIT_GROUPS, describeEvents, filterLines, GROUP_LABEL, type AuditGroup } from '@/lib/team/model';
import { auditError, auditEvents, auditState, loadAudit, operators, loadPeople } from '@/lib/team/store';
import { Button } from '@/ui/Button';
import { BlockState } from './BlockState';
import k from './team.module.css';

const PAGE = 50;

const when = (ms: number, now: number): string => (sameDay(ms, now) ? clock(ms) : `${dayMonth(ms)}, ${clock(ms)}`);

/** «Журнал»: человеческие строки, фильтры «кто» и «что», сырой код и тело — в «Как есть». */
export function LogPanel(): JSX.Element {
  const [who, setWho] = useState('');
  const [group, setGroup] = useState<AuditGroup | ''>('');
  const [shown, setShown] = useState(PAGE);
  useEffect(() => { void loadAudit(); if (!operators.peek()) void loadPeople(false); }, []);
  const people = operators.value;
  const lines = useMemo(() => describeEvents(auditEvents.value ?? [], {
    operatorName: (key) => people?.find((person) => `op:${person.id}` === key)?.name,
  }), [auditEvents.value, people]);
  const actors = useMemo(() => actorsOf(lines), [lines]);
  const filtered = filterLines(lines, { who, group });
  const visible = filtered.slice(0, shown);
  const now = Date.now();
  const reset = (): void => { setWho(''); setGroup(''); setShown(PAGE); };
  return (
    <div class={k.panel}>
      <BlockState state={auditState.value} error={auditError.value} onRetry={() => void loadAudit()}>
        {lines.length === 0 ? <p class={k.muted}>{tr('team.log.empty')}</p> : (
          <>
            <div class={k.filters}>
              <div class={k.field}>
                <label class={k.label} for="log-who">{tr('team.log.who')}</label>
                <select id="log-who" class={k.input} value={who} onChange={(event) => { setWho((event.currentTarget as HTMLSelectElement).value); setShown(PAGE); }}>
                  <option value="">{tr('team.log.anyone')}</option>
                  {actors.map((actor) => <option key={actor.key} value={actor.key}>{actor.name}</option>)}
                </select>
              </div>
              <div class={k.field}>
                <label class={k.label} for="log-what">{tr('team.log.what')}</label>
                <select id="log-what" class={k.input} value={group} onChange={(event) => { setGroup((event.currentTarget as HTMLSelectElement).value as AuditGroup | ''); setShown(PAGE); }}>
                  <option value="">{tr('team.log.anything')}</option>
                  {AUDIT_GROUPS.map((value) => <option key={value} value={value}>{tr(GROUP_LABEL[value])}</option>)}
                </select>
              </div>
            </div>
            {filtered.length === 0 ? (
              <div class={k.empty}>
                <p class={k.muted}>{tr('team.log.emptyFiltered')}</p>
                <Button variant="secondary" onClick={reset}>{tr('team.log.clear')}</Button>
              </div>
            ) : (
              <ul class={k.logList} aria-label={tr('team.log.list')}>
                {visible.map((line) => (
                  <li key={line.id} class={k.logItem}>
                    <div class={k.logMain}>
                      <span class={k.logText}><span class={k.logWho}>{line.who}</span> {line.text}</span>
                      <span class={`${k.logTime} num`}>{when(line.at, now)}</span>
                    </div>
                    <details class={k.raw}>
                      <summary>{tr('team.log.raw')}</summary>
                      <dl class={k.rawBody}>
                        <dt>{tr('team.log.rawAction')}</dt>
                        <dd>{line.action}</dd>
                        <dt>{tr('team.log.rawSection')}</dt>
                        <dd>{line.section}</dd>
                        <dt>{tr('team.log.rawBody')}</dt>
                        <dd>{line.body ? <pre>{line.body}</pre> : line.bodyBroken ? tr('team.log.rawBroken') : tr('team.log.rawNone')}</dd>
                      </dl>
                    </details>
                  </li>
                ))}
              </ul>
            )}
            {filtered.length > visible.length && (
              <div class={k.actions}>
                <p class={k.hint}>{tr('team.log.shown', { shown: visible.length, total: filtered.length })}</p>
                <Button variant="secondary" onClick={() => setShown(shown + PAGE)}>{tr('team.log.more')}</Button>
              </div>
            )}
          </>
        )}
      </BlockState>
    </div>
  );
}
