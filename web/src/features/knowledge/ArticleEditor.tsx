import type { JSX } from 'preact';
import { Collapse } from '@/ui/Collapse';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { confidenceLevel } from '@shared/confidence';
import type { KbConflict, KbDocResponse } from '@shared/api-types';
import { t } from '@/i18n/ru';
import { showToast, undoToast } from '@/lib/actions/toasts';
import { settings, tryQuestion, type TryResult } from '@/lib/assistant/store';
import { clock } from '@/lib/format/format';
import {
  articleRoute, composeDoc, diffStats, dropLocalDraft, lineDiff, normalizeDoc, readLocalDraft, saveLocalDraft, splitDoc, type DocFields,
} from '@/lib/knowledge/model';
import {
  createDraft, loadIdeas, loadKb, pendingIdeas, prefill, publishDraft, readArticle, removeArticle, rights, saveDraft, undoPublish,
  type WriteOutcome,
} from '@/lib/knowledge/store';
import { levelLabel } from '@/lib/labels';
import { bootstrap } from '@/lib/live/store';
import { href, navigate, setLeaveGuard, type Route } from '@/lib/router';
import { Button } from '@/ui/Button';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import k from './knowledge.module.css';

const LIST: Route = { name: 'section', key: 'knowledge' };

interface Loaded {
  kb: KbDocResponse | null;
  draft: KbDocResponse | null;
}

/** «было → стало» строками с цветом и знаком (цвет не единственный признак, 8.7). */
function DiffView({ before, after }: { before: string; after: string }): JSX.Element {
  const ops = useMemo(() => lineDiff(before, after), [before, after]);
  return (
    <div class={k.diff} role="group" aria-label={t('kb.diff.title')}>
      {ops.filter((op, index) => op.kind !== 'same' || ops[index - 1]?.kind !== 'same' || ops[index + 1]?.kind !== 'same').map((op, index) => (
        <div key={index} data-kind={op.kind}>{op.kind === 'add' ? '+ ' : op.kind === 'del' ? '− ' : '  '}{op.line || ' '}</div>
      ))}
    </div>
  );
}

function DiffLine({ before, after }: { before: string; after: string }): JSX.Element | null {
  const [shown, setShown] = useState(false);
  const stats = diffStats(lineDiff(before, after));
  if (!stats.added && !stats.removed) return <p class={k.muted}>{t('kb.diff.none')}</p>;
  return (
    <div class={k.field}>
      <div class={k.diffLine}>
        <span>{t('kb.diff.summary', { added: stats.added, removed: stats.removed })}</span>
        <Button variant="link" size="sm" aria-expanded={shown} onClick={() => setShown(!shown)}>{shown ? t('kb.diff.hide') : t('kb.diff.show')}</Button>
      </div>
      <Collapse open={shown}><DiffView before={before} after={after} /></Collapse>
    </div>
  );
}

