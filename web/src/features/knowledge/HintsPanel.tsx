import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t, type Key } from '@/i18n/ru';
import { showToast, undoToast } from '@/lib/actions/toasts';
import { can } from '@/lib/assistant/store';
import {
  checkForm, formOf, hintRows, sameField, valueOf, withEdit, withHidden, withOwn, withoutOwn, withReset,
  type HintForm, type HintMode, type HintOverrides, type HintRow, type HintsState,
} from '@/lib/knowledge/hints';
import { getJson, readToken, sendJson, uploadFile } from '@/lib/live/api';
import { isDesktop } from '@/lib/media';
import { Button } from '@/ui/Button';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import k from './knowledge.module.css';

const token = (): string => readToken() ?? '';
const MODE_LABEL: Record<HintMode, Key> = { full: 'kb.hints.full', lite: 'kb.hints.lite' };
const PROBLEM: Record<Exclude<ReturnType<typeof checkForm>, null>, Key> = {
  needTitle: 'kb.hints.needTitle', needSteps: 'kb.hints.needSteps', tooManySteps: 'kb.hints.tooManySteps', tooManyWords: 'kb.hints.tooManyWords',
};
const TEXT_FIELDS: readonly { field: 'title' | 'routeDescription' | 'keywords' | 'instructions' | 'caption'; label: Key; area?: boolean; max: number }[] = [
  { field: 'title', label: 'kb.hints.fTitle', max: 160 },
  { field: 'routeDescription', label: 'kb.hints.fWhere', max: 500 },
  { field: 'keywords', label: 'kb.hints.fWords', max: 2000 },
  { field: 'instructions', label: 'kb.hints.fSteps', area: true, max: 20000 },
  { field: 'caption', label: 'kb.hints.fCaption', max: 500 },
];
const imageUrl = (image: string): string => `/api/interface-kb/images/${image.split('/').map(encodeURIComponent).join('/')}`;

/** Картинка по медиа-билету в cookie; истёк — берём новый один раз. */
function HintImage({ image }: { image: string }): JSX.Element {
  const [src, setSrc] = useState(imageUrl(image));
  const [retried, setRetried] = useState(false);
  useEffect(() => { setSrc(imageUrl(image)); setRetried(false); }, [image]);
  return (
    <img class={k.image} src={src} alt={t('kb.hints.imageAlt')} onError={() => {
      if (retried) return;
      setRetried(true);
      void getJson('/api/ticket', token()).then(() => setSrc(`${imageUrl(image)}?r=${Date.now()}`)).catch(() => undefined);
    }} />
  );
}

