import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { tr } from '@/i18n/sections/connections';
import { checkFolderName, FOLDER_COLORS, folderChannels, safeColor } from '@/lib/connections/model';
import { folders, loadMeta, meta, metaError, metaState, removeFolder, saveFolder, type Folder } from '@/lib/connections/store';
import { Button } from '@/ui/Button';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import c from './connections.module.css';

function FolderSheet({ folder, onClose }: { folder: Folder | null; onClose: () => void }): JSX.Element {
  const sources = meta.value?.sources ?? [];
  const [name, setName] = useState(folder?.name ?? '');
  const [color, setColor] = useState<string | null>(safeColor(folder?.color) ?? FOLDER_COLORS[0]?.value ?? null);
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set(folder?.source_ids ?? []));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const code = checkFolderName(name);
  const nameError = tried && code ? (code === 'empty' ? tr('connections.folders.err.empty') : tr('connections.folders.err.long')) : null;
  const palette = color && !FOLDER_COLORS.some((item) => item.value === color) ? [...FOLDER_COLORS, { value: color, name: 'connections.color.current' as const }] : FOLDER_COLORS;
  const toggle = (id: string): void => {
    const next = new Set(ids);
    if (next.has(id)) next.delete(id); else next.add(id);
    setIds(next);
  };
  const save = async (): Promise<void> => {
    setTried(true);
    if (code || busy) return;
    setBusy(true);
    const problem = await saveFolder({ ...(folder ? { id: folder.id } : {}), name, color, sourceIds: [...ids] });
    setBusy(false);
    if (problem) { setFailure(problem); return; }
    onClose();
  };
  return (
    <Sheet open onClose={onClose} title={folder ? tr('connections.folders.editTitle') : tr('connections.folders.newTitle')}>
      <form class={c.form} noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div class={c.field}>
          <label for="folder-name" class={c.label}>{tr('connections.folders.name')}</label>
          <input id="folder-name" class={c.input} type="text" maxLength={80} autoComplete="off" value={name} placeholder={tr('connections.folders.namePlaceholder')}
            aria-invalid={nameError ? 'true' : undefined} aria-describedby="folder-name-hint" onInput={(event) => { setFailure(''); setName((event.target as HTMLInputElement).value); }} />
          <p id="folder-name-hint" class={nameError ? c.error : c.hint}>{nameError ?? tr('connections.folders.nameHint')}</p>
        </div>
        <fieldset class={c.colors}>
          <legend>{tr('connections.folders.color')}</legend>
          {palette.map((item) => (
            <label key={item.value} class={c.color}>
              <input type="radio" name="folder-color" checked={color === item.value} aria-label={tr(item.name)} onChange={() => setColor(item.value)} />
              <span style={{ background: item.value }} aria-hidden="true">{color === item.value ? '✓' : ''}</span>
            </label>
          ))}
        </fieldset>
        <fieldset class={c.pick}>
          <legend>{tr('connections.folders.channels')}</legend>
          {sources.length === 0 && <p class={c.hint}>{tr('connections.folders.noSources')}</p>}
          <div class={c.checks}>
            {sources.map((source) => (
              <label key={source.id} class={c.check}>
                <input type="checkbox" checked={ids.has(source.id)} onChange={() => toggle(source.id)} />
                <span>{source.name}</span>
              </label>
            ))}
          </div>
          <p class={c.hint}>{tr('connections.folders.channelsHint')}</p>
        </fieldset>
        {failure && <p class={c.error} role="alert">{tr('connections.folders.failed', { reason: failure })}</p>}
        <div class={sheetStyles.actions}>
          <Button variant="quiet" onClick={onClose}>{tr('connections.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={busy}>{busy ? tr('connections.saving') : tr('connections.save')}</Button>
        </div>
      </form>
    </Sheet>
  );
}

/** Вкладка «Папки» (6.11): список с цветом и каналами; удаление — сразу с «Отменить». */
export function FoldersPanel(): JSX.Element {
  const [editing, setEditing] = useState<Folder | 'new' | null>(null);
  useEffect(() => { void loadMeta(); }, []);
  const state = metaState.value;
  if (state === 'idle' || state === 'loading') return <div class={c.skeleton} key="skeleton" aria-hidden="true" />;
  if (state === 'error') {
    return (
      <div class={c.panel}>
        <p class={c.error} role="alert">{tr('connections.loadFailed', { reason: metaError.value })}</p>
        <div class={c.actions}><Button variant="secondary" onClick={() => void loadMeta()}>{tr('connections.retry')}</Button></div>
      </div>
    );
  }
  const sources = meta.value?.sources ?? [];
  const list = folders.value;
  return (
    <div class={c.panel}>
      <p class={c.muted}>{tr('connections.folders.about')}</p>
      <div class={c.actions}><Button variant="primary" icon="plus" onClick={() => setEditing('new')}>{tr('connections.folders.new')}</Button></div>
      {list.length === 0 ? (
        <div class={c.empty}><p class={c.emptyTitle}>{tr('connections.folders.empty')}</p></div>
      ) : (
        <ul class={c.list} aria-label={tr('connections.folders.list')}>
          {list.map((folder) => {
            const color = safeColor(folder.color);
            return (
              <li key={folder.id} class={c.folder}>
                <span class={c.swatch} style={color ? { background: color } : undefined} aria-hidden="true" />
                <div class={c.folderText}>
                  <span class={c.folderName}>{folder.name}</span>
                  <span class={c.hint}>{folderChannels(folder.source_ids, sources)}</span>
                </div>
                <Button variant="secondary" size="sm" aria-label={tr('connections.folders.editNamed', { name: folder.name })} onClick={() => setEditing(folder)}>{tr('connections.folders.edit')}</Button>
                <Button variant="quiet" size="sm" aria-label={tr('connections.folders.removeNamed', { name: folder.name })} onClick={() => removeFolder(folder)}>{tr('connections.folders.remove')}</Button>
              </li>
            );
          })}
        </ul>
      )}
      {editing && <FolderSheet key={editing === 'new' ? 'new' : editing.id} folder={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
