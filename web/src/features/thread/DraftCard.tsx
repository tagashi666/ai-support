import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { editDraft, rejectDraft, sendDraft } from '@/lib/actions/chat';
import { levelLabel } from '@/lib/labels';
import { isDesktop } from '@/lib/media';
import type { Chat } from '@/lib/types';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import s from './thread.module.css';

/**
 * Черновик помощника (6.3.4): отдельная карточка, ваш текст не затирает.
 * Уверенность словами с причиной и источниками. «Не уверен» свёрнут и без
 * кнопки «Отправить»: отправить можно только из поля после «Править».
 */
export function DraftCard({ chat, closed, typing }: { chat: Chat; closed: boolean; typing: boolean }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const [full, setFull] = useState(false);
  const draft = chat.draft;
  if (!draft) return null;

  if (typing && !expanded) {
    return (
      <p class={s.draftStrip}>
        
        <span>{t('draft.hasDraft')}</span>
        <button type="button" class={s.stripAction} onClick={() => setExpanded(true)}>{t('draft.show')}</button>
      </p>
    );
  }

  const sources = draft.sources.length
    ? t('draft.basedOn', { sources: draft.sources.map((source) => `«${source}»`).join(', ') })
    : t('draft.noSources');

  if (draft.level === 'unsure' && !expanded) {
    return (
      <section class={s.draft} data-level="unsure" aria-label={t('draft.title')}>
        <p class={s.draftUnsure}>
          
          <span>
            <strong>{t('draft.unsureTitle')}</strong>
            {draft.reason && <> {t('draft.unsureReason', { reason: draft.reason })}</>}
          </span>
        </p>
        <div class={s.draftActions}>
          <Button variant="secondary" size="sm" onClick={() => setExpanded(true)}>{t('draft.show')}</Button>
          <Button variant="quiet" size="sm" onClick={() => rejectDraft(chat.id)}>{t('draft.reject')}</Button>
        </div>
      </section>
    );
  }

  const canSend = draft.level !== 'unsure' && !closed;
  return (
    <section class={s.draft} data-level={draft.level} aria-label={t('draft.title')}>
      <header class={s.draftHead}>
        
        <span>{t('draft.title')}</span>
        <span class={s.level} data-level={draft.level}>{levelLabel(draft.level)}</span>
        {(typing || draft.level === 'unsure') && (
          <button type="button" class={s.stripAction} onClick={() => setExpanded(false)}>{t('draft.hide')}</button>
        )}
      </header>
      <p class={s.draftText} data-clamp={full ? 'false' : 'true'}>{draft.text}</p>
      {draft.text.length > 120 && (
        <button type="button" class={s.more} aria-expanded={full} onClick={() => setFull(!full)}>
          {full ? t('draft.collapse') : t('draft.full')}
        </button>
      )}
      {draft.level === 'check' && draft.reason && <p class={s.draftWhy}>{t('draft.whyCheck', { reason: draft.reason })}</p>}
      {draft.level === 'unsure' && draft.reason && <p class={s.draftWhy}>{t('draft.unsureReason', { reason: draft.reason })}</p>}
      <p class={s.draftSources}>{sources}</p>
      <div class={s.draftActions}>
        {draft.level !== 'unsure' && (
          <Button variant="primary" size="sm" icon="send" disabled={!canSend} title={closed ? t('draft.windowClosed') : undefined}
            onClick={() => sendDraft(chat.id)}>
            {t('draft.send')}
          </Button>
        )}
        <Button variant="secondary" size="sm" icon="edit" onClick={() => editDraft(chat.id)}>{t('draft.edit')}</Button>
        <Button variant="quiet" size="sm" onClick={() => rejectDraft(chat.id)}>{t('draft.reject')}</Button>
        {closed && <span class={s.draftNote}>{t('draft.windowClosed')}</span>}
        {!closed && canSend && isDesktop.value && <span class={s.draftNote}>{t('draft.shortcut')}</span>}
      </div>
    </section>
  );
}
