import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { InboxItem } from '@shared/api-types';
import { t, tn } from '@/i18n/ru';
import { monthYear, roughDuration } from '@/lib/format/format';
import { channelLabel } from '@/lib/labels';
import { showToast } from '@/lib/actions/toasts';
import { ApiError, getJson, readToken, sendJson } from '@/lib/live/api';
import { liveChannel, liveName } from '@/lib/live/labels';
import { bootstrap } from '@/lib/live/store';
import { navigate } from '@/lib/router';
import { now } from '@/lib/store/state';
import { clientData, loadClient, refreshCustomer, reloadBedolaga, reloadProfile, reloadSubscription, saveProfile } from '@/lib/client/data';
import { extensions, validDays } from '@/lib/client/extend';
import type { BedolagaSubscription, ExplainResponse, ExtendResponse } from '@/lib/client/types';
import { DAY, daysUntil, gb, longDate, rubles, statusLabel, statusWords } from '@/lib/client/view';
import { drafts, draftTick, permissions, saveNote } from '@/lib/workspace/actions';
import { actionErrorText } from '@/lib/workspace/errors';
import { syncThread } from '@/lib/workspace/thread';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import { BedolagaSheet } from './BedolagaSheet';
import s from './client.module.css';

const FOLDS_KEY = 'next.clientFolds';
type Fold = 'notes' | 'other' | 'subscription' | 'bedolaga' | 'data' | 'sources';

function readFolds(): Partial<Record<Fold, boolean>> {
  try { return JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '{}') as Partial<Record<Fold, boolean>>; } catch { return {}; }
}

/** Секция со стрелкой; раскрытие запоминается на устройстве, как folds.js у классики. */
function Section({ id, title, count, children, folds, onFold }: {
  id: Fold; title: string; count?: number; children: ComponentChildren; folds: Partial<Record<Fold, boolean>>; onFold: (id: Fold, open: boolean) => void;
}): JSX.Element {
  const open = folds[id] ?? false;
  return (
    <details class={s.fold} open={open} onToggle={(event) => { const next = (event.currentTarget as HTMLDetailsElement).open; if (next !== open) onFold(id, next); }}>
      <summary class={s.foldHead}>{title}{count !== undefined && <span class="num"> ({count})</span>}</summary>
      <div class={s.foldBody}>{children}</div>
    </details>
  );
}

type Danger =
  | { kind: 'reset'; devices: number }
  | { kind: 'revoke' }
  | { kind: 'device'; hwid: string; label: string };

type SheetState =
  | null
  | { kind: 'danger'; action: Danger }
  | { kind: 'extend'; sub: BedolagaSubscription }
  | { kind: 'note' }
  | { kind: 'profile' }
  | { kind: 'explain'; data: ExplainResponse | null; error: boolean }
  | { kind: 'bedolaga' }
  | { kind: 'right'; right: string };

const SOURCE_DATA_AGED = 60 * 60_000;

/**
 * Панель «Клиент» (6.4): пять строк сути сверху, источник и свежесть, быстрые
 * действия, заметки, другие обращения, подписка и устройства, Bedolaga,
 * данные клиента, откуда данные, опасное — отдельно в «Действиях» (ярус 2).
 */
