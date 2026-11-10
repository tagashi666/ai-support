import type { JSX } from 'preact';
import { Collapse } from '@/ui/Collapse';
import { useEffect, useState } from 'preact/hooks';
import { tr } from '@/i18n/sections/system';
import {
  historyRows, isFinal, parseChangelog, statusWords, stepStates, updateHeadline, type UpdateInfo,
} from '@/lib/system/model';
import { loadUpdate, requestUpdate, update } from '@/lib/system/store';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Icon } from '@/ui/Icon';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import s from './system.module.css';

type Ask = 'update' | 'rollback' | 'reinstall' | null;

function Disclosure({ label, children }: { label: string; children: JSX.Element | JSX.Element[] | null }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div class={s.disclosure}>
      <button type="button" class={s.disclosureBtn} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="right" size={18} class={s.chev} />{label}
      </button>
      <Collapse open={open}><div class={s.disclosureBody}>{children}</div></Collapse>
    </div>
  );
}

function Changes({ items }: { items: string[] }): JSX.Element {
  return items.length === 0 ? <p class={s.muted}>{tr('system.update.noChanges')}</p> : <ul class={s.changes}>{items.map((item, i) => <li key={i}>{item}</li>)}</ul>;
}

function Progress({ info }: { info: UpdateInfo }): JSX.Element | null {
  const p = info.progress;
  if (!p) return null;
  const steps = stepStates(p);
  const version = p.version ?? info.latest ?? info.current;
  const result = p.status === 'completed'
    ? { tone: 'ok', text: p.action === 'rollback' ? tr('system.update.rolledBackDone', { version }) : tr('system.update.done', { version }) }
    : p.status === 'rolled_back' ? { tone: 'warn', text: p.action === 'rollback' ? tr('system.update.rolledBackDone', { version }) : tr('system.update.returned', { version: info.current }) }
    : p.status === 'failed' ? { tone: 'error', text: tr('system.update.failed') } : null;
  return (
    <Card class={s.verdict} label={tr('system.update.progress')}>
      <h2 class={s.cardHead}>{p.action === 'rollback' ? tr('system.update.progressRollback') : tr('system.update.progressUpdate', { version })}</h2>
      <ol class={s.steps}>
        {steps.map((step) => (
          <li key={step.id} class={s.step} data-state={step.state} aria-current={step.state === 'current' ? 'step' : undefined}>
            <span class={s.stepMark} aria-hidden="true">{step.state === 'done' ? '✓' : step.state === 'current' ? '●' : '○'}</span>
            {step.label}
          </li>
        ))}
      </ol>
      <p class={`${s.muted} num`} role="status">{result ? result.text : statusWords(p.status)}{typeof p.percent === 'number' && !result ? ` · ${p.percent}%` : ''}</p>
      {result && (
        <div class={s.result} data-tone={result.tone}>
          {p.detail && <p>{p.detail}</p>}
          {p.status === 'rolled_back' && p.action === 'update' && <p>{tr('system.update.returnedText')}</p>}
        </div>
      )}
    </Card>
  );
}

