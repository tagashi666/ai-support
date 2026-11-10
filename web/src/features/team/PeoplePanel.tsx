import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { tr } from '@/i18n/sections/team';
import { can } from '@/lib/assistant/store';
import { showToast } from '@/lib/actions/toasts';
import { listTime } from '@/lib/format/format';
import { bootstrap } from '@/lib/live/store';
import { navigate } from '@/lib/router';
import {
  createOperator, lastSeen, loadPeople, loadRoles, operators, peopleError, peopleState, rolesData, rotateKey, setActive, setRole,
  type Operator,
} from '@/lib/team/store';
import { canWords, isRole, roleBrief, roleName, ROLES } from '@/lib/team/model';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import { KeyBox } from './KeyBox';
import { BlockState } from './BlockState';
import k from './team.module.css';

const openPerson = (id: number | 'new' | null): void =>
  navigate({ name: 'section', key: 'team', sub: 'people', ...(id === null ? {} : { item: String(id) }) }, id === null);

function RoleChoice({ value, onChange }: { value: string; onChange: (role: string) => void }): JSX.Element {
  return (
    <fieldset class={k.radios}>
      <legend>{tr('team.add.role')}</legend>
      {ROLES.map((role) => (
        <label key={role} class={k.radio}>
          <input type="radio" name="team-role" value={role} checked={value === role} onChange={() => onChange(role)} />
          <span class={k.radioName}>{roleName(role)}</span>
          <span class={k.radioHint}>{roleBrief(role)}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** «Новый человек»: имя и роль → ключ входа один раз → «Готово». Ключ стирается вместе с листом. */
function AddSheet({ open }: { open: boolean }): JSX.Element {
  const [name, setName] = useState('');
  const [role, setRoleValue] = useState<string>('agent');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  useEffect(() => {
    if (!open) { setName(''); setRoleValue('agent'); setError(''); setCreated(null); setBusy(false); }
  }, [open]);
  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    const clean = name.trim();
    if (clean.length < 2) { setError(tr('team.add.short')); return; }
    setBusy(true);
    setError('');
    const result = await createOperator(clean, role);
    setBusy(false);
    if (result.ok) setCreated({ name: clean, token: result.token }); else setError(tr('team.card.fail', { reason: result.error }));
  };
  const close = (): void => openPerson(null);
  return (
    <Sheet open={open} onClose={close} title={created ? tr('team.add.keyTitle') : tr('team.add.title')}>
      {created ? (
        <div class={k.sheetStack}>
          <KeyBox value={created.token} />
          <p class={sheetStyles.text}>{tr('team.add.hand', { name: created.name })}</p>
          <div class={sheetStyles.actions}><Button variant="primary" onClick={close}>{tr('team.add.done')}</Button></div>
        </div>
      ) : (
        <form class={k.sheetStack} onSubmit={(event) => void submit(event)}>
          <div class={k.field}>
            <label class={k.label} for="team-name">{tr('team.add.name')}</label>
            <input id="team-name" class={k.input} value={name} maxLength={80} autocomplete="off" aria-invalid={error && name.trim().length < 2 ? 'true' : undefined}
              onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)} />
          </div>
          <RoleChoice value={role} onChange={setRoleValue} />
          {error && <p class={k.error} role="alert">{error}</p>}
          <div class={sheetStyles.actions}>
            <Button variant="primary" type="submit" disabled={busy}>{busy ? tr('team.add.creating') : tr('team.add.create')}</Button>
          </div>
        </form>
      )}
    </Sheet>
  );
}

type Step = 'card' | 'role' | 'rotate' | 'key' | 'disable';

/** Карточка человека: «может / не может», смена роли, новый ключ (ярус 2), отключение доступа (ярус 2). */
function PersonSheet({ person }: { person: Operator | undefined }): JSX.Element {
  const [step, setStep] = useState<Step>('card');
  const [role, setRoleValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [token, setToken] = useState('');
  const open = person !== undefined;
  useEffect(() => { if (!open) { setStep('card'); setToken(''); setError(''); setBusy(false); } }, [open]);
  useEffect(() => { if (person) setRoleValue(person.role); }, [person?.id, person?.role]);
  const manage = can('operators:manage');
  const close = (): void => openPerson(null);
  const me = bootstrap.value?.me.id;
  const name = person?.name ?? '';
  const isSelf = person ? me === `op:${person.id}` : false;
  const run = async (action: () => Promise<{ ok: true } | { ok: false; error: string }>, then: () => void): Promise<void> => {
    setBusy(true);
    setError('');
    const result = await action();
    setBusy(false);
    if (result.ok) then(); else setError(tr('team.card.fail', { reason: result.error }));
  };
  const perms = person ? rolesData.value?.roles[person.role] : undefined;
  const words = perms ? canWords(perms) : null;
  const title = !person ? '' : step === 'role' ? tr('team.card.roleTitle', { name }) : step === 'rotate' ? tr('team.card.keyTitle', { name })
    : step === 'key' ? tr('team.card.keyDone', { name }) : step === 'disable' ? tr('team.card.disableTitle', { name })
      : tr('team.card.title', { name, role: roleName(person.role) });
  const back = (): void => { setStep('card'); setError(''); };
  return (
    <Sheet open={open} onClose={close} title={title} side="right" size="pane">
      {person && step === 'card' && (
        <div class={k.sheetStack}>
          <p class={k.personMeta}>
            <span class={k.status} data-off={person.active ? undefined : 'true'}>{person.active ? tr('team.people.on') : tr('team.people.off')}</span>
          </p>
          <div class={k.words}>
            {words ? (
              <>
                <p><span class={k.strong}>{tr('team.card.can', { list: words.can.join(', ') || '—' })}</span></p>
                <p>{words.cannot.length ? tr('team.card.cannot', { list: words.cannot.join(', ') }) : tr('team.card.cannotNone')}</p>
                {words.can.length === 0 && <p>{tr('team.card.canNone')}</p>}
              </>
            ) : <p>{roleBrief(person.role)}</p>}
          </div>
          {!person.active && <p class={k.hint}>{tr('team.card.disabledNote')}</p>}
          {error && <p class={k.error} role="alert">{error}</p>}
          {manage && (
            <div class={k.actions}>
              <Button variant="secondary" onClick={() => { setStep('role'); setError(''); }}>{tr('team.card.changeRole')}</Button>
              <Button variant="secondary" onClick={() => { setStep('rotate'); setError(''); }}>{tr('team.card.newKey')}</Button>
              {person.active
                ? !isSelf && <Button variant="danger" onClick={() => { setStep('disable'); setError(''); }}>{tr('team.card.disable')}</Button>
                : <Button variant="primary" disabled={busy} onClick={() => void run(() => setActive(person.id, true), () => showToast({ text: tr('team.card.enabledDone', { name }) }))}>{tr('team.card.enable')}</Button>}
            </div>
          )}
        </div>
      )}
      {person && step === 'role' && (
        <div class={k.sheetStack}>
          <RoleChoice value={role} onChange={setRoleValue} />
          {error && <p class={k.error} role="alert">{error}</p>}
          <div class={sheetStyles.actions}>
            <Button variant="secondary" onClick={back}>{tr('team.back')}</Button>
            <Button variant="primary" disabled={busy || role === person.role || !isRole(role)}
              onClick={() => void run(() => setRole(person.id, role), () => { showToast({ text: tr('team.card.roleDone', { name, role: roleName(role) }) }); back(); })}>
              {tr('team.card.roleApply')}
            </Button>
          </div>
        </div>
      )}
      {person && step === 'rotate' && (
        <div class={k.sheetStack}>
          <p class={sheetStyles.text}>{tr('team.card.keyWarn', { name })}</p>
          {error && <p class={k.error} role="alert">{error}</p>}
          <div class={sheetStyles.actions}>
            <Button variant="secondary" onClick={back}>{tr('team.cancel')}</Button>
            <Button variant="danger" disabled={busy}
              onClick={() => { setBusy(true); setError(''); void rotateKey(person.id).then((result) => {
                setBusy(false);
                if (result.ok) { setToken(result.token); setStep('key'); } else setError(tr('team.card.fail', { reason: result.error }));
              }); }}>
              {tr('team.card.keyConfirm')}
            </Button>
          </div>
        </div>
      )}
      {person && step === 'key' && (
        <div class={k.sheetStack}>
          <KeyBox value={token} />
          <p class={sheetStyles.text}>{tr('team.add.hand', { name })}</p>
          <div class={sheetStyles.actions}><Button variant="primary" onClick={() => { setToken(''); close(); }}>{tr('team.add.done')}</Button></div>
        </div>
      )}
      {person && step === 'disable' && (
        <div class={k.sheetStack}>
          <p class={sheetStyles.text}>{tr('team.card.disableWarn', { name })}</p>
          {error && <p class={k.error} role="alert">{error}</p>}
          <div class={sheetStyles.actions}>
            <Button variant="secondary" onClick={back}>{tr('team.cancel')}</Button>
            <Button variant="danger" disabled={busy}
              onClick={() => void run(() => setActive(person.id, false), () => { showToast({ text: tr('team.card.disabledDone', { name }) }); back(); })}>
              {tr('team.card.disableConfirm')}
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

/** «Люди»: владелец и операторы; карточка и добавление — листы, адрес /next/team/people/<id|new>. */
export function PeoplePanel({ item }: { item?: string }): JSX.Element {
  const stats = can('operator_stats:read');
  const manage = can('operators:manage');
  useEffect(() => { void loadPeople(stats); if (can('roles:manage')) void loadRoles(); }, [stats]);
  const list = operators.value ?? [];
  const me = bootstrap.value?.me.id;
  const now = Date.now();
  const selected = item && item !== 'new' ? list.find((person) => String(person.id) === item) : undefined;
  return (
    <div class={k.panel}>
      <BlockState state={peopleState.value} error={peopleError.value} onRetry={() => void loadPeople(stats)}>
        <ul class={k.list} aria-label={tr('team.people.list')}>
          <li>
            <div class={k.person} data-static="true">
              <Avatar name={tr('team.role.owner')} />
              <span class={k.personBody}>
                <span class={k.personHead}>
                  <span class={k.personName}>{tr('team.role.owner')}</span>
                  {me === 'root' && <span class={k.you}>{tr('team.people.you')}</span>}
                </span>
              </span>
            </div>
          </li>
          {list.map((person) => {
            const seen = lastSeen.value[`op:${person.id}`];
            return (
              <li key={person.id}>
                <button type="button" class={k.person} onClick={() => openPerson(person.id)}>
                  <Avatar name={person.name} />
                  <span class={k.personBody}>
                    <span class={k.personHead}>
                      <span class={k.personName}>{person.name}</span>
                      <span class={k.personRole}>{roleName(person.role)}</span>
                      {me === `op:${person.id}` && <span class={k.you}>{tr('team.people.you')}</span>}
                    </span>
                    <span class={k.personMeta}>
                      <span class={k.status} data-off={person.active ? undefined : 'true'}>{person.active ? tr('team.people.on') : tr('team.people.off')}</span>
                      {stats && person.active ? (
                        <span>{tr('team.people.last', { when: seen ? listTime(seen, now) : tr('team.people.never') })}</span>
                      ) : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {list.length === 0 && (
          <div class={k.empty}>
            <p class={k.muted}>{tr('team.people.alone')}</p>
            {manage && <Button variant="primary" onClick={() => openPerson('new')}>{tr('team.people.invite')}</Button>}
          </div>
        )}
        {list.length > 0 && manage && (
          <div class={k.actions}><Button variant="secondary" onClick={() => openPerson('new')}>{tr('team.people.add')}</Button></div>
        )}
      </BlockState>
      {item && item !== 'new' && peopleState.value === 'ready' && !selected && <p class={k.muted}>{tr('team.people.notFound')}</p>}
      <AddSheet open={item === 'new' && manage} />
      <PersonSheet person={selected} />
    </div>
  );
}
