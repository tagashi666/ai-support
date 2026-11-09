import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { InboxItem, ThreadHead } from '@shared/api-types';
import { t } from '@/i18n/ru';
import { duration } from '@/lib/format/format';
import { getJson, readToken } from '@/lib/live/api';
import { connection } from '@/lib/live/store';
import { isDesktop } from '@/lib/media';
import { now } from '@/lib/store/state';
import {
  drafts, draftTick, FILE_MAX_BYTES, FILES_MAX, isDangerous, permissions, resolve, saveNote, sendFile, sendReply,
  SEND_UNDO_OWN_MS, typingKey, waitClient,
} from '@/lib/workspace/actions';
import type { LocalDraft } from '@/lib/workspace/drafts';
import { availability } from '@/lib/workspace/registry';
import { threads } from '@/lib/workspace/thread';
import { showToast } from '@/lib/actions/toasts';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import s from '@/features/thread/thread.module.css';
import { sendSuggestion } from './WorkDraft';
import w from './workspace.module.css';

const THREE_HOURS = 3 * 60 * 60_000;

interface Template { id: number; shortcut: string; title: string; body: string }

/**
 * Поле ответа (6.3.3): «Ответ │ Заметка», цитата, шаблоны, файлы. Шрифт
 * 16 px, поле растёт до 40% высоты. Enter — перенос, ⌘↵ — отправить; при
 * пустом поле ⌘↵ отправляет черновик «Уверен» или «Проверьте». Черновик
 * хранится на устройстве. Печать в «Ответе» останавливает помощника, но не
 * закрепляет диалог.
 */