function Loaded({ info }: { info: UpdateInfo }): JSX.Element {
  const [ask, setAsk] = useState<Ask>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [watched, setWatched] = useState(false);
  const items = parseChangelog(info.changelog);
  const running = info.queued;
  useEffect(() => { if (running) setWatched(true); }, [running]);
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => { void loadUpdate(); }, 2000);
    return () => window.clearInterval(timer);
  }, [running]);
  const showProgress = Boolean(info.progress) && (running || (watched && isFinal(info.progress?.status)));
  const latest = info.latest ?? '';

  const confirm = async (action: 'update' | 'rollback', force = false): Promise<void> => {
    setBusy(true);
    const ok = await requestUpdate(action, force);
    setBusy(false);
    if (ok) { setWatched(true); setAsk(null); }
  };
  const check = async (): Promise<void> => { setChecking(true); await loadUpdate(true); setChecking(false); };

  if (!info.enabled) {
    return <div class={s.block}><p class={s.subhead}>{tr('system.update.offTitle')}</p><p class={s.muted}>{tr('system.update.offText')}</p></div>;
  }
  return (
    <div class={s.panel}>
      <Card class={s.verdict} label={tr('system.tab.update')}>
        <h2 class={s.verdictTitle}>{updateHeadline(info)}</h2>
        {info.error && <p class={s.error} role="alert">{tr('system.update.checkFailed', { reason: info.error })}</p>}
        <div class={s.actions}>
          {info.available && latest && <Button variant="primary" disabled={running} onClick={() => setAsk('update')}>{tr('system.update.button', { version: latest })}</Button>}
          <Button variant="secondary" disabled={checking || running} onClick={() => void check()}>{tr('system.update.checkNow')}</Button>
        </div>
        {info.available && <p class={s.hint}>{tr('system.update.safety', { current: info.current })}</p>}
        {info.available && items.length > 0 && (
          <Disclosure label={tr('system.update.whatsNew', { n: items.length })}><Changes items={items} /></Disclosure>
        )}
      </Card>
      {showProgress && <Progress info={info} />}
      <Disclosure label={tr('system.update.advanced')}>
        <p class={s.muted}>{tr('system.update.advancedText')}</p>
        <div class={s.actions}>
          {info.compatibility?.rollbackAvailable !== false && <Button variant="secondary" size="sm" disabled={running} onClick={() => setAsk('rollback')}>{tr('system.update.rollback')}</Button>}
          {info.reinstallable && <Button variant="secondary" size="sm" disabled={running} onClick={() => setAsk('reinstall')}>{tr('system.update.reinstall')}</Button>}
        </div>
      </Disclosure>
      <Disclosure label={tr('system.update.history')}>
        {(info.history ?? []).length === 0 ? <p class={s.muted}>{tr('system.update.historyEmpty')}</p> : (
          <ul class={s.history} aria-label={tr('system.update.history')}>
            {historyRows(info.history).map((row) => (
              <li key={row.id} class={s.historyRow}><span>{row.text}</span><span class={s.muted}>{`${row.status} · ${row.at}`}</span></li>
            ))}
          </ul>
        )}
      </Disclosure>

      <Sheet open={ask === 'update'} onClose={() => setAsk(null)} title={tr('system.update.sheetTitle', { version: latest })}>
        <p class={s.subhead}>{tr('system.update.sheetNew')}</p>
        <Changes items={items} />
        <p class={s.subhead}>{tr('system.update.sheetWhat')}</p>
        <ol class={s.changes}>
          <li>{tr('system.update.what1')}</li>
          <li>{tr('system.update.what2')}</li>
          <li>{tr('system.update.what3', { current: info.current })}</li>
        </ol>
        <p class={s.hint}>{tr('system.update.sheetNote')}</p>
        <div class={sheetStyles.actions}>
          <Button variant="quiet" onClick={() => setAsk(null)}>{tr('system.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void confirm('update')}>{tr('system.update.confirm', { version: latest })}</Button>
        </div>
      </Sheet>
      <Sheet open={ask === 'rollback'} onClose={() => setAsk(null)} title={tr('system.update.rollbackTitle')}>
        <p class={sheetStyles.text}>{tr('system.update.rollbackText', { current: info.current })}</p>
        <p class={s.hint}>{tr('system.update.rollbackNote')}</p>
        <div class={sheetStyles.actions}>
          <Button variant="quiet" onClick={() => setAsk(null)}>{tr('system.cancel')}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void confirm('rollback')}>{tr('system.update.rollbackConfirm')}</Button>
        </div>
      </Sheet>
      <Sheet open={ask === 'reinstall'} onClose={() => setAsk(null)} title={tr('system.update.reinstallTitle')}>
        <p class={sheetStyles.text}>{tr('system.update.reinstallText', { version: latest || info.current })}</p>
        <p class={s.hint}>{tr('system.update.reinstallNote')}</p>
        <div class={sheetStyles.actions}>
          <Button variant="quiet" onClick={() => setAsk(null)}>{tr('system.cancel')}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void confirm('update', true)}>{tr('system.update.reinstallConfirm')}</Button>
        </div>
      </Sheet>
    </div>
  );
}

/** «Обновление» (6.9): версия, что нового, ход шагами, откат и переустановка под «Расширенно». */
export function UpdatePanel(): JSX.Element {
  useEffect(() => { void loadUpdate(); }, []);
  const u = update.value;
  if (u.state === 'idle' || u.state === 'loading') return <div class={s.panel} aria-busy="true"><div class={s.skeleton} key="skeleton" aria-hidden="true" /></div>;
  if (u.state === 'error') {
    return (
      <div class={s.panel}>
        <p class={s.error} role="alert">{tr('system.update.loadFailed', { reason: u.message })}</p>
        <div class={s.actions}><Button variant="secondary" onClick={() => void loadUpdate()}>{tr('system.retry')}</Button></div>
      </div>
    );
  }
  return <Loaded info={u.data} />;
}