function Editor({ state, row, mode, onSaved, onDirty }: {
  state: HintsState; row: HintRow | null; mode: HintMode; onSaved: (next: HintOverrides, text: string) => Promise<boolean>; onDirty: (dirty: boolean) => void;
}): JSX.Element {
  const editor = can('knowledge:manage');
  const custom = !row || row.custom;
  const own = row && !custom ? state.overrides.screens[row.id] : undefined;
  const start = formOf(row?.screen ?? {});
  const [form, setForm] = useState<HintForm>(start);
  const [scope, setScope] = useState<'all' | HintMode>(own && own[mode] && !own.all ? mode : 'all');
  const [only, setOnly] = useState<HintMode | ''>(custom && row ? state.overrides.added.find((item) => item.id === row.id)?.only ?? '' : '');
  const [problem, setProblem] = useState<Key | null>(null);
  const [confirm, setConfirm] = useState<'reset' | 'delete' | null>(null);
  const [uploading, setUploading] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(start);
  useEffect(() => { onDirty(dirty); }, [dirty]);
  const std = row?.std ?? null;
  const value = valueOf(form);
  const set = (patch: Partial<HintForm>): void => setForm({ ...form, ...patch });

  const save = async (): Promise<void> => {
    const issue = checkForm(form);
    if (issue) { setProblem(PROBLEM[issue]); return; }
    setProblem(null);
    const next = custom ? withOwn(state.overrides, row?.id ?? null, form, only || null) : withEdit(state.overrides, row!.id, scope, form, row!.screen);
    await onSaved(next, t('kb.hints.saved'));
  };
  const upload = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { setProblem('kb.hints.imageTooBig'); return; }
    setUploading(true);
    try {
      const body = await uploadFile<{ image?: string }>('/api/interface-kb/images', token(), file, {});
      if (body.image) set({ image: body.image });
    } catch {
      setProblem('kb.hints.imageFailed');
    }
    setUploading(false);
  };

  return (
    <section class={k.card} aria-label={row ? row.screen.title : t('kb.hints.newScreen')}>
      <h2 class={k.cardTitle}>{row ? row.screen.title : t('kb.hints.newScreen')}</h2>
      {custom ? (
        <label class={k.field}>
          <span class={k.label}>{t('kb.hints.show')}</span>
          <select class={k.select} value={only} disabled={!editor} onChange={(event) => setOnly((event.target as HTMLSelectElement).value as HintMode | '')}>
            <option value="">{t('kb.hints.both')}</option>
            <option value="full">{t('kb.hints.onlyFull')}</option>
            <option value="lite">{t('kb.hints.onlyLite')}</option>
          </select>
        </label>
      ) : (
        <label class={k.field}>
          <span class={k.label}>{t('kb.hints.scope')}</span>
          <select class={k.select} value={scope} disabled={!editor} onChange={(event) => setScope((event.target as HTMLSelectElement).value as 'all' | HintMode)}>
            <option value="all">{t('kb.hints.both')}</option>
            <option value={mode}>{t('kb.hints.onlyThis', { mode: t(MODE_LABEL[mode]) })}</option>
          </select>
          <span class={k.hint}>{t('kb.hints.scopeHint')}</span>
        </label>
      )}
      {TEXT_FIELDS.map(({ field, label, area, max }) => {
        const differs = std !== null && !sameField(field, value[field], std[field]);
        const id = `hint-${field}`;
        return (
          <div key={field} class={k.field}>
            <div class={k.fieldHead}>
              <label class={k.label} for={id}>{t(label)}{differs && ` · ${t('kb.hints.changed')}`}</label>
              {differs && editor && <Button variant="link" size="sm" onClick={() => set(formOf({ ...valueOf(form), [field]: std[field] } as never) as HintForm)}>{t('kb.hints.restore')}</Button>}
            </div>
            {area
              ? <textarea id={id} class={k.textarea} rows={8} maxLength={max} disabled={!editor} value={form[field]} onInput={(event) => set({ [field]: (event.target as HTMLTextAreaElement).value })} />
              : <input id={id} class={k.input} maxLength={max} disabled={!editor} value={form[field]} onInput={(event) => set({ [field]: (event.target as HTMLInputElement).value })} />}
            {differs && <span class={k.hint}>{t('kb.hints.standard', { value: (Array.isArray(std[field]) ? (std[field] as string[]).join(', ') : String(std[field] ?? '')) || '—' })}</span>}
          </div>
        );
      })}
      <div class={k.field}>
        <span class={k.label}>{t('kb.hints.image')}</span>
        {form.image ? <HintImage image={form.image} /> : <span class={k.hint}>{t('kb.hints.noImage')}</span>}
        {editor && (
          <div class={k.actions}>
            <label class={k.radio}>
              <input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading} aria-label={t('kb.hints.upload')}
                onChange={(event) => { const input = event.target as HTMLInputElement; void upload(input.files?.[0]); input.value = ''; }} />
            </label>
            {form.image && <Button variant="quiet" size="sm" onClick={() => set({ image: null })}>{t('kb.hints.removeImage')}</Button>}
          </div>
        )}
        <span class={k.hint}>{t('kb.hints.imageHint')}</span>
      </div>
      {problem && <p class={k.error} role="alert">{t(problem)}</p>}
      {editor && (
        <div class={k.actions}>
          <Button variant="primary" disabled={!dirty && row !== null && only === (state.overrides.added.find((item) => item.id === row.id)?.only ?? '')} onClick={() => void save()}>{t('kb.hints.save')}</Button>
          {row && !custom && own && (own.all || own.full || own.lite) && <Button onClick={() => setConfirm('reset')}>{t('kb.hints.reset')}</Button>}
          {row && !custom && <Button variant="quiet" onClick={() => void onSaved(withHidden(state.overrides, row.id, true), t('kb.hints.hidden'))}>{t('kb.hints.hide')}</Button>}
          {row && custom && <Button variant="danger" onClick={() => setConfirm('delete')}>{t('kb.hints.delete')}</Button>}
        </div>
      )}
      <Sheet open={confirm !== null} onClose={() => setConfirm(null)} title={confirm === 'reset' ? t('kb.hints.resetTitle') : t('kb.hints.deleteTitle')}>
        <p class={sheetStyles.text}>{confirm === 'reset' ? t('kb.hints.resetText', { title: row?.screen.title ?? '' }) : t('kb.hints.deleteText', { title: row?.screen.title ?? '' })}</p>
        <div class={sheetStyles.actions}>
          <Button variant="quiet" onClick={() => setConfirm(null)}>{t('kb.cancel')}</Button>
          <Button variant="danger" onClick={() => {
            const what = confirm; setConfirm(null);
            if (row && what === 'reset') void onSaved(withReset(state.overrides, row.id), t('kb.hints.resetDone'));
            if (row && what === 'delete') void onSaved(withoutOwn(state.overrides, row.id), t('kb.hints.deleted'));
          }}>{confirm === 'reset' ? t('kb.hints.resetConfirm') : t('kb.hints.deleteConfirm')}</Button>
        </div>
      </Sheet>
    </section>
  );
}