export function WorkComposer({ id, head, colleague }: { id: number; item: InboxItem; head: ThreadHead; colleague: string | null }): JSX.Element {
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const tick = draftTick.value;
  const [draft, setDraftState] = useState<LocalDraft>(() => drafts.get(id));
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [templateQuery, setTemplateQuery] = useState('');
  const [sheet, setSheet] = useState<'templates' | { dangerous: File[] } | null>(null);
  const at = now.value;
  const perms = permissions.value;
  const canReply = availability('reply.send', perms) === 'show';
  const canNote = availability('conv.note', perms) === 'show';
  const canFiles = availability('conv.attach', perms) === 'show' && head.attachments;
  const canTemplates = availability('conv.template', perms) === 'show';
  const noteOnly = colleague !== null || !canReply;
  const mode: 'reply' | 'note' = noteOnly ? 'note' : draft.mode;
  const closed = head.window.applies && !head.window.open;
  const offline = connection.value === 'offline';
  const suggestion = threads.value.get(id)?.suggestion ?? null;

  // Чужие изменения черновика («Править», «Вернуть в поле», цитата из ленты) — в поле.
  const wantFocus = useRef(false);
  useEffect(() => {
    if (tick > 0) wantFocus.current = true;
    setDraftState(drafts.get(id));
  }, [id, tick]);
  // После «Править» и «Вернуть в поле» — фокус в поле, курсор в конец.
  useEffect(() => {
    const el = area.current;
    if (!wantFocus.current || !el) return;
    wantFocus.current = false;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [draft]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [draft.text, mode]);

  const update = (change: Partial<LocalDraft>): void => setDraftState(drafts.set(id, change));

  const openTemplates = (): void => {
    setSheet('templates');
    setTemplateQuery('');
    if (!templates) {
      void getJson<{ templates: Template[] }>('/api/templates', readToken() ?? '')
        .then((response) => setTemplates(response.templates)).catch(() => setTemplates([]));
    }
  };

  const insertTemplate = (template: Template): void => {
    setSheet(null);
    const text = draft.text.replace(/^\/\S*$/, '');
    update({ text: text.trim() ? `${text}${text.endsWith('\n') ? '' : '\n'}${template.body}` : template.body });
    requestAnimationFrame(() => area.current?.focus());
  };

  const submit = async (): Promise<void> => {
    if (mode === 'note') {
      if (!canNote) return;
      if (await saveNote(id, draft.text)) { drafts.clear(id); setDraftState(drafts.get(id)); }
      return;
    }
    if (closed || offline) return;
    if (!draft.text.trim()) {
      if (suggestion && suggestion.level !== 'unsure') sendSuggestion(id);
      return;
    }
    const fromSuggestion = draft.fromSuggestion;
    const edited = fromSuggestion !== null && suggestion?.id === fromSuggestion ? draft.text.trim() !== suggestion.text.trim() : true;
    sendReply(id, {
      text: draft.text,
      suggestionId: fromSuggestion,
      edited,
      quote: draft.quote,
      delay: SEND_UNDO_OWN_MS,
    });
    drafts.clear(id);
    setDraftState(drafts.get(id));
  };

  const addFiles = (list: FileList | File[] | null): void => {
    if (!list || !canFiles) return;
    const files = [...list].slice(0, FILES_MAX);
    if (list.length > FILES_MAX) showToast({ text: t('file.tooMany', { n: FILES_MAX }), kind: 'error', ttl: null });
    const ok = files.filter((file) => {
      if (file.size <= FILE_MAX_BYTES) return true;
      showToast({ text: t('file.tooBig', { name: file.name }), kind: 'error', ttl: null });
      return false;
    });
    const dangerous = ok.filter((file) => isDangerous(file.name));
    for (const file of ok.filter((item) => !isDangerous(item.name))) void sendFile(id, file, { dangerousConfirmed: false, quote: draft.quote });
    if (dangerous.length) setSheet({ dangerous });
  };

  if (mode === 'reply' && closed) {
    return (
      <section class={s.windowCard} aria-label={t('window.closedTitle')}>
        <p class={s.windowTitle}>{t('window.closedTitle')}</p>
        <p class={s.windowText}>{t('window.closedText')}</p>
        <div class={s.windowActions}>
          {canNote && <Button variant="secondary" size="sm" icon="lock" onClick={() => update({ mode: 'note' })}>{t('window.note')}</Button>}
          <Button variant="secondary" size="sm" onClick={() => waitClient(id)}>{t('window.waitClient')}</Button>
          <Button variant="secondary" size="sm" icon="check" onClick={() => resolve(id)}>{t('window.resolve')}</Button>
        </div>
        <p class={s.windowFoot}>{t('window.comesBack')}</p>
      </section>
    );
  }

  if (!canReply && !canNote) return <p class={s.notice}>{t('composer.readOnly')}</p>;

  const closesAt = head.window.applies ? head.window.closes_at : null;
  const left = closesAt !== null ? closesAt - at : null;
  const hint = mode === 'note' ? t('composer.noteHint')
    : offline ? t('composer.offline')
      : left !== null && left > 0 ? t('composer.windowLeft', { left: duration(left) }) : '';
  const canSubmit = mode === 'note' ? canNote && draft.text.trim().length > 0
    : !closed && !offline && (draft.text.trim().length > 0 || (suggestion !== null && suggestion.level !== 'unsure' && suggestion.text.trim().length > 0));

  const filtered = (templates ?? []).filter((template) => {
    const q = templateQuery.trim().toLocaleLowerCase('ru');
    return !q || template.title.toLocaleLowerCase('ru').includes(q) || template.shortcut.toLocaleLowerCase('ru').includes(q.replace(/^\//, ''));
  });
  const dangerFiles = sheet && typeof sheet === 'object' ? sheet.dangerous : null;

  return (
    <div class={s.composer} data-mode={mode}
      onDragOver={(event) => { if (canFiles && mode === 'reply') event.preventDefault(); }}
      onDrop={(event) => { if (!canFiles || mode !== 'reply') return; event.preventDefault(); addFiles(event.dataTransfer?.files ?? null); }}>
      {colleague !== null && <p class={s.notice}>{t('composer.colleagueLeads', { name: colleague })}</p>}
      {!canReply && colleague === null && <p class={s.notice}>{t('composer.noReplyRight')}</p>}
      <div class={w.composerBar}>
        <div class={s.modes} role="tablist" aria-label={t('composer.modes')}>
          <button type="button" role="tab" class={s.mode} aria-selected={mode === 'reply'} disabled={noteOnly}
            tabIndex={mode === 'reply' ? 0 : -1} onClick={() => update({ mode: 'reply' })}>
            {noteOnly ? t('composer.replyBusy') : t('composer.reply')}
          </button>
          {canNote && (
            <button type="button" role="tab" class={s.mode} aria-selected={mode === 'note'} tabIndex={mode === 'note' ? 0 : -1}
              onClick={() => update({ mode: 'note' })}>
              <Icon name="lock" size={14} />{t('composer.note')}
            </button>
          )}
        </div>
        {mode === 'reply' && (
          <div class={w.tools}>
            {canTemplates && <Button variant="quiet" size="sm" icon="note" onClick={openTemplates}>{t('composer.templates')}</Button>}
            {canFiles ? (
              <Button variant="quiet" size="sm" icon="plus" onClick={() => fileInput.current?.click()} title={t('composer.attachHint')}>{t('composer.attach')}</Button>
            ) : !head.attachments ? <span class={w.toolNote}>{t('composer.textOnly')}</span> : null}
            <input ref={fileInput} type="file" multiple hidden onChange={(event) => {
              const input = event.target as HTMLInputElement;
              addFiles(input.files);
              input.value = '';
            }} />
          </div>
        )}
      </div>
      {mode === 'reply' && draft.quote && (
        <p class={w.quoteLine}>
          <span>↩ {t('composer.quote', { text: draft.quote.excerpt })}</span>
          <Button variant="quiet" size="sm" icon="close" label={t('composer.quoteRemove')} onClick={() => update({ quote: null })} />
        </p>
      )}
      <div class={s.inputRow}>
        <textarea
          ref={area}
          class={s.input}
          rows={1}
          value={draft.text}
          placeholder={mode === 'note' ? t('composer.notePlaceholder') : suggestion && suggestion.level !== 'unsure' && isDesktop.value ? t('composer.placeholderDraft') : t('composer.placeholder')}
          aria-label={mode === 'note' ? t('composer.notePlaceholder') : t('composer.placeholder')}
          onInput={(event) => {
            const text = (event.target as HTMLTextAreaElement).value;
            update({ text });
            if (mode === 'reply' && text.trim()) typingKey(id);
            if (mode === 'reply' && canTemplates && text === '/') openTemplates();
          }}
          onPaste={(event) => {
            const files = event.clipboardData?.files;
            if (files && files.length && canFiles && mode === 'reply') { event.preventDefault(); addFiles(files); }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); return; }
            if (event.key === 'Escape' && draft.quote) { event.preventDefault(); update({ quote: null }); return; }
            if (event.code === 'KeyU' && event.shiftKey && (event.metaKey || event.ctrlKey) && canFiles) { event.preventDefault(); fileInput.current?.click(); }
          }}
        />
        <button type="button" class={s.send} data-mode={mode} disabled={!canSubmit}
          aria-label={mode === 'note' ? t('composer.saveNote') : t('composer.send')}
          title={mode === 'note' ? t('composer.saveNote') : offline ? t('composer.offline') : t('composer.sendHint')}
          onClick={() => { void submit(); }}>
          <Icon name={mode === 'note' ? 'check' : 'send'} size={22} />
        </button>
      </div>
      {hint && <p class={s.hint} data-tone={mode === 'reply' && (offline || (left !== null && left > 0 && left < THREE_HOURS)) ? 'attention' : undefined}>{hint}</p>}

      <Sheet open={sheet === 'templates'} onClose={() => setSheet(null)} title={t('composer.templates')}>
        <label class={w.templateSearch}>
          <Icon name="search" size={18} />
          <input type="search" value={templateQuery} placeholder={t('templates.search')} aria-label={t('templates.search')} autoFocus
            onInput={(event) => setTemplateQuery((event.target as HTMLInputElement).value)} />
        </label>
        {templates === null ? <p class={sheetStyles.text}>{t('templates.loading')}</p>
          : filtered.length === 0 ? <p class={sheetStyles.text}>{t('templates.empty')}</p> : (
            <div role="menu" aria-label={t('composer.templates')} class={w.templateList}>
              {filtered.map((template) => (
                <button key={template.id} type="button" role="menuitem" class={w.template} onClick={() => insertTemplate(template)}>
                  <span class={w.templateTitle}>{template.title} <span class={w.templateShortcut}>/{template.shortcut}</span></span>
                  <span class={w.templateBody}>{template.body}</span>
                </button>
              ))}
            </div>
          )}
      </Sheet>

      <Sheet open={dangerFiles !== null} onClose={() => setSheet(null)} title={t('file.dangerTitle', { name: dangerFiles?.map((file) => file.name).join(', ') ?? '' })}>
        <p class={sheetStyles.text}>{t('file.dangerText')}</p>
        <div class={sheetStyles.actions}>
          <Button variant="secondary" onClick={() => setSheet(null)} autoFocus>{t('sheet.cancel')}</Button>
          <Button variant="danger" onClick={() => {
            const files = dangerFiles ?? [];
            setSheet(null);
            for (const file of files) void sendFile(id, file, { dangerousConfirmed: true, quote: draft.quote });
          }}>{t('file.dangerYes')}</Button>
        </div>
      </Sheet>
    </div>
  );
}
