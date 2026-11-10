import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t, tn } from '@/i18n/ru';
import { validShortcut } from '@/lib/knowledge/model';
import { loadTemplates, removeTemplate, rights, saveTemplate, templates, templatesState, type Template } from '@/lib/knowledge/store';
import { Button } from '@/ui/Button';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import k from './knowledge.module.css';

const norm = (text: string): string => text.toLowerCase().replace(/ё/g, 'е');

/** Лист правки шаблона: короткое имя для «/», название, текст. */
function TemplateSheet({ item, onClose }: { item: Template | 'new' | null; onClose: () => void }): JSX.Element {
  const editing = item && item !== 'new' ? item : null;
  const [shortcut, setShortcut] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setShortcut(editing?.shortcut ?? ''); setTitle(editing?.title ?? ''); setBody(editing?.body ?? ''); setError(null);
  }, [item]);
  const shortcutOk = validShortcut(shortcut);
  const taken = (templates.value ?? []).some((row) => row.shortcut === shortcut.trim() && row.id !== editing?.id);
  const valid = shortcutOk && !taken && title.trim().length > 0 && title.trim().length <= 160 && body.trim().length > 0;
  const submit = async (): Promise<void> => {
    if (!valid || busy) return;
    setBusy(true);
    const failed = await saveTemplate({ shortcut: shortcut.trim(), title: title.trim(), body }, editing ?? undefined);
    setBusy(false);
    if (failed) { setError(failed); return; }
    onClose();
  };
  return (
    <Sheet open={item !== null} onClose={onClose} title={editing ? t('kb.template.edit') : t('kb.template.new')}>
      <form class={k.panel} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label class={k.field}>
          <span class={k.label}>{t('kb.template.shortcut')}</span>
          <input class={k.input} value={shortcut} maxLength={40} aria-invalid={shortcut && (!shortcutOk || taken) ? 'true' : undefined}
            onInput={(event) => setShortcut((event.target as HTMLInputElement).value)} />
          <span class={taken ? k.error : k.hint}>{taken ? t('kb.template.taken') : t('kb.template.shortcutHint')}</span>
        </label>
        <label class={k.field}>
          <span class={k.label}>{t('kb.template.title')}</span>
          <input class={k.input} value={title} maxLength={160} onInput={(event) => setTitle((event.target as HTMLInputElement).value)} />
        </label>
        <label class={k.field}>
          <span class={k.label}>{t('kb.template.body')}</span>
          <textarea class={k.textarea} rows={6} maxLength={20000} value={body} onInput={(event) => setBody((event.target as HTMLTextAreaElement).value)} />
        </label>
        {error && <p class={k.error} role="alert">{error}</p>}
        <div class={sheetStyles.actions}>
          <Button variant="quiet" onClick={onClose}>{t('kb.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={!valid || busy}>{t('kb.template.save')}</Button>
        </div>
      </form>
    </Sheet>
  );
}

/** «Шаблоны ответов» (6.6): список с поиском, создать, править, удалить с «Отменить». */
export function TemplatesPanel(): JSX.Element {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  useEffect(() => { void loadTemplates(); }, []);
  const manage = rights.value.templatesManage;
  const q = norm(query.trim());
  const list = (templates.value ?? []).filter((row) => !q || norm(`${row.shortcut} ${row.title} ${row.body}`).includes(q));
  return (
    <div class={k.panel}>
      <div class={k.bar}>
        <input class={`${k.input} ${k.search}`} type="search" value={query} aria-label={t('kb.template.search')} placeholder={t('kb.template.search')}
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)} />
        {manage && <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>{t('kb.template.new')}</Button>}
      </div>
      {templatesState.value === 'loading' && !templates.value && <div class={k.skeleton} aria-hidden="true" />}
      {templatesState.value === 'error' && (
        <p class={k.error} role="alert">{t('kb.loadFailed')} <Button variant="link" size="sm" onClick={() => void loadTemplates()}>{t('live.retry')}</Button></p>
      )}
      {templates.value && templates.value.length === 0 && <p class={k.muted}>{t('kb.template.empty')}</p>}
      {list.length > 0 && (
        <ul class={k.list} aria-label={t('kb.tab.templates')}>
          {list.map((row) => (
            <li key={row.id} class={k.templateRow}>
              <button type="button" class={k.item} disabled={!manage} onClick={() => setEditing(row)}>
                <span class={k.itemHead}>
                  <span class={k.itemTitle}>/{row.shortcut} · {row.title}</span>
                  <span class={k.itemMeta}>{row.uses > 0 ? t('kb.template.uses', { n: row.uses, times: tn('plural.times', row.uses) }) : t('kb.template.unused')}</span>
                </span>
                <span class={k.itemText}>{row.body}</span>
              </button>
              {manage && <Button variant="quiet" size="sm" onClick={() => removeTemplate(row)}>{t('kb.template.remove')}</Button>}
            </li>
          ))}
        </ul>
      )}
      <p class={k.hint}>{manage ? t('kb.template.hint') : t('kb.template.hintRead')}</p>
      <TemplateSheet item={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