/**
 * «Подсказки по кабинету Bedolaga» (6.6): выключатель и вид кабинета рядом со
 * списком экранов; редактор — на странице, «Вернуть стандартное» у поля,
 * «Скрыть» с «Отменить», «Удалить…» и «Сбросить…» — вторым ярусом.
 */
export function HintsPanel(): JSX.Element {
  const [state, setState] = useState<HintsState | null | 'error'>(null);
  const [chosen, setChosen] = useState<string | 'new' | null>(null);
  const [dirty, setDirty] = useState(false);
  const [ask, setAsk] = useState<string | 'new' | null | undefined>(undefined);
  const load = async (): Promise<void> => {
    try { setState(await getJson<HintsState>('/api/interface-kb', token())); } catch { setState('error'); }
  };
  useEffect(() => { void load(); }, []);
  if (state === null) return <div class={k.skeleton} key="skeleton" aria-hidden="true" />;
  if (state === 'error') return <p class={k.error} role="alert">{t('kb.loadFailed')} <Button variant="link" size="sm" onClick={() => void load()}>{t('live.retry')}</Button></p>;
  const mode = state.effectiveMode;
  const rows = hintRows(state, mode);
  const row = chosen && chosen !== 'new' ? rows.find((item) => item.id === chosen) ?? null : null;
  const editor = can('knowledge:manage');
  const desktop = isDesktop.value;
  const pick = (id: string | 'new' | null): void => { if (dirty) setAsk(id); else { setChosen(id); setDirty(false); } };

  const put = async (next: HintOverrides, text: string, undo = true): Promise<boolean> => {
    const before = state.overrides;
    try {
      await sendJson('/api/interface-kb/overrides', token(), next, { method: 'PUT' });
    } catch {
      showToast({ kind: 'error', ttl: null, text: t('kb.hints.saveFailed') });
      return false;
    }
    setDirty(false);
    await load();
    if (undo) undoToast(text, () => { void put(before, t('kb.hints.undone'), false); }, t('kb.undo'));
    else showToast({ text });
    return true;
  };
  const setSetting = async (values: Record<string, unknown>, before: Record<string, unknown>, text: string, undo = true): Promise<void> => {
    try { await sendJson('/api/settings', token(), values); } catch { showToast({ kind: 'error', ttl: null, text: t('kb.hints.saveFailed') }); return; }
    await load();
    if (undo) undoToast(text, () => { void setSetting(before, values, t('kb.hints.undone'), false); }, t('kb.undo'));
    else showToast({ text });
  };
  const detected = state.setting === 'auto' && state.detected
    ? t('kb.hints.detected', { mode: t(MODE_LABEL[state.detected.mode]) })
    : state.setting === 'auto' ? t('kb.hints.unknown', { mode: t(MODE_LABEL[mode]) }) : t('kb.hints.manual', { mode: t(MODE_LABEL[mode]) });

  const showList = desktop || chosen === null;
  return (
    <div class={k.panel}>
      <p class={k.muted}>{detected}</p>
      <label class={k.toggle}>
        <input type="checkbox" checked={state.enabled} disabled={!can('setting:bedolagaInterfaceKb')}
          onChange={(event) => {
            const on = (event.target as HTMLInputElement).checked;
            void setSetting({ bedolagaInterfaceKb: on }, { bedolagaInterfaceKb: !on }, on ? t('kb.hints.onDone') : t('kb.hints.offDone'));
          }} />
        <span>{t('kb.hints.uses')}</span>
      </label>
      <fieldset class={k.radios}>
        <legend>{t('kb.hints.view')}</legend>
        {(['auto', 'full', 'lite'] as const).map((value) => (
          <label key={value} class={k.radio}>
            <input type="radio" name="hint-mode" checked={state.setting === value} disabled={!can('setting:bedolagaInterfaceMode')}
              onChange={() => void setSetting({ bedolagaInterfaceMode: value }, { bedolagaInterfaceMode: state.setting }, t('kb.hints.viewDone'))} />
            {value === 'auto' ? t('kb.hints.auto') : t(MODE_LABEL[value])}
          </label>
        ))}
      </fieldset>
      {!state.shipped && <p class={k.muted}>{t('kb.hints.noShipped')}</p>}
      <div class={k.hints}>
        {showList && (
          <div class={k.panel}>
            {rows.length === 0 ? <p class={k.muted}>{t('kb.hints.empty')}</p> : (
              <ul class={k.list} aria-label={t('kb.hints.screens')}>
                {rows.map((item) => (
                  <li key={item.id} class={k.templateRow}>
                    <button type="button" class={k.item} disabled={item.hidden} aria-current={item.id === chosen ? 'true' : undefined} onClick={() => pick(item.id)}>
                      <span class={k.itemTitle}>{item.screen.title}</span>
                      <span class={k.itemMeta}>
                        {item.hidden ? t('kb.hints.tagHidden') : item.custom ? t('kb.hints.tagOwn') : item.edited ? t('kb.hints.tagEdited') : t('kb.hints.tagStandard')}
                      </span>
                    </button>
                    {item.hidden && editor && (
                      <Button variant="quiet" size="sm" onClick={() => void put(withHidden(state.overrides, item.id, false), t('kb.hints.returned'), false)}>{t('kb.hints.return')}</Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {editor && <div><Button icon="plus" onClick={() => pick('new')}>{t('kb.hints.add')}</Button></div>}
          </div>
        )}
        {chosen !== null && (chosen === 'new' || row) && (
          <div class={k.panel}>
            {!desktop && <Button variant="link" onClick={() => pick(null)}>← {t('kb.hints.screens')}</Button>}
            <Editor key={`${chosen}:${mode}`} state={state} row={row} mode={mode} onDirty={setDirty}
              onSaved={async (next, text) => { const ok = await put(next, text); if (ok && chosen === 'new') setChosen(null); return ok; }} />
          </div>
        )}
      </div>
      <Sheet open={ask !== undefined} onClose={() => setAsk(undefined)} title={t('kb.leave.title')}>
        <p class={sheetStyles.text}>{t('kb.hints.leave')}</p>
        <div class={sheetStyles.actions}>
          <Button variant="quiet" onClick={() => setAsk(undefined)}>{t('kb.leave.stay')}</Button>
          <Button variant="primary" onClick={() => { const next = ask; setAsk(undefined); setDirty(false); setChosen(next ?? null); }}>{t('kb.leave.discard')}</Button>
        </div>
      </Sheet>
    </div>
  );
}
