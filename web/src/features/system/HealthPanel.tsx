import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { tr } from '@/i18n/sections/system';
import { showToast } from '@/lib/actions/toasts';
import { clock } from '@/lib/format/format';
import { bootstrap, connection } from '@/lib/live/store';
import { navigate } from '@/lib/router';
import {
  buildChecks, countRows, overrideRows, updateHeadline, verdictOf, verdictTarget, type Check, type Diagnostics, type Tone,
} from '@/lib/system/model';
import { problems } from '@/lib/system/problems';
import {
  checkedAt, connections, diag, health, loadHealth, nodes, notifications, rights, sendTestAlert, update,
} from '@/lib/system/store';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Icon } from '@/ui/Icon';
import s from './system.module.css';

function toneWord(tone: Tone): string {
  return tone === 'ok' ? tr('system.tone.ok') : tone === 'warn' ? tr('system.tone.warn') : tone === 'error' ? tr('system.tone.error') : tr('system.tone.off');
}

function Dot({ tone }: { tone: Tone }): JSX.Element {
  return <span class={s.dot} data-tone={tone} aria-hidden="true" />;
}

function goTo(link: NonNullable<Check['link']>): void {
  navigate({ name: 'section', key: 'system', sub: link }, false);
}

function CheckRow({ check, open, onToggle }: { check: Check; open: boolean; onToggle: () => void }): JSX.Element {
  const [testing, setTesting] = useState(false);
  const runTest = async (): Promise<void> => {
    setTesting(true);
    const res = await sendTestAlert();
    setTesting(false);
    showToast(res.ok ? { text: tr('system.notify.testOk') } : { text: tr('system.notify.testFailed', { reason: res.reason }), kind: 'error', ttl: null });
  };
  return (
    <li class={s.check}>
      <button type="button" class={s.checkBtn} aria-expanded={open} onClick={onToggle}>
        <Dot tone={check.tone} />
        <span class={s.checkTitle}>{check.title}<span class="visually-hidden">{`: ${toneWord(check.tone)}`}</span></span>
        <span class={s.checkSummary}>{check.summary}</span>
        <Icon name="right" size={18} class={s.chev} />
      </button>
      {open && (
        <div class={s.checkBody}>
          {check.details.length > 0 && (
            <dl class={s.kv}>
              {check.details.map((row) => (<><dt>{row.label}</dt><dd>{row.value}</dd></>))}
            </dl>
          )}
          <div class={s.actions}>
            {check.link === 'servers' && <Button variant="secondary" size="sm" onClick={() => goTo('servers')}>{tr('system.check.openServers')}</Button>}
            {check.link === 'update' && <Button variant="secondary" size="sm" onClick={() => goTo('update')}>{tr('system.check.openUpdate')}</Button>}
            {check.link === 'notifications' && <Button variant="secondary" size="sm" onClick={() => goTo('notifications')}>{tr('system.check.openNotifications')}</Button>}
            {check.test && <Button variant="secondary" size="sm" disabled={testing} onClick={() => void runTest()}>{tr('system.notify.test')}</Button>}
          </div>
        </div>
      )}
    </li>
  );
}

function Specialists({ d }: { d: Diagnostics }): JSX.Element {
  const [open, setOpen] = useState(false);
  const conn = connections.value;
  const h = health.value;
  const overrides = overrideRows(d.settingOverrides);
  return (
    <div class={s.disclosure}>
      <button type="button" class={s.disclosureBtn} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="right" size={18} class={s.chev} />{tr('system.pro.title')}
      </button>
      {open && (
        <div class={s.disclosureBody}>
          <section aria-label={tr('system.pro.overrides')}>
            <h3 class={s.subhead}>{tr('system.pro.overrides')}</h3>
            {overrides.length === 0 ? <p class={s.muted}>{tr('system.pro.overridesNone')}</p> : (
              <dl class={s.kv}>
                {overrides.map((row) => (<><dt>{row.label}<span class={s.raw}>{row.key}</span></dt><dd>{row.value}</dd></>))}
              </dl>
            )}
          </section>
          <section aria-label={tr('system.pro.cursors')}>
            <h3 class={s.subhead}>{tr('system.pro.cursors')}</h3>
            <dl class={s.kv}>
              <dt>{tr('system.check.bedolaga')}</dt><dd>{d.cursors.bedolaga ?? tr('system.poll.none')}</dd>
              <dt>{tr('system.check.minishop')}</dt><dd>{d.cursors.minishop ?? tr('system.poll.none')}</dd>
            </dl>
          </section>
          <section aria-label={tr('system.pro.counts')}>
            <h3 class={s.subhead}>{tr('system.pro.counts')}</h3>
            <dl class={s.kv}>
              {countRows(d.database.counts).map((row) => (<><dt>{row.label}<span class={s.raw}>{row.key}</span></dt><dd>{row.value}</dd></>))}
            </dl>
          </section>
          <section aria-label={tr('system.pro.channels')}>
            <h3 class={s.subhead}>{tr('system.pro.channels')}</h3>
            <dl class={s.kv}>
              <dt>{tr('system.pro.business')}</dt><dd>{h ? (h.businessConnection ? tr('system.yes') : tr('system.no')) : tr('system.unknown')}</dd>
              <dt>{tr('system.pro.rwAccess')}</dt>
              <dd>{conn && conn.remnawave.length > 0
                ? conn.remnawave.map((p) => `${p.name}: ${p.readOnly ? tr('system.rw.readOnly') : tr('system.rw.write')}`).join('; ')
                : tr('system.unknown')}</dd>
            </dl>
          </section>
        </div>
      )}
    </div>
  );
}