/** «Проверить помощника» (6.6): /api/ai/try ищет по опубликованному — об этом честная строка. */
function CheckAssistant({ title }: { title: string }): JSX.Element {
  const [question, setQuestion] = useState(title);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (): Promise<void> => {
    if (!question.trim() || busy) return;
    setBusy(true); setError(null);
    try { setResult(await tryQuestion(question.trim())); } catch { setResult(null); setError(t('error.network')); }
    setBusy(false);
  };
  const threshold = settings.value?.minConfidence ?? bootstrap.value?.assistant.minConfidence ?? 0.7;
  const level = result ? confidenceLevel({
    score: result.draft.confidence, threshold, hasSources: result.usedSources.length > 0, askedHuman: result.draft.needsHuman,
    gatePassed: result.verdict.action === 'auto', hasText: Boolean(result.draft.reply.trim()),
  }) : null;
  return (
    <section class={k.check} aria-label={t('kb.check.title')}>
      <h2 class={k.subhead}>{t('kb.check.title')}</h2>
      <form class={k.checkRow} onSubmit={(event) => { event.preventDefault(); void run(); }}>
        <label class={k.field}>
          <span class={k.label}>{t('try.question')}</span>
          <input class={k.input} value={question} maxLength={2000} onInput={(event) => setQuestion((event.target as HTMLInputElement).value)} />
        </label>
        <Button type="submit" variant="secondary" disabled={busy || !question.trim()}>{busy ? t('try.running') : t('try.run')}</Button>
      </form>
      {error && <p class={k.error} role="alert">{error}</p>}
      {result && level && (
        <div class={k.field} aria-live="polite">
          <blockquote class={k.reply}>{result.draft.reply.trim() || t('try.noReply')} · {levelLabel(level)}</blockquote>
          {result.sources.length > 0 && (
            <ul class={k.sources} aria-label={t('try.basedOn')}>
              {result.sources.map((source) => (
                <li key={source} data-used={result.usedSources.includes(source) ? 'true' : 'false'}>
                  {source}{result.usedSources.includes(source) && ` · ${t('try.used')}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p class={k.hint}>{t('kb.check.published')}</p>
    </section>
  );
}

/**
 * Редактор статьи (6.6) — отдельная страница. «Сохранить черновик» пишет
 * черновик (помощник его не видит), «Опубликовать…» — лист с «было → стало»
 * и тост «Опубликовано · Отменить». Чужая правка — 409 с выбором, уход с
 * несохранённым — вопрос; текст ещё и в черновике на устройстве (7.8).
 */
export function ArticleEditor({ name }: { name: string | null }): JSX.Element {
  const r = rights.value;
  const localKey = name ?? 'new';
  const [loaded, setLoaded] = useState<Loaded | 'loading' | 'missing' | 'error'>(name ? 'loading' : { kb: null, draft: null });
  const [fields, setFields] = useState<DocFields>({ title: '', body: '' });
  /** Текст, от которого начали править (нормализован): по нему — «есть несохранённое». */
  const [base, setBase] = useState('');
  /** Версия черновика для expectedVersion: null — черновика нет, undefined — не знаем (нет права review). */
  const [draftVersion, setDraftVersion] = useState<string | null | undefined>(null);
  const [restored, setRestored] = useState<number | null>(null);
  const [conflict, setConflict] = useState<KbConflict | null>(null);
  const [compare, setCompare] = useState(false);
  const [leave, setLeave] = useState<Route | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const text = composeDoc(fields);
  const dirty = name === null ? Boolean(fields.title.trim() || fields.body.trim()) : loaded !== 'loading' && text !== base;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Загрузка: опубликованная, черновик (только с review) и текст с устройства.
  useEffect(() => {
    let alive = true;
    const start = (from: Loaded): void => {
      const source = from.draft?.text ?? from.kb?.text ?? '';
      const startText = normalizeDoc(source);
      const local = readLocalDraft(localKey, Date.now());
      const version = r.review ? from.draft?.version ?? null : undefined;
      setLoaded(from);
      setBase(name === null ? '' : startText);
      setDraftVersion(version);
      if (name === null && prefill.peek()) {
        setFields(prefill.peek()!);
        prefill.value = null;
      } else if (local && composeDoc(local) !== startText) {
        setFields({ title: local.title, body: local.body });
        setRestored(local.at);
        // Сервер с тех пор изменился: сохранение упрётся в 409 и покажет выбор.
        if (name !== null && r.review && local.base !== (from.draft?.version ?? null)) setDraftVersion(local.base);
      } else {
        setFields(splitDoc(source));
      }
    };
    if (name === null) { start({ kb: null, draft: null }); return; }
    void (async () => {
      const [kbDoc, draftDoc] = await Promise.all([readArticle('kb', name), r.review ? readArticle('draft', name) : Promise.resolve(null)]);
      if (!alive) return;
      if (kbDoc === 'error' || draftDoc === 'error') { setLoaded('error'); return; }
      if (!kbDoc && !draftDoc) { setLoaded('missing'); return; }
      start({ kb: kbDoc, draft: draftDoc });
    })();
    return () => { alive = false; };
  }, [name]);

  // Черновик на устройстве — на каждый ввод (с задержкой).
  useEffect(() => {
    if (loaded === 'loading' || loaded === 'missing' || loaded === 'error') return;
    const timer = setTimeout(() => {
      if (dirty) saveLocalDraft(localKey, { ...fields, base: draftVersion ?? null, at: Date.now() });
      else dropLocalDraft(localKey);
    }, 400);
    return () => clearTimeout(timer);
  }, [fields, dirty]);

  // Уход с несохранённым: вопрос внутри панели и браузерный — при закрытии.
  useEffect(() => {
    setLeaveGuard((next) => {
      if (!dirtyRef.current) return true;
      setLeave(next);
      return false;
    });
    const beforeUnload = (event: BeforeUnloadEvent): void => { if (dirtyRef.current) event.preventDefault(); };
    addEventListener('beforeunload', beforeUnload);
    return () => { setLeaveGuard(null); removeEventListener('beforeunload', beforeUnload); };
  }, []);

  const go = (target: Route): void => navigate(target, false, true);
  const back = (): void => navigate(LIST);

  if (loaded === 'loading') return <div class={k.screen}><div class={k.inner}><div class={k.skeleton} key="skeleton" aria-hidden="true" /></div></div>;
  if (loaded === 'missing' || loaded === 'error') {
    return (
      <div class={k.screen}>
        <div class={k.inner}>
          <h1 class={k.title}>{t('nav.knowledge')}</h1>
          <p class={loaded === 'error' ? k.error : k.muted} role={loaded === 'error' ? 'alert' : undefined}>
            {loaded === 'error' ? t('kb.loadFailed') : t('kb.editor.missing')}
          </p>
          <div><Button onClick={back}>{t('kb.editor.toList')}</Button></div>
        </div>
      </div>
    );
  }

  const published = loaded.kb;
  const hasDraft = draftVersion !== null && draftVersion !== undefined;
  const ideaHere = name !== null && pendingIdeas.value.some((row) => row.file_name === name);
  const state = name === null ? t('kb.state.new')
    : published ? (hasDraft || dirty ? t('kb.state.edited') : t('kb.state.published')) : t('kb.state.draft');
  const valid = Boolean(fields.title.trim() && fields.body.trim());

  /** Итог записи: ok — запомнить версию, conflict — лист выбора, error — строка. */
  const settle = (result: WriteOutcome): boolean => {
    if (result.kind === 'conflict') { setConflict(result.conflict); return false; }
    if (result.kind === 'error') { setError(result.text); return false; }
    return true;
  };

  /** Сохранить черновик; true — сохранено. expected переопределяет версию («Сохранить мой текст поверх»). */
  const save = async (expected?: string | null, quiet = false): Promise<string | null> => {
    setError(null);
    if (!valid) { setError(t('kb.editor.needBoth')); return null; }
    setBusy(true);
    try {
      if (name === null) {
        const result = await createDraft(fields);
        if (!settle(result) || result.kind !== 'ok') return null;
        dropLocalDraft('new');
        dirtyRef.current = false;
        void loadKb(); void loadIdeas();
        if (!r.review) { showToast({ text: t('kb.saved.forLead') }); go(LIST); return null; }
        go(articleRoute(result.result.name));
        showToast({ text: t('kb.saved.draft') });
        return result.result.name;
      }
      const result = await saveDraft(name, fields, expected !== undefined ? expected : r.review ? draftVersion ?? null : undefined);
      if (!settle(result) || result.kind !== 'ok') return null;
      setDraftVersion(r.review ? result.result.version : undefined);
      setBase(text);
      setRestored(null);
      dropLocalDraft(localKey);
      void loadKb();
      if (!r.review) { dirtyRef.current = false; showToast({ text: t('kb.saved.forLead') }); go(LIST); return null; }
      if (!quiet) showToast({ text: t('kb.saved.draft') });
      return result.result.version;
    } finally {
      setBusy(false);
    }
  };

  const publish = async (): Promise<void> => {
    if (name === null) return;
    setError(null);
    let version = draftVersion ?? null;
    if (dirty || !hasDraft) {
      version = await save(undefined, true);
      if (!version) { setPublishing(false); return; }
    }
    setBusy(true);
    const result = await publishDraft(name, version!);
    setBusy(false);
    setPublishing(false);
    if (!settle(result) || result.kind !== 'ok') return;
    const before = result.result.previous;
    const textNow = text;
    setLoaded({ kb: { name, text: textNow, version: result.result.version, changed_at: Date.now() }, draft: null });
    setDraftVersion(null);
    setBase(textNow);
    dropLocalDraft(localKey);
    void loadKb(); void loadIdeas();
    undoToast(t('kb.published'), () => {
      void undoPublish(name, textNow, before).then((ok) => {
        if (!ok) { showToast({ kind: 'error', ttl: null, text: t('kb.undoFailed') }); return; }
        showToast({ text: t('kb.unpublished') });
        void loadKb();
        if (before === null) go(LIST);
        else void readArticle('draft', name).then((draft) => {
          if (draft && draft !== 'error') {
            setLoaded({ kb: { name, text: before, version: '', changed_at: Date.now() }, draft });
            setDraftVersion(draft.version);
          }
        });
      });
    }, t('kb.undo'));
  };

  const remove = async (): Promise<void> => {
    if (name === null) return;
    setBusy(true);
    const result = await removeArticle(name, published ? published.version : null, hasDraft ? draftVersion! : null);
    setBusy(false);
    setDeleting(false);
    if (!settle(result)) return;
    dropLocalDraft(localKey);
    dirtyRef.current = false;
    void loadKb(); void loadIdeas();
    showToast({ text: published ? t('kb.deleted') : t('kb.draftDeleted') });
    go(LIST);
  };

  /** «Отбросить правки» у опубликованной: черновик удаляется, остаётся опубликованный текст. */
  const discardDraft = async (): Promise<void> => {
    if (name === null || !published) return;
    if (hasDraft) {
      setBusy(true);
      const result = await removeArticle(name, null, draftVersion!);
      setBusy(false);
      if (!settle(result)) return;
    }
    setDraftVersion(null);
    setFields(splitDoc(published.text));
    setBase(normalizeDoc(published.text));
    dropLocalDraft(localKey);
    setRestored(null);
    void loadKb();
  };

  const resolveConflict = async (choice: 'mine' | 'theirs'): Promise<void> => {
    const current = conflict;
    if (!current) return;
    setConflict(null); setCompare(false);
    if (choice === 'mine') { await save(current.version); return; }
    const theirs = current.text ?? '';
    setFields(splitDoc(theirs));
    setBase(normalizeDoc(theirs));
    setDraftVersion(current.version);
    dropLocalDraft(localKey);
    setRestored(null);
  };

  const conflictText = conflict
    ? conflict.changed_by
      ? t('kb.conflict.by', { name: conflict.changed_by, time: clock(conflict.changed_at ?? Date.now()) })
      : t('kb.conflict.anon', { time: clock(conflict.changed_at ?? Date.now()) })
    : '';

  return (
    <div class={k.screen}>
      <div class={k.inner}>
        <a class={k.back} href={href(LIST)} onClick={(event) => { event.preventDefault(); back(); }}>← {t('nav.knowledge')}</a>
        <div class={k.editorHead}>
          <div>
            <h1 class={k.title}>{fields.title.trim() || (name === null ? t('kb.new') : t('kb.editor.untitled'))}</h1>
            <span class={k.state} role="status">{state}{ideaHere && ` · ${t('kb.state.idea')}`}{dirty && ` · ${t('kb.editor.unsaved')}`}</span>
          </div>
          {r.manage && (
            <div class={k.actions}>
              <Button variant={r.publish ? 'secondary' : 'primary'} disabled={busy || !dirty} onClick={() => void save()}>{t('kb.saveDraft')}</Button>
              {r.publish && name !== null && (
                <Button variant="primary" disabled={busy || !valid || (!dirty && !hasDraft)} onClick={() => setPublishing(true)}>{t('kb.publish')}</Button>
              )}
            </div>
          )}
        </div>
        {restored !== null && (
          <div class={k.notice} role="status">
            <span>{t('kb.editor.restored', { time: clock(restored) })}</span>
            <Button variant="link" size="sm" onClick={() => {
              const source = loaded.draft?.text ?? loaded.kb?.text ?? '';
              setFields(splitDoc(source)); setDraftVersion(r.review ? loaded.draft?.version ?? null : undefined);
              setRestored(null); dropLocalDraft(localKey);
            }}>{t('kb.editor.dropRestored')}</Button>
          </div>
        )}
        {error && <p class={k.error} role="alert">{error}</p>}
        <label class={k.field}>
          <span class={k.label}>{t('kb.editor.title')}</span>
          <input class={k.input} value={fields.title} maxLength={200} disabled={!r.manage}
            onInput={(event) => setFields({ ...fields, title: (event.target as HTMLInputElement).value })} />
        </label>
        <label class={k.field}>
          <span class={k.label}>{t('kb.editor.body')}</span>
          <textarea class={`${k.textarea} ${k.editorText}`} rows={16} value={fields.body} disabled={!r.manage}
            onInput={(event) => setFields({ ...fields, body: (event.target as HTMLTextAreaElement).value })} />
          <span class={k.hint}>{t('kb.editor.bodyHint')}</span>
        </label>
        {published && r.review && <DiffLine before={normalizeDoc(published.text)} after={text} />}
        <div class={k.actions}>
          {published && r.manage && (hasDraft || dirty) && <Button variant="quiet" disabled={busy} onClick={() => void discardDraft()}>{t('kb.discardEdits')}</Button>}
          {name !== null && r.manage && <Button variant="danger" disabled={busy} onClick={() => setDeleting(true)}>{published ? t('kb.delete') : t('kb.deleteDraft')}</Button>}
        </div>
        {r.tryIt && <CheckAssistant title={fields.title} />}
      </div>

      <Sheet open={publishing} onClose={() => setPublishing(false)} title={t('kb.publishSheet.title')}>
        <p class={sheetStyles.text}>{t('kb.publishSheet.text')}</p>
        <DiffLine before={published ? normalizeDoc(published.text) : ''} after={text} />
        <div class={sheetStyles.actions}>
          <Button variant="quiet" onClick={() => setPublishing(false)}>{t('kb.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void publish()}>{t('kb.publishNow')}</Button>
        </div>
      </Sheet>

      <Sheet open={deleting} onClose={() => setDeleting(false)} title={published ? t('kb.delete') : t('kb.deleteDraft')}>
        <p class={sheetStyles.text}>
          {published ? t('kb.deleteSheet.text', { title: fields.title || name || '' }) : t('kb.deleteSheet.draft', { title: fields.title || name || '' })}
        </p>
        <div class={sheetStyles.actions}>
          <Button variant="quiet" onClick={() => setDeleting(false)}>{t('kb.cancel')}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void remove()}>{t('kb.deleteSheet.confirm')}</Button>
        </div>
      </Sheet>

      <Sheet open={conflict !== null} onClose={() => setConflict(null)} title={t('kb.conflict.title')}>
        <p class={sheetStyles.text}>{conflictText}</p>
        <p class={k.hint}>{t('kb.conflict.safe')}</p>
        <Collapse open={Boolean(compare && conflict)}>{conflict && <DiffView before={normalizeDoc(conflict.text ?? '')} after={text} />}</Collapse>
        <div class={sheetStyles.actions}>
          <Button variant="quiet" aria-expanded={compare} onClick={() => setCompare(!compare)}>{t('kb.conflict.compare')}</Button>
          <Button variant="secondary" onClick={() => void resolveConflict('theirs')}>{t('kb.conflict.theirs')}</Button>
          <Button variant="primary" onClick={() => void resolveConflict('mine')}>{t('kb.conflict.mine')}</Button>
        </div>
      </Sheet>

      <Sheet open={leave !== null} onClose={() => setLeave(null)} title={t('kb.leave.title')}>
        <p class={sheetStyles.text}>{t('kb.leave.text')}</p>
        <div class={sheetStyles.actions}>
          <Button variant="quiet" onClick={() => setLeave(null)}>{t('kb.leave.stay')}</Button>
          <Button variant="secondary" onClick={() => {
            const target = leave; setLeave(null); dropLocalDraft(localKey); dirtyRef.current = false; if (target) go(target);
          }}>{t('kb.leave.discard')}</Button>
          {r.manage && <Button variant="primary" disabled={busy || !valid} onClick={() => {
            const target = leave; setLeave(null);
            void save().then((saved) => { if (saved !== null && target) { dirtyRef.current = false; go(target); } });
          }}>{t('kb.leave.save')}</Button>}
        </div>
      </Sheet>
    </div>
  );
}
