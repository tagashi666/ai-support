import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { tr, trn } from '@/i18n/sections/team';
import { showToast } from '@/lib/actions/toasts';
import {
  affectedPeople, canWords, diffPerms, normalizePerms, permGroups, permLabel, roleName, ROLES, sameSet, type Role,
} from '@/lib/team/model';
import { loadPeople, loadRoles, operators, rolesData, rolesError, rolesState, saveRole } from '@/lib/team/store';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import { BlockState } from './BlockState';
import k from './team.module.css';

interface Editing { role: Role; draft: string[]; step: 'edit' | 'diff'; reset: boolean }

/** Лист «Точно настроить» → «Что изменится» (затронет N человек, было → станет) → «Сохранить». */
function RoleSheet({ editing, onChange }: { editing: Editing | null; onChange: (next: Editing | null) => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setError(''); setBusy(false); }, [editing?.role, editing?.step]);
  const data = rolesData.value;
  const open = editing !== null && data !== null;
  const order = (data?.catalog ?? []).map((item) => item.id);
  const before = editing && data ? data.roles[editing.role] ?? [] : [];
  const after = editing ? [...normalizePerms(editing.draft)] : [];
  const diff = diffPerms(before, after, order);
  const hit = editing ? affectedPeople(operators.value ?? [], editing.role) : [];
  const roleTitle = editing ? roleName(editing.role) : '';
  const close = (): void => onChange(null);
  const save = async (): Promise<void> => {
    if (!editing) return;
    setBusy(true);
    setError('');
    const result = await saveRole(editing.role, after);
    setBusy(false);
    if (result.ok) { showToast({ text: tr('team.roles.saved', { role: roleTitle }) }); onChange(null); } else setError(tr('team.roles.saveFail', { reason: result.error }));
  };
  const toggle = (id: string, on: boolean): void => {
    if (!editing) return;
    const next = new Set(editing.draft);
    if (on) next.add(id); else next.delete(id);
    onChange({ ...editing, draft: [...next] });
  };
  const title = !editing ? '' : editing.step === 'edit' ? tr('team.roles.editTitle', { role: roleTitle })
    : editing.reset ? tr('team.roles.resetTitle', { role: roleTitle }) : tr('team.roles.diffTitle', { role: roleTitle });
  return (
    <Sheet open={open} onClose={close} title={title} size={editing?.step === 'edit' ? 'wide' : undefined}>
      {editing && data && editing.step === 'edit' && (
        <div class={k.sheetStack}>
          <p class={sheetStyles.text}>{tr('team.roles.editHint')}</p>
          <div class={k.groups} role="group" aria-label={tr('team.roles.groups')}>
            {permGroups(data.catalog).map((group) => (
              <fieldset key={group.group} class={k.group}>
                <legend>{group.label}</legend>
                {group.items.map((item) => (
                  <label key={item.id} class={k.check}>
                    <input type="checkbox" checked={editing.draft.includes(item.id)} onChange={(event) => toggle(item.id, (event.currentTarget as HTMLInputElement).checked)} />
                    <span>{item.label}</span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
          <div class={sheetStyles.actions}>
            <Button variant="secondary" onClick={close}>{tr('team.cancel')}</Button>
            <Button variant="primary" onClick={() => onChange({ ...editing, step: 'diff' })}>{tr('team.roles.review')}</Button>
          </div>
        </div>
      )}
      {editing && data && editing.step === 'diff' && (
        <div class={k.sheetStack}>
          <p class={sheetStyles.text}>
            {hit.length
              ? tr('team.roles.affects', { n: hit.length, people: trn('team.roles.people', hit.length), names: hit.map((person) => person.name).join(', ') })
              : tr('team.roles.affectsNone')}
          </p>
          {diff.added.length + diff.removed.length === 0 ? <p class={k.muted}>{tr('team.roles.nothing')}</p> : (
            <>
              <p class={k.strong}>{tr('team.roles.was')}</p>
              <ul class={k.diffList}>
                {diff.added.map((id) => <li key={`+${id}`} class={k.diffAdd}>{tr('team.roles.add', { what: permLabel(id, data.catalog.find((item) => item.id === id)?.label) })}</li>)}
                {diff.removed.map((id) => <li key={`-${id}`} class={k.diffRemove}>{tr('team.roles.remove', { what: permLabel(id, data.catalog.find((item) => item.id === id)?.label) })}</li>)}
              </ul>
            </>
          )}
          {error && <p class={k.error} role="alert">{error}</p>}
          <div class={sheetStyles.actions}>
            <Button variant="secondary" onClick={() => (editing.reset ? close() : onChange({ ...editing, step: 'edit' }))}>
              {editing.reset ? tr('team.cancel') : tr('team.back')}
            </Button>
            <Button variant="primary" disabled={busy || diff.added.length + diff.removed.length === 0} onClick={() => void save()}>{tr('team.roles.save')}</Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

/** «Роли»: четыре карточки «может / не может» в одном порядке везде; точная настройка с показом разницы. */
export function RolesPanel(): JSX.Element {
  const [editing, setEditing] = useState<Editing | null>(null);
  useEffect(() => { void loadRoles(); void loadPeople(false); }, []);
  const data = rolesData.value;
  return (
    <div class={k.panel}>
      <p class={k.muted}>{tr('team.roles.hint')}</p>
      <BlockState state={rolesState.value} error={rolesError.value} onRetry={() => void loadRoles()}>
        {data && (
          <div class={k.roleGrid} role="list" aria-label={tr('team.roles.list')}>
            {ROLES.map((role) => {
              const perms = data.roles[role] ?? [];
              const custom = !sameSet(perms, data.defaults[role] ?? []);
              const words = canWords(perms);
              const names = affectedPeople(operators.value ?? [], role).map((person) => person.name);
              return (
                <div role="listitem" key={role}>
                  <Card class={k.roleCard} label={roleName(role)}>
                    <div class={k.roleHead}>
                      <h2 class={k.roleTitle}>{roleName(role)}</h2>
                      <span class={k.tag} data-custom={custom ? 'true' : undefined}>{custom ? tr('team.roles.custom') : tr('team.roles.standard')}</span>
                    </div>
                    <div class={k.words}>
                      <p><span class={k.strong}>{tr('team.card.can', { list: words.can.join(', ') || '—' })}</span></p>
                      <p>{words.cannot.length ? tr('team.card.cannot', { list: words.cannot.join(', ') }) : tr('team.card.cannotNone')}</p>
                      <p class={k.hint}>{names.length ? tr('team.roles.who', { names: names.join(', ') }) : tr('team.roles.nobody')}</p>
                    </div>
                    {role === 'admin' ? <p class={k.hint}>{tr('team.roles.locked')}</p> : (
                      <div class={k.actions}>
                        <Button variant="secondary" onClick={() => setEditing({ role, draft: [...perms], step: 'edit', reset: false })}>{tr('team.roles.tune')}</Button>
                        {custom && (
                          <Button variant="quiet" onClick={() => setEditing({ role, draft: [...(data.defaults[role] ?? [])], step: 'diff', reset: true })}>{tr('team.roles.reset')}</Button>
                        )}
                      </div>
                    )}
                  </Card>
                </div>
              );
            })}
          </div>
        )}
      </BlockState>
      <RoleSheet editing={editing} onChange={setEditing} />
    </div>
  );
}
