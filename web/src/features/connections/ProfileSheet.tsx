import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { tr } from '@/i18n/sections/connections';
import { showToast } from '@/lib/actions/toasts';
import { checkProfile, clientPreview, PROFILE_LIMITS, sameProfile, type Profile, type ProfileCode } from '@/lib/connections/model';
import { connections, saveProfile } from '@/lib/connections/store';
import { Bubble } from '@/ui/Bubble';
import { Button } from '@/ui/Button';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import c from './connections.module.css';

const ERROR_TEXT: Record<'serviceName' | 'greetingMessage' | 'handoffMessage', Record<ProfileCode, Parameters<typeof tr>[0] | null>> = {
  serviceName: { empty: 'connections.profile.err.nameEmpty', long: 'connections.profile.err.nameLong', short: null },
  greetingMessage: { empty: null, long: 'connections.profile.err.greetingLong', short: null },
  handoffMessage: { empty: null, long: 'connections.profile.err.handoffLong', short: 'connections.profile.err.handoffShort' },
};

/** «Как мы представляемся» (6.11): название, приветствие, фраза передачи человеку и пример для клиента. */
export function ProfileSheet({ sourceId, sourceName, onClose }: { sourceId: string; sourceName: string; onClose: () => void }): JSX.Element {
  const saved: Profile = connections.value?.serviceProfiles[sourceId] ?? { serviceName: sourceName, greetingMessage: '', handoffMessage: '' };
  const [draft, setDraft] = useState<Profile>({ serviceName: saved.serviceName, greetingMessage: saved.greetingMessage, handoffMessage: saved.handoffMessage });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const errors = checkProfile(draft);
  const invalid = Object.keys(errors).length > 0;
  const changed = !sameProfile(draft, saved);
  const set = (key: keyof Profile) => (event: Event): void => {
    setFailure('');
    setDraft({ ...draft, [key]: (event.target as HTMLInputElement | HTMLTextAreaElement).value });
  };
  const textOf = (key: keyof Profile): string | null => {
    const code = errors[key];
    const id = code ? ERROR_TEXT[key][code] : null;
    return id ? tr(id, { max: key === 'serviceName' ? PROFILE_LIMITS.name : PROFILE_LIMITS.greeting, min: PROFILE_LIMITS.handoffMin }) : null;
  };
  const save = async (): Promise<void> => {
    if (invalid || busy) return;
    setBusy(true);
    const problem = await saveProfile(sourceId, draft);
    setBusy(false);
    if (problem) { setFailure(problem); return; }
    showToast({ text: tr('connections.profile.saved') });
    onClose();
  };
  const lines = clientPreview(draft);
  const field = (key: keyof Profile, label: string, hint: string, area: boolean): JSX.Element => {
    const problem = textOf(key);
    const id = `profile-${key}`;
    const common = { id, value: draft[key], onInput: set(key), 'aria-invalid': problem ? 'true' as const : undefined, 'aria-describedby': `${id}-hint` };
    return (
      <div class={c.field}>
        <label for={id} class={c.label}>{label}</label>
        {area ? <textarea class={c.textarea} rows={3} {...common} /> : <input class={c.input} type="text" autoComplete="off" {...common} />}
        <p id={`${id}-hint`} class={problem ? c.error : c.hint}>{problem ?? hint}</p>
      </div>
    );
  };
  return (
    <Sheet open onClose={onClose} title={tr('connections.profile.title')} size="wide">
      <div class={c.profile}>
        <form class={c.form} onSubmit={(event) => { event.preventDefault(); void save(); }} noValidate>
          <p class={sheetStyles.text}>{tr('connections.profile.why')}</p>
          {field('serviceName', tr('connections.profile.name'), tr('connections.profile.nameHint', { max: PROFILE_LIMITS.name }), false)}
          {field('greetingMessage', tr('connections.profile.greeting'), tr('connections.profile.greetingHint', { max: PROFILE_LIMITS.greeting }), true)}
          {field('handoffMessage', tr('connections.profile.handoff'), tr('connections.profile.handoffHint', { min: PROFILE_LIMITS.handoffMin, max: PROFILE_LIMITS.greeting }), true)}
          {failure && <p class={c.error} role="alert">{tr('connections.profile.failed', { reason: failure })}</p>}
          <div class={sheetStyles.actions}>
            <Button variant="quiet" onClick={onClose}>{tr('connections.cancel')}</Button>
            <Button variant="primary" type="submit" disabled={busy || invalid || !changed}>{busy ? tr('connections.saving') : tr('connections.save')}</Button>
          </div>
        </form>
        <section class={c.preview} aria-label={tr('connections.preview.title')}>
          <h3 class={c.previewTitle}>{tr('connections.preview.title')}</h3>
          {lines.map((line, index) => (
            <Bubble key={index} voice={line.who === 'client' ? 'client' : 'you'} {...(line.label ? { label: line.label } : {})} meta=""
              a11y={line.who === 'client' ? tr('connections.preview.clientSays', { text: line.text }) : tr('connections.preview.botSays', { name: line.label ?? '', text: line.text })}>
              {line.text}
            </Bubble>
          ))}
        </section>
      </div>
    </Sheet>
  );
}
