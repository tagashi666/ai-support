import type { JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { saveNote, sendDraft, sendText } from '@/lib/actions/chat';
import { duration } from '@/lib/format/format';
import { composerMode, now, setText, textOf } from '@/lib/store/state';
import type { Chat } from '@/lib/types';
import { Icon } from '@/ui/Icon';
import s from './thread.module.css';

const THREE_HOURS = 3 * 60 * 60_000;

/**
 * Поле ответа (6.3.3): «Ответ │ Заметка» — у заметки жёлтое поле и подпись
 * «Клиент не увидит». Шрифт 16 px (iOS не увеличивает страницу), поле растёт
 * до 40% высоты. Enter — перенос, ⌘↵ — отправить; при пустом поле ⌘↵
 * отправляет черновик «Уверен» или «Проверьте».
 */
export function Composer({ chat, noteOnly, closed }: { chat: Chat; noteOnly: boolean; closed: boolean }): JSX.Element {
  const area = useRef<HTMLTextAreaElement>(null);
  const stored = composerMode.value[chat.id] ?? 'reply';
  const mode = noteOnly ? 'note' : stored;
  const text = textOf(chat.id);
  const at = now.value;

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [text]);

  // «Править» переносит черновик в поле — курсор в конец.
  useLayoutEffect(() => {
    const el = area.current;
    if (el && document.activeElement !== el && text && mode === 'reply') {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [chat.draft === undefined]);

  const setMode = (next: 'reply' | 'note'): void => {
    composerMode.value = { ...composerMode.value, [chat.id]: next };
    requestAnimationFrame(() => area.current?.focus());
  };

  const submit = (): void => {
    if (mode === 'note') { saveNote(chat.id, text); return; }
    if (closed) return;
    if (!text.trim() && chat.draft && chat.draft.level !== 'unsure') { sendDraft(chat.id); return; }
    sendText(chat.id, text);
  };

  const left = chat.windowEndsAt !== undefined ? chat.windowEndsAt - at : null;
  const hint = mode === 'note' ? t('composer.noteHint')
    : left !== null && left > 0 ? t('composer.windowLeft', { left: duration(left) }) : '';
  const hintAttention = mode === 'reply' && left !== null && left > 0 && left < THREE_HOURS;
  const canSubmit = mode === 'note' ? text.trim().length > 0
    : !closed && (text.trim().length > 0 || (chat.draft !== undefined && chat.draft.level !== 'unsure'));

  return (
    <div class={s.composer} data-mode={mode}>
      <div class={s.modes} role="tablist" aria-label={t('composer.modes')}>
        <button type="button" role="tab" class={s.mode} aria-selected={mode === 'reply'} disabled={noteOnly}
          tabIndex={mode === 'reply' ? 0 : -1} onClick={() => setMode('reply')}>
          {noteOnly ? t('composer.replyBusy') : t('composer.reply')}
        </button>
        <button type="button" role="tab" class={s.mode} aria-selected={mode === 'note'}
          tabIndex={mode === 'note' ? 0 : -1} onClick={() => setMode('note')}>
          <Icon name="lock" size={14} />{t('composer.note')}
        </button>
      </div>
      <div class={s.inputRow}>
        <textarea
          ref={area}
          class={s.input}
          rows={1}
          value={text}
          placeholder={mode === 'note' ? t('composer.notePlaceholder') : t('composer.placeholder')}
          aria-label={mode === 'note' ? t('composer.notePlaceholder') : t('composer.placeholder')}
          onInput={(event) => setText(chat.id, (event.target as HTMLTextAreaElement).value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
          }}
        />
        <button
          type="button"
          class={s.send}
          data-mode={mode}
          disabled={!canSubmit}
          aria-label={mode === 'note' ? t('composer.saveNote') : t('composer.send')}
          title={mode === 'note' ? t('composer.saveNote') : t('composer.sendHint')}
          onClick={submit}
        >
          <Icon name={mode === 'note' ? 'check' : 'send'} size={22} />
        </button>
      </div>
      {hint && <p class={s.hint} data-tone={hintAttention ? 'attention' : undefined}>{hint}</p>}
    </div>
  );
}
