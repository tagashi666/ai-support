import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { bootstrap } from '@/lib/live/store';
import { loadTeamNames, teamNames } from '@/lib/workspace/collab';
import type { ListFilter } from '@/lib/workspace/filter';
import { Button } from '@/ui/Button';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import w from './workspace.module.css';

/** Лист «Фильтр» (6.2): папки живут здесь, а не вкладками рядом с видами. */
export function FilterSheet({ open, onClose, value, onChange }: {
  open: boolean; onClose: () => void; value: ListFilter; onChange: (next: ListFilter) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<ListFilter>(value);
  useEffect(() => { if (open) { setDraft(value); void loadTeamNames(); } }, [open]);
  const me = bootstrap.value?.me.id ?? '';
  const people = (teamNames.value ?? []).filter((person) => person.id !== me);
  const sources = bootstrap.value?.sources.filter((source) => source.enabled) ?? [];
  const folders = bootstrap.value?.folders ?? [];
  const radio = (name: string, checked: boolean, label: string, pick: () => void): JSX.Element => (
    <label class={w.choice} key={`${name}-${label}`}>
      <input type="radio" name={name} checked={checked} onChange={pick} />
      <span>{label}</span>
    </label>
  );
  return (
    <Sheet open={open} onClose={onClose} title={t('filter.title')}>
      <fieldset class={w.group}>
        <legend>{t('filter.source')}</legend>
        {radio('src', !draft.source, t('filter.all'), () => setDraft({ ...draft, source: undefined }))}
        {sources.map((source) => radio('src', draft.source === source.id, source.name, () => setDraft({ ...draft, source: source.id })))}
      </fieldset>
      {folders.length > 0 && (
        <fieldset class={w.group}>
          <legend>{t('filter.folders')}</legend>
          {radio('folder', draft.folder === undefined, t('filter.all'), () => setDraft({ ...draft, folder: undefined }))}
          {folders.map((folder) => radio('folder', draft.folder === folder.id, folder.name, () => setDraft({ ...draft, folder: folder.id })))}
        </fieldset>
      )}
      <fieldset class={w.group}>
        <legend>{t('filter.assignee')}</legend>
        {radio('who', !draft.assignee, t('filter.all'), () => setDraft({ ...draft, assignee: undefined }))}
        {radio('who', draft.assignee === 'me', t('filter.me'), () => setDraft({ ...draft, assignee: 'me' }))}
        {people.map((person) => radio('who', draft.assignee === person.id, person.name, () => setDraft({ ...draft, assignee: person.id })))}
        {radio('who', draft.assignee === 'none', t('filter.nobody'), () => setDraft({ ...draft, assignee: 'none' }))}
      </fieldset>
      <fieldset class={w.group}>
        <legend>{t('filter.only')}</legend>
        <label class={w.choice}>
          <input type="checkbox" checked={Boolean(draft.important)} onChange={(event) => setDraft({ ...draft, important: (event.target as HTMLInputElement).checked || undefined })} />
          <span>{t('filter.important')}</span>
        </label>
        <label class={w.choice}>
          <input type="checkbox" checked={Boolean(draft.notFound)} onChange={(event) => setDraft({ ...draft, notFound: (event.target as HTMLInputElement).checked || undefined })} />
          <span>{t('filter.notFound')}</span>
        </label>
      </fieldset>
      <div class={sheetStyles.actions}>
        <Button variant="secondary" onClick={() => { onChange({}); onClose(); }}>{t('filter.reset')}</Button>
        <Button variant="primary" onClick={() => { onChange(draft); onClose(); }}>{t('filter.apply')}</Button>
      </div>
    </Sheet>
  );
}
