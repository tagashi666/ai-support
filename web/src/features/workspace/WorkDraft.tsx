import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { InboxItem, ThreadHead } from '@shared/api-types';
import { t } from '@/i18n/ru';
import { levelLabel } from '@/lib/labels';
import { connection } from '@/lib/live/store';
import { isDesktop } from '@/lib/media';
import { editDraft, permissions, rejectDraft, sendReply, SEND_UNDO_DRAFT_MS } from '@/lib/workspace/actions';
import { availability } from '@/lib/workspace/registry';
import { threads, updateThread } from '@/lib/workspace/thread';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Option, Sheet } from '@/ui/Sheet';
import s from '@/features/thread/thread.module.css';
import w from './workspace.module.css';

/** Причины «Не подходит» (6.3.4): уходят в журнал событий — материал для обучения и итогов. */
const REASONS = [
  ['wrong_fact', 'reject.wrongFact'],
  ['tone', 'reject.tone'],
  ['off_topic', 'reject.offTopic'],
  ['not_in_kb', 'reject.notInKb'],
  ['not_needed', 'reject.notNeeded'],
] as const;

/** Отправить черновик как есть: окно отмены 5 с (вопрос 14.2). */
export function sendSuggestion(id: number): boolean {
  const suggestion = threads.peek().get(id)?.suggestion;
  if (!suggestion || suggestion.level === 'unsure' || !suggestion.text.trim()) return false;
  sendReply(id, { text: suggestion.text, suggestionId: suggestion.id, edited: false, quote: null, delay: SEND_UNDO_DRAFT_MS, restore: suggestion });
  updateThread(id, (current) => ({ ...current, suggestion: null }));
  return true;
}

/**
 * Черновик помощника (6.3.4): отдельная карточка, ваш текст не затирает.
 * Уверенность словами с причиной и источниками; «Не уверен» свёрнут и без
 * «Отправить» — отправить можно только из поля после «Править».
 */