export function LiveClient({ id, item, onClose, inSheet = false }: { id: number; item: InboxItem; onClose?: () => void; inSheet?: boolean }): JSX.Element {
  const perms = permissions.value;
  const caps = bootstrap.value?.capabilities;
  const canView = perms.has('bedolaga:view');
  const data = clientData.value.get(id);
  const [folds, setFolds] = useState(readFolds);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [busy, setBusy] = useState(false);
  const at = now.value;
  extensions.tick.value;

  useEffect(() => {
    loadClient(id, { subscription: canView && Boolean(caps?.remnawave), bedolaga: canView && Boolean(caps?.bedolaga) });
  }, [id, canView, caps?.remnawave, caps?.bedolaga]);

  const onFold = (fold: Fold, open: boolean): void => {
    const next = { ...folds, [fold]: open };
    setFolds(next);
    try { localStorage.setItem(FOLDS_KEY, JSON.stringify(next)); } catch { /* без хранилища — до перезагрузки */ }
  };
  const close = (): void => setSheet(null);
  const fail = (err: unknown): void => {
    showToast({ text: t(actionErrorText(err instanceof ApiError ? err.code : 'unknown')), kind: 'error', ttl: null });
  };
  /** Без права — по нажатию лист «Нужно право …» (6.4: кнопка видна неактивной). */
  const needs = (permission: string, rightKey: Parameters<typeof t>[0], run: () => void) => () => {
    if (perms.has(permission)) run();
    else setSheet({ kind: 'right', right: t(rightKey) });
  };

  const customer = data?.customer.state === 'ready' ? data.customer.data.customer : null;
  const checkedAt = data?.customer.state === 'ready' ? data.customer.data.checkedAt ?? null : null;
  const profile = data?.profile.state === 'ready' ? data.profile.data : null;
  const sub = data?.subscription.state === 'ready' ? data.subscription.data : null;
  const bed = data?.bedolaga.state === 'ready' ? data.bedolaga.data : null;
  const canExtend = bed?.capabilities.canExtendSubscription === true;
  const name = liveName(item);
  const channel = liveChannel(item);

  const since = customer?.activity?.firstSeen ? Date.parse(customer.activity.firstSeen) : profile?.created_at ?? null;
  const related = (profile?.related ?? []).filter((entry) => entry.id !== id);
  const subscription = customer?.subscription;
  const left = daysUntil(subscription?.expiresAt, at);
  const status = statusWords(subscription?.status);
  const devicesUsed = sub?.devices?.length ?? subscription?.devices;
  const deviceLimit = sub?.profile?.deviceLimit ?? subscription?.deviceLimit;
  const balance = bed ? bed.customer.user.balanceRubles : customer?.balance?.amount;
  const subUrl = sub?.profile?.subscriptionUrl;
  const activeSubs = (bed?.customer.subscriptions.items ?? []);

  const refresh = async (): Promise<void> => {
    setBusy(true);
    try {
      await refreshCustomer(id);
      loadClient(id, { subscription: canView && Boolean(caps?.remnawave), bedolaga: canView && Boolean(caps?.bedolaga) });
      showToast({ text: t('client.refreshed') });
    } catch (err) { fail(err); } finally { setBusy(false); }
  };

  const toReply = (): void => {
    if (!subUrl) return;
    const current = drafts.get(id);
    const line = t('client.linkText', { url: subUrl });
    drafts.set(id, { text: current.text.trim() ? `${current.text}\n${line}` : line, mode: 'reply' });
    draftTick.value += 1;
    showToast({ text: t('client.linkInserted') });
    if (inSheet) onClose?.();
  };

  const copyLink = (): void => {
    if (!subUrl) return;
    void navigator.clipboard.writeText(subUrl).then(() => showToast({ text: t('toast.linkCopied') })).catch(() => showToast({ text: t('error.copy'), kind: 'error', ttl: null }));
  };

  const runDanger = async (action: Danger): Promise<void> => {
    close();
    const body = action.kind === 'reset' ? { action: 'reset-devices' } : action.kind === 'revoke' ? { action: 'revoke' } : { action: 'delete-device', hwid: action.hwid };
    try {
      await sendJson(`/api/conversations/${id}/subscription/action`, readToken() ?? '', body);
      showToast({ text: t(action.kind === 'reset' ? 'client.resetDone' : action.kind === 'revoke' ? 'client.revokeDone' : 'client.deviceDone') });
      void reloadSubscription(id);
      void syncThread(id);
    } catch (err) { fail(err); }
  };

  const startExtend = (target?: BedolagaSubscription): void => {
    const chosen = target ?? (activeSubs.length === 1 ? activeSubs[0] : undefined);
    if (!chosen) { setSheet({ kind: 'bedolaga' }); return; }
    setSheet({ kind: 'extend', sub: chosen });
  };

  const explain = async (): Promise<void> => {
    setSheet({ kind: 'explain', data: null, error: false });
    try {
      const result = await getJson<ExplainResponse>(`/api/conversations/${id}/subscription/explain`, readToken() ?? '');
      setSheet({ kind: 'explain', data: result, error: false });
    } catch { setSheet({ kind: 'explain', data: null, error: true }); }
  };

  const sources = customer?.sources ?? [];
  const freshness = checkedAt ? (at - checkedAt < 60_000 ? t('client.justNow') : t('client.ago', { ago: roughDuration(at - checkedAt) })) : null;
  const aged = checkedAt !== null && at - checkedAt > SOURCE_DATA_AGED;

  const notFound = data?.customer.state === 'ready' && customer && !customer.found;
  const loading = !data || data.customer.state === 'loading';

  return (
    <div class={s.pane} data-sheet={inSheet ? 'true' : 'false'}>
      {!inSheet && (
        <header class={s.head}>
          <h2 class={s.title}>{t('client.title')}</h2>
          {onClose && <Button variant="quiet" size="sm" icon="close" label={t('sheet.close')} onClick={onClose} />}
        </header>
      )}
      <div class={s.who}>
        <Avatar name={name} size="l" channel={channel} />
        <div>
          <p class={s.name}>{name}</p>
          <p class={s.meta}>
            {[channel ? channelLabel(channel) : null, item.customer.username ? `@${item.customer.username}` : null].filter(Boolean).join(' · ')}
          </p>
          <p class={s.meta}>
            {[since && Number.isFinite(since) ? t('client.since', { when: monthYear(since) }) : null,
              profile ? t('client.cases', { n: related.length + 1, cases: tn('plural.cases', related.length + 1) }) : null].filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>

      {loading && <div class={s.skeleton} aria-busy="true" aria-label={t('live.loading')} />}
      {data?.customer.state === 'error' && (
        <div class={s.notice} role="status">
          <p>{t('client.loadFailed')}</p>
          <Button variant="secondary" size="sm" onClick={() => loadClient(id, { subscription: canView && Boolean(caps?.remnawave), bedolaga: canView && Boolean(caps?.bedolaga) })}>{t('live.retry')}</Button>
        </div>
      )}
      {customer?.sourceFailed && (
        <div class={s.notice} role="status">
          <p><b>{t('client.notChecked')}</b> {t('client.notCheckedText')}</p>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void refresh(); }}>{t('live.retry')}</Button>
        </div>
      )}
      {notFound && !customer.sourceFailed && (
        <div class={s.notice} role="status">
          <p><b>{t('client.notFound')}</b></p>
          <p class={s.meta}>{t('client.notFoundText')}</p>
          <div class={s.actionsRow}>
            {(customer.trace?.length ?? 0) > 0 && <Button variant="quiet" size="sm" onClick={() => onFold('sources', true)}>{t('client.whatChecked')}</Button>}
            {perms.has('conversation:profile') && <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void refresh(); }}>{t('client.refresh')}</Button>}
          </div>
        </div>
      )}

      {customer?.found && canView && (
        <dl class={s.facts}>
          {subscription?.status !== undefined || subscription?.expiresAt ? (
            <div class={s.fact}>
              <dt>{t('client.subscription')}</dt>
              <dd>
                <span>{status === 'active' && <span class={s.okDot} aria-hidden="true" />}{statusLabel(subscription?.status)}
                  {subscription?.expiresAt ? ` ${t('client.until', { date: longDate(subscription.expiresAt) })}` : ''}</span>
                {left !== null && (
                  <span class={s.factSub}>{left >= 0 ? t('client.daysLeft', { n: left, days: tn('plural.days', left) }) : t('client.expiredAgo', { n: -left, days: tn('plural.days', -left) })}</span>
                )}
              </dd>
            </div>
          ) : null}
          {subscription?.trafficUsed !== undefined && (
            <div class={s.fact}>
              <dt>{t('client.traffic')}</dt>
              <dd>
                <span class="num">{subscription.trafficLimit ? t('client.trafficValue', { used: gb(subscription.trafficUsed), total: gb(subscription.trafficLimit) }) : t('client.trafficNoLimit', { used: gb(subscription.trafficUsed) })}</span>
                {subscription.trafficLimit ? (
                  <span class={s.meter} role="img" aria-label={t('client.trafficShare', { p: Math.round((subscription.trafficUsed / subscription.trafficLimit) * 100) })}>
                    <span class={s.meterFill} data-p={String(Math.min(100, Math.max(10, Math.round((subscription.trafficUsed / subscription.trafficLimit) * 10) * 10)))} />
                  </span>
                ) : null}
              </dd>
            </div>
          )}
          {devicesUsed !== undefined && (
            <div class={s.fact}><dt>{t('client.devices')}</dt><dd class="num">{deviceLimit ? t('client.devicesValue', { used: devicesUsed, total: deviceLimit }) : String(devicesUsed)}</dd></div>
          )}
          {customer.activity?.lastNode && (
            <div class={s.fact}>
              <dt>{t('client.server')}</dt>
              <dd><span>{customer.activity.lastNode}</span><span class={s.factSub}>{t('client.internalHint')}</span></dd>
            </div>
          )}
          {balance !== undefined && balance !== null && (
            <div class={s.fact}><dt>{t('client.balance')}</dt><dd class="num">{rubles(balance)}</dd></div>
          )}
        </dl>
      )}
      {customer?.found && (
        <p class={s.source} data-aged={aged ? 'true' : 'false'}>
          <span>{t('client.from', { sources: sources.join(t('client.and')) || '—' })}{freshness ? ` · ${freshness}` : ''}</span>
          {perms.has('conversation:profile') && (
            <Button variant="quiet" size="sm" icon="undo" label={t('client.refresh')} disabled={busy} onClick={() => { void refresh(); }} />
          )}
        </p>
      )}

      {(subUrl || canExtend) && (
        <div class={s.actionsRow}>
          {subUrl && perms.has('conversation:reply') && <Button variant="secondary" size="sm" onClick={toReply}>{t('client.linkToReply')}</Button>}
          {canExtend && <Button variant="secondary" size="sm" onClick={() => startExtend()}>{t('client.extend')}</Button>}
        </div>
      )}

      <Section id="notes" title={t('client.notes')} count={profile?.notes.length ?? 0} folds={folds} onFold={onFold}>
        {(profile?.notes ?? []).slice(0, 20).map((note) => (
          <p key={note.id} class={s.noteItem}>«{note.text}» <span class={s.meta}>— {note.author_name ?? t('client.staff')}, {longDate(note.created_at)}</span></p>
        ))}
        {profile && profile.notes.length === 0 && <p class={s.meta}>{t('client.noNotes')}</p>}
        <Button variant="secondary" size="sm" icon="plus" onClick={needs('conversation:notes', 'right.notes', () => setSheet({ kind: 'note' }))}>{t('client.addNote')}</Button>
      </Section>

      {related.length > 0 && (
        <Section id="other" title={t('client.otherCases')} count={related.length} folds={folds} onFold={onFold}>
          <ul class={s.links}>
            {related.slice(0, 8).map((entry) => (
              <li key={entry.id}>
                <button type="button" class={s.linkBtn} onClick={() => navigate({ name: 'chats', id: String(entry.id) })}>
                  {entry.display_name || (entry.username ? `@${entry.username}` : `#${entry.id}`)} · {longDate(entry.last_message_at)}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {canView && data?.subscription.state !== 'none' && (
        <Section id="subscription" title={t('client.subAndDevices')} folds={folds} onFold={onFold}>
          {data?.subscription.state === 'loading' && <div class={s.blockSkeleton} aria-busy="true" aria-label={t('live.loading')} />}
          {data?.subscription.state === 'error' && (
            <div class={s.notice}>
              <p>{data.subscription.status === 404 ? t('client.notInRemnawave') : t('client.remnawaveFailed')}</p>
              <div class={s.actionsRow}>
                {data.subscription.status === 404
                  ? <Button variant="quiet" size="sm" onClick={() => { void explain(); }}>{t('client.whyNotFound')}</Button>
                  : <Button variant="secondary" size="sm" onClick={() => { void reloadSubscription(id); }}>{t('live.retry')}</Button>}
              </div>
            </div>
          )}
          {sub && (
            <>
              <dl class={s.facts}>
                {sub.profile?.shortId && <div class={s.fact}><dt>{t('client.subCode')}</dt><dd class="num">{sub.profile.shortId}</dd></div>}
                {sub.profile?.trafficUsed !== undefined && (
                  <div class={s.fact}><dt>{t('client.traffic')}</dt><dd class="num">{sub.profile.trafficLimit ? t('client.trafficValue', { used: gb(sub.profile.trafficUsed), total: gb(sub.profile.trafficLimit) }) : t('client.trafficNoLimit', { used: gb(sub.profile.trafficUsed) })}</dd></div>
                )}
                {customer?.activity?.dailyAverageBytes !== undefined && (
                  <div class={s.fact}><dt>{t('client.daily')}</dt><dd class="num">{t('client.gb', { n: gb(customer.activity.dailyAverageBytes) })}</dd></div>
                )}
                {(customer?.activity?.topNodes?.length ?? 0) > 0 && (
                  <div class={s.fact}>
                    <dt>{t('client.topNodes')}</dt>
                    <dd>
                      {customer!.activity!.topNodes!.slice(0, 3).map((node) => <span key={node.name}>{node.name} · <span class="num">{t('client.gb', { n: gb(node.bytes) })}</span></span>)}
                      <span class={s.factSub}>{t('client.internalHint')}</span>
                    </dd>
                  </div>
                )}
              </dl>
              {subUrl && <Button variant="secondary" size="sm" onClick={copyLink}>{t('client.copyLink')}</Button>}
              {(sub.devices ?? []).length > 0 ? (
                <ul class={s.devices} aria-label={t('client.deviceList')}>
                  {(sub.devices ?? []).map((device) => {
                    const label = [device.platform, device.model].filter(Boolean).join(' · ') || device.hwid.slice(0, 10);
                    return (
                      <li key={device.hwid} class={s.device}>
                        <span>{label}</span>
                        {sub.capabilities.deleteDevice && (
                          <Button variant="quiet" size="sm" aria-disabled={perms.has('bedolaga:devices') ? undefined : 'true'}
                            onClick={needs('bedolaga:devices', 'right.devices', () => setSheet({ kind: 'danger', action: { kind: 'device', hwid: device.hwid, label } }))}>
                            {t('client.unlink')}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : <p class={s.meta}>{t('client.noDevices')}</p>}
            </>
          )}
        </Section>
      )}

      {canView && data?.bedolaga.state !== 'none' && (
        <Section id="bedolaga" title={t('client.bedolaga')} folds={folds} onFold={onFold}>
          {data?.bedolaga.state === 'loading' && <div class={s.blockSkeleton} aria-busy="true" aria-label={t('live.loading')} />}
          {data?.bedolaga.state === 'error' && (
            <div class={s.notice}>
              <p>{data.bedolaga.status === 404 ? t('client.notInBedolaga') : t('client.bedolagaFailed')}</p>
              {data.bedolaga.status !== 404 && <Button variant="secondary" size="sm" onClick={() => { void reloadBedolaga(id); }}>{t('live.retry')}</Button>}
            </div>
          )}
          {bed && (
            <>
              <p class={s.meta}>{t('client.bedolagaSummary', { subs: bed.customer.subscriptions.total, pays: bed.customer.transactions.total, tickets: bed.customer.tickets.total })}</p>
              <Button variant="secondary" size="sm" aria-haspopup="dialog" onClick={() => setSheet({ kind: 'bedolaga' })}>{t('client.bedolagaOpen')}</Button>
            </>
          )}
        </Section>
      )}

      <Section id="data" title={t('client.data')} folds={folds} onFold={onFold}>
        {profile ? (
          <dl class={s.facts}>
            <div class={s.fact}><dt>{t('client.name')}</dt><dd>{profile.display_name || '—'}</dd></div>
            <div class={s.fact}><dt>{t('client.company')}</dt><dd>{profile.company || '—'}</dd></div>
            <div class={s.fact}><dt>{t('client.email')}</dt><dd>{profile.email || '—'}</dd></div>
            <div class={s.fact}><dt>{t('client.phone')}</dt><dd>{profile.phone || '—'}</dd></div>
            <div class={s.fact}><dt>{t('client.tags')}</dt><dd>{profile.tags.length ? profile.tags.join(', ') : '—'}</dd></div>
            {since && Number.isFinite(since) && <div class={s.fact}><dt>{t('client.sinceLabel')}</dt><dd>{longDate(since)}</dd></div>}
          </dl>
        ) : <div class={s.blockSkeleton} aria-busy="true" aria-label={t('live.loading')} />}
        {profile && (
          <Button variant="secondary" size="sm" icon="edit" onClick={needs('conversation:profile', 'right.profile', () => setSheet({ kind: 'profile' }))}>{t('client.editData')}</Button>
        )}
      </Section>

      <Section id="sources" title={t('client.sources')} folds={folds} onFold={onFold}>
        <p class={s.meta}>{sources.length ? t('client.sourcesList', { sources: sources.join(', ') }) : t('client.noSources')}</p>
        {(customer?.trace ?? []).length > 0 && <ul class={s.trace}>{customer!.trace!.map((line, index) => <li key={index}>{line}</li>)}</ul>}
        {canView && caps?.remnawave && <Button variant="quiet" size="sm" onClick={() => { void explain(); }}>{t('client.checkLink')}</Button>}
      </Section>

      {canView && sub && (sub.capabilities.resetDevices || sub.capabilities.revoke) && (
        <section class={s.danger} aria-labelledby={`client-actions-${id}`}>
          <h3 class={s.subhead} id={`client-actions-${id}`}>{t('client.actions')}</h3>
          {sub.capabilities.resetDevices && (
            <Button variant="secondary" size="sm" aria-disabled={perms.has('bedolaga:devices') ? undefined : 'true'}
              onClick={needs('bedolaga:devices', 'right.devices', () => setSheet({ kind: 'danger', action: { kind: 'reset', devices: sub.devices?.length ?? 0 } }))}>
              {t('client.resetAll')}
            </Button>
          )}
          {sub.capabilities.revoke && (
            <Button variant="secondary" size="sm" aria-disabled={perms.has('bedolaga:devices') ? undefined : 'true'}
              onClick={needs('bedolaga:devices', 'right.devices', () => setSheet({ kind: 'danger', action: { kind: 'revoke' } }))}>
              {t('client.revoke')}
            </Button>
          )}
        </section>
      )}

      <DangerSheet state={sheet} name={name} onClose={close} onRun={(action) => { void runDanger(action); }} />
      {sheet?.kind === 'extend' && <ExtendSheet id={id} sub={sheet.sub} name={name} onClose={close} />}
      {sheet?.kind === 'note' && <NoteSheet id={id} onClose={close} />}
      {sheet?.kind === 'profile' && profile && <ProfileSheet id={id} profile={profile} onClose={close} />}
      <Sheet open={sheet?.kind === 'explain'} onClose={close} title={t('client.explainTitle')}>
        {sheet?.kind === 'explain' && (
          sheet.error ? <p class={sheetStyles.text}>{t('client.explainFailed')}</p>
            : !sheet.data ? <p class={sheetStyles.text}>{t('live.loading')}</p>
              : (
                <>
                  <ul class={s.trace}>{sheet.data.steps.map((step, index) => <li key={index}>{step}</li>)}</ul>
                  <p class={s.meta}>{t('client.indexSize', { n: sheet.data.indexSize })}</p>
                  {sheet.data.near.length > 0 && <><h3 class={s.subhead}>{t('client.near')}</h3><ul class={s.trace}>{sheet.data.near.map((line) => <li key={line}>{line}</li>)}</ul></>}
                </>
              )
        )}
      </Sheet>
      <BedolagaSheet open={sheet?.kind === 'bedolaga'} onClose={close} card={bed?.customer ?? null} canExtend={canExtend}
        onExtend={(target) => setSheet({ kind: 'extend', sub: target })} initialTab={canExtend && activeSubs.length > 1 ? 'subscriptions' : 'overview'} />
      <Sheet open={sheet?.kind === 'right'} onClose={close} title={t('rights.title')}>
        <p class={sheetStyles.text}>{sheet?.kind === 'right' ? t('client.needRight', { right: sheet.right }) : ''}</p>
        <div class={sheetStyles.actions}><Button variant="secondary" onClick={close} autoFocus>{t('sheet.close')}</Button></div>
      </Sheet>
    </div>
  );
}

/** Подтверждение второго яруса (7.6): вопрос с объектом, последствия, «Не надо» с фокусом, красная — только кнопка действия. */
function DangerSheet({ state, name, onClose, onRun }: { state: SheetState; name: string; onClose: () => void; onRun: (action: Danger) => void }): JSX.Element {
  const action = state?.kind === 'danger' ? state.action : null;
  const title = !action ? '' : action.kind === 'reset' ? t('client.resetTitle', { name })
    : action.kind === 'revoke' ? t('client.revokeTitle', { name }) : t('client.deviceTitle', { device: action.label });
  const text = !action ? '' : action.kind === 'reset' ? t('client.resetText', { n: action.devices })
    : action.kind === 'revoke' ? t('client.revokeText') : t('client.deviceText');
  const verb = !action ? '' : action.kind === 'reset' ? t('client.resetYes', { n: action.devices })
    : action.kind === 'revoke' ? t('client.revokeYes') : t('client.deviceYes');
  return (
    <Sheet open={action !== null} onClose={onClose} title={title}>
      <p class={sheetStyles.text}>{text}</p>
      <p class={sheetStyles.text}>{t('client.irreversible')}</p>
      <div class={sheetStyles.actions}>
        <Button variant="secondary" onClick={onClose} autoFocus>{t('sheet.cancel')}</Button>
        <Button variant="danger" onClick={() => action && onRun(action)}>{verb}</Button>
      </div>
    </Sheet>
  );
}

const uuid = (): string => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(c) / 4)))).toString(16)));

/** «Продлить подписку Анны на [30] дней? Новая дата: …» (6.4). */
function ExtendSheet({ id, sub, name, onClose }: { id: number; sub: BedolagaSubscription; name: string; onClose: () => void }): JSX.Element {
  const [days, setDays] = useState(30);
  const state = extensions.state(sub.id);
  const end = sub.endDate ? Date.parse(sub.endDate) : NaN;
  const base = Number.isFinite(end) && end > Date.now() ? end : Date.now();
  const ok = validDays(days);
  const run = async (): Promise<void> => {
    const outcome = await extensions.run(id, sub.id, days, {
      uuid,
      post: async (path, body) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { authorization: `Bearer ${readToken() ?? ''}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json().catch(() => ({ ok: false })) as ExtendResponse & { error?: string } };
      },
    });
    if (outcome.kind === 'blocked') return;
    onClose();
    if (outcome.kind === 'done') showToast({ text: outcome.warning ?? t('extend.done', { n: days, days: tn('plural.days', days) }) });
    else if (outcome.kind === 'unknown') showToast({ text: t('extend.unknown'), kind: 'error', ttl: null });
    else showToast({ text: outcome.message === 'days' ? t('extend.badDays') : outcome.message, kind: 'error', ttl: null });
    void reloadBedolaga(id);
    void syncThread(id);
  };
  return (
    <Sheet open onClose={onClose} title={t('extend.title', { name, id: sub.id })}>
      <label class={s.field}>
        <span>{t('extend.days')}</span>
        <input type="number" inputMode="numeric" min={1} max={36500} value={days} disabled={state !== 'idle'}
          onInput={(event) => setDays(Number((event.target as HTMLInputElement).value))} />
      </label>
      <p class={sheetStyles.text}>{ok ? t('extend.newDate', { date: longDate(base + days * DAY) }) : t('extend.badDays')}</p>
      <p class={sheetStyles.text}>{t('extend.consequence')}</p>
      {state === 'uncertain' && <p class={s.warn} role="status">{t('extend.unknown')}</p>}
      <div class={sheetStyles.actions}>
        <Button variant="secondary" onClick={onClose} autoFocus>{t('sheet.cancel')}</Button>
        <Button variant="primary" disabled={!ok || state !== 'idle'} onClick={() => { void run(); }}>
          {state === 'pending' ? t('extend.running') : t('extend.yes', { n: days, days: tn('plural.days', ok ? days : 0) })}
        </Button>
      </div>
    </Sheet>
  );
}

/** Одна «+ Заметка»: к этому диалогу (в ленту) или о клиенте (во всех его диалогах). */
function NoteSheet({ id, onClose }: { id: number; onClose: () => void }): JSX.Element {
  const [target, setTarget] = useState<'thread' | 'client'>('thread');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async (): Promise<void> => {
    if (!text.trim()) return;
    setSaving(true);
    if (target === 'thread') {
      if (await saveNote(id, text)) onClose();
      setSaving(false);
      return;
    }
    try {
      await sendJson(`/api/conversations/${id}/profile/notes`, readToken() ?? '', { text: text.trim() });
      void reloadProfile(id);
      showToast({ text: t('toast.noteSaved') });
      onClose();
    } catch (err) {
      showToast({ text: t(actionErrorText(err instanceof ApiError ? err.code : 'unknown')), kind: 'error', ttl: null });
    } finally { setSaving(false); }
  };
  return (
    <Sheet open onClose={onClose} title={t('client.newNote')}>
      <fieldset class={s.radios}>
        <legend class="visually-hidden">{t('client.noteWhere')}</legend>
        <label><input type="radio" name="note-target" checked={target === 'thread'} onChange={() => setTarget('thread')} /> {t('client.noteThread')}</label>
        <label><input type="radio" name="note-target" checked={target === 'client'} onChange={() => setTarget('client')} /> {t('client.noteClient')}</label>
      </fieldset>
      <label class={s.field}>
        <span class="visually-hidden">{t('client.noteText')}</span>
        <textarea rows={4} value={text} placeholder={t('client.noteText')} onInput={(event) => setText((event.target as HTMLTextAreaElement).value)} />
      </label>
      <div class={sheetStyles.actions}>
        <Button variant="secondary" onClick={onClose}>{t('sheet.cancel')}</Button>
        <Button variant="primary" disabled={!text.trim() || saving} onClick={() => { void save(); }}>{t('client.save')}</Button>
      </div>
    </Sheet>
  );
}

function ProfileSheet({ id, profile, onClose }: { id: number; profile: { display_name: string | null; company: string | null; email: string | null; phone: string | null; tags: string[] }; onClose: () => void }): JSX.Element {
  const [values, setValues] = useState({
    display_name: profile.display_name ?? '', company: profile.company ?? '', email: profile.email ?? '', phone: profile.phone ?? '', tags: profile.tags.join(', '),
  });
  const set = (key: keyof typeof values) => (event: Event) => setValues({ ...values, [key]: (event.target as HTMLInputElement).value });
  const save = async (): Promise<void> => {
    try {
      await saveProfile(id, { ...values, tags: values.tags.split(',').map((tag) => tag.trim()).filter(Boolean) });
      showToast({ text: t('client.profileSaved') });
      onClose();
    } catch (err) {
      showToast({ text: t(actionErrorText(err instanceof ApiError ? err.code : 'unknown')), kind: 'error', ttl: null });
    }
  };
  const field = (key: keyof typeof values, label: string, type = 'text') => (
    <label class={s.field}><span>{label}</span><input type={type} value={values[key]} onInput={set(key)} /></label>
  );
  return (
    <Sheet open onClose={onClose} title={t('client.data')}>
      {field('display_name', t('client.name'))}
      {field('company', t('client.company'))}
      {field('email', t('client.email'), 'email')}
      {field('phone', t('client.phone'), 'tel')}
      {field('tags', t('client.tagsComma'))}
      <div class={sheetStyles.actions}>
        <Button variant="secondary" onClick={onClose}>{t('sheet.cancel')}</Button>
        <Button variant="primary" onClick={() => { void save(); }}>{t('client.save')}</Button>
      </div>
    </Sheet>
  );
}