function UpdateGlance(): JSX.Element | null {
  const u = update.value;
  if (!rights.value.update || u.state !== 'ready') return null;
  return (
    <Card class={s.verdict} label={tr('system.tab.update')}>
      <h2 class={s.cardHead}>{tr('system.tab.update')}</h2>
      <p class={s.muted}>{updateHeadline(u.data)}</p>
      <div class={s.actions}><Button variant="secondary" size="sm" onClick={() => goTo('update')}>{u.data.available ? tr('system.update.open') : tr('system.update.openHistory')}</Button></div>
    </Card>
  );
}

/** «Здоровье» (6.9): вердикт, проверки, обновление, «Для специалистов». */
export function HealthPanel(): JSX.Element {
  const online = connection.value !== 'offline';
  const ready = bootstrap.value !== null;
  // undefined — ещё не трогали: открыта строка неполадки (вместо второй кнопки «Подробнее» в вердикте, R-28).
  const [picked, setOpenId] = useState<string | null | undefined>(undefined);
  useEffect(() => { if (ready && online) void loadHealth(); }, [ready, online]);
  const d = diag.value;
  const stale = d.state === 'ready' && !online;

  if (!online && d.state !== 'ready') {
    return <div class={s.panel}><p class={s.muted} role="status">{tr('system.offline')}</p></div>;
  }
  if (d.state === 'idle' || d.state === 'loading') {
    return <div class={s.panel} aria-busy="true"><div class={s.skeleton} key="skeleton" aria-hidden="true" /><p class="visually-hidden" role="status">{tr('system.checking')}</p></div>;
  }
  if (d.state === 'error') {
    return (
      <div class={s.panel}>
        <p class={s.error} role="alert">{tr('system.cannotCheckReason', { reason: d.message })}</p>
        <div class={s.actions}><Button variant="secondary" onClick={() => void loadHealth()}>{tr('system.retry')}</Button></div>
      </div>
    );
  }
  const checks = buildChecks({
    diag: d.data, health: health.value, nodes: rights.value.servers ? nodes.value : undefined, notifications: notifications.value,
    connections: connections.value,
    problems: problems.value, aiKeys: bootstrap.value?.assistant.keys ?? bootstrap.value?.capabilities.aiKeys ?? null,
    canTest: rights.value.alerts, now: Date.now(),
  });
  const verdict = verdictOf(checks);
  const target = verdictTarget(checks);
  const tone: Tone = verdict.level === 'ok' ? 'ok' : verdict.level === 'check' ? 'warn' : 'error';
  const openId = picked !== undefined ? picked : target && verdict.level !== 'ok' ? checks.find((check) => check.link === target)?.id ?? null : null;
  const at = checkedAt.value;
  return (
    <div class={s.panel}>
      <Card class={s.verdict} label={tr('system.verdict.label')}>
        <div class={s.verdictLine}>
          <h2 class={s.verdictTitle} role="status"><Dot tone={tone} />{verdict.title}</h2>
          <div class={s.verdictMeta}>
            {at !== null && <span>{tr('system.checkedAt', { time: clock(at) })}</span>}
            <Button variant="secondary" size="sm" onClick={() => void loadHealth()}>{tr('system.checkNow')}</Button>
          </div>
        </div>
        <p class={s.verdictText}>{verdict.text}</p>
        {stale && <p class={s.hint}>{tr('system.offlineStale')}</p>}
      </Card>
      <div class={s.cols}>
        <Card label={tr('system.checked')}>
          <h2 class={s.cardHead}>{tr('system.checked')}</h2>
          <ul class={s.checks}>
            {checks.map((check) => (
              <CheckRow key={check.id} check={check} open={openId === check.id} onToggle={() => setOpenId(openId === check.id ? null : check.id)} />
            ))}
          </ul>
        </Card>
        <UpdateGlance />
      </div>
      <Specialists d={d.data} />
    </div>
  );
}