export function WorkDraft({ id, head, typing }: { id: number; item: InboxItem; head: ThreadHead; typing: boolean }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const [full, setFull] = useState(false);
  const [reasons, setReasons] = useState(false);
  const [keepStale, setKeepStale] = useState(false);
  const thread = threads.value.get(id);
  const draft = thread?.suggestion ?? null;
  if (!draft) return null;
  const perms = permissions.value;
  const canReply = availability('draft.send', perms) === 'show';
  const closed = head.window.applies && !head.window.open;
  const offline = connection.value === 'offline';
  const noText = !draft.text.trim();

  if (!canReply) {
    return (
      <section class={s.draft} data-level={draft.level} aria-label={t('draft.title')}>
        <header class={s.draftHead}><Icon name="spark" size={16} /><span>{t('draft.readOnly')}</span></header>
        {!noText && <p class={s.draftText} data-clamp="true">{draft.text}</p>}
      </section>
    );
  }

  if (thread?.suggestionStale && !keepStale) {
    return (
      <section class={s.draft} data-level="unsure" aria-label={t('draft.title')}>
        <p class={s.draftUnsure}><Icon name="spark" size={16} /><span>{t('draft.stale')}</span></p>
        <div class={s.draftActions}>
          <Button variant="secondary" size="sm" onClick={() => setKeepStale(true)}>{t('draft.keep')}</Button>
          <Button variant="quiet" size="sm" onClick={() => rejectDraft(id, null)}>{t('draft.remove')}</Button>
        </div>
      </section>
    );
  }

  if (noText) {
    return (
      <section class={s.draft} data-level="unsure" aria-label={t('draft.title')}>
        <p class={s.draftUnsure}>
          <Icon name="spark" size={16} />
          <span><strong>{t('draft.askYou')}</strong>{draft.reason && <> {t('draft.unsureReason', { reason: draft.reason })}</>}</span>
        </p>
        {draft.operator_note && <p class={s.draftWhy}>{t('draft.noteForYou', { note: draft.operator_note })}</p>}
        <div class={s.draftActions}><Button variant="secondary" size="sm" onClick={() => updateThread(id, (current) => ({ ...current, suggestion: null }))}>{t('draft.understood')}</Button></div>
      </section>
    );
  }

  if (typing && !expanded) {
    return (
      <p class={s.draftStrip}>
        <Icon name="spark" size={16} />
        <span>{t('draft.hasDraft')}</span>
        <button type="button" class={s.stripAction} onClick={() => setExpanded(true)}>{t('draft.show')}</button>
      </p>
    );
  }

  const rejectSheet = (
    <Sheet open={reasons} onClose={() => setReasons(false)} title={t('draft.reject')}>
      <div role="menu" aria-label={t('draft.reject')}>
        {REASONS.map(([code, key]) => (
          <Option key={code} label={t(key)} onSelect={() => { setReasons(false); rejectDraft(id, code); }} />
        ))}
      </div>
    </Sheet>
  );
  const sources = draft.sources.length
    ? t('draft.basedOn', { sources: draft.sources.map((source) => `«${source}»`).join(', ') })
    : t('draft.noSources');

  if (draft.level === 'unsure' && !expanded) {
    return (
      <section class={s.draft} data-level="unsure" aria-label={t('draft.title')}>
        <p class={s.draftUnsure}>
          <Icon name="spark" size={16} />
          <span><strong>{t('draft.unsureTitle')}</strong>{draft.reason && <> {t('draft.unsureReason', { reason: draft.reason })}</>}</span>
        </p>
        <div class={s.draftActions}>
          <Button variant="secondary" size="sm" onClick={() => setExpanded(true)}>{t('draft.show')}</Button>
          <Button variant="quiet" size="sm" aria-haspopup="dialog" onClick={() => setReasons(true)}>{t('draft.rejectMenu')}</Button>
        </div>
        {rejectSheet}
      </section>
    );
  }

  const sendBlocked = closed ? t('draft.windowClosed') : offline ? t('composer.offline') : null;
  return (
    <section class={s.draft} data-level={draft.level} aria-label={t('draft.title')}>
      <header class={s.draftHead}>
        <Icon name="spark" size={16} />
        <span>{t('draft.title')}</span>
        <span class={s.level} data-level={draft.level}>{levelLabel(draft.level)}</span>
        {(typing || draft.level === 'unsure') && <button type="button" class={s.stripAction} onClick={() => setExpanded(false)}>{t('draft.hide')}</button>}
      </header>
      <p class={`${s.draftText} ${w.draftBody}`} data-clamp={full ? 'false' : 'true'}>{draft.text}</p>
      {draft.text.length > 120 && (
        <button type="button" class={s.more} aria-expanded={full} onClick={() => setFull(!full)}>{full ? t('draft.collapse') : t('draft.full')}</button>
      )}
      {draft.level === 'check' && <p class={s.draftWhy}>{t('draft.whyCheck', { reason: draft.reason || t('draft.checkDefault') })}</p>}
      {draft.level === 'unsure' && draft.reason && <p class={s.draftWhy}>{t('draft.unsureReason', { reason: draft.reason })}</p>}
      {draft.operator_note && <p class={s.draftWhy}>{t('draft.noteForYou', { note: draft.operator_note })}</p>}
      <p class={s.draftSources}>{sources}</p>
      <details class={w.expert}>
        <summary>{t('draft.expert')}</summary>
        <p>{t('draft.expertText', { score: draft.confidence === null ? '—' : `${Math.round(draft.confidence * 100)}%`, model: draft.model ?? '—' })}</p>
      </details>
      <div class={s.draftActions}>
        {draft.level !== 'unsure' && (
          <Button variant="primary" size="sm" icon="send" disabled={sendBlocked !== null} title={sendBlocked ?? undefined}
            onClick={() => { sendSuggestion(id); }}>
            {t('draft.send')}
          </Button>
        )}
        <Button variant="secondary" size="sm" icon="edit" onClick={() => editDraft(id)}>{t('draft.edit')}</Button>
        <Button variant="quiet" size="sm" aria-haspopup="dialog" onClick={() => setReasons(true)}>{t('draft.rejectMenu')}</Button>
        {sendBlocked && <span class={s.draftNote}>{sendBlocked}</span>}
        {!sendBlocked && draft.level !== 'unsure' && isDesktop.value && <span class={s.draftNote}>{t('draft.shortcut')}</span>}
      </div>
      {rejectSheet}
    </section>
  );
}
