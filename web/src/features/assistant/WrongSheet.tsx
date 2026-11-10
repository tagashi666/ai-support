import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { FeedbackReason } from '@shared/api-types';
import { t } from '@/i18n/ru';
import { FEEDBACK_LABEL, FEEDBACK_REASONS } from '@/lib/assistant/model';
import { sendFeedback } from '@/lib/assistant/store';
import { Button } from '@/ui/Button';
import { Option, Sheet, sheetStyles } from '@/ui/Sheet';
import a from './assistant.module.css';

/**
 * «Это неверно» на ответе помощника (6.1, 6.7, 10.4 п.6): причина — неверный
 * факт, не тот тон, не по теме, этого нет в знаниях — и заметка по желанию.
 */
export function WrongSheet({ messageId, onClose }: { messageId: number | null; onClose: () => void }): JSX.Element {
  const [reason, setReason] = useState<FeedbackReason | null>(null);
  const [note, setNote] = useState('');
  const [correct, setCorrect] = useState('');
  const [busy, setBusy] = useState(false);
  const close = (): void => { setReason(null); setNote(''); setCorrect(''); onClose(); };
  const submit = async (): Promise<void> => {
    if (messageId === null || busy) return;
    setBusy(true);
    const ok = await sendFeedback(messageId, reason, note, correct);
    setBusy(false);
    if (ok) close();
  };
  return (
    <Sheet open={messageId !== null} onClose={close} title={t('wrong.title')}>
      <p class={sheetStyles.text}>{t('wrong.hint')}</p>
      <div role="menu" aria-label={t('wrong.reason')}>
        {FEEDBACK_REASONS.map((value) => (
          <Option key={value} checked={reason === value} label={t(FEEDBACK_LABEL[value])} onSelect={() => setReason(value)} />
        ))}
      </div>
      <label class={a.field}>
        <span class={a.label}>{t('wrong.note')}</span>
        <textarea class={a.textarea} rows={3} maxLength={500} value={note} onInput={(event) => setNote((event.target as HTMLTextAreaElement).value)} />
      </label>
      <label class={a.field}>
        <span class={a.label}>{t('wrong.correct')}</span>
        <textarea class={a.textarea} rows={4} maxLength={4000} value={correct} onInput={(event) => setCorrect((event.target as HTMLTextAreaElement).value)} />
        <span class={a.hint}>{t('wrong.correctHint')}</span>
      </label>
      <div class={sheetStyles.actions}>
        <Button variant="quiet" onClick={close}>{t('wrong.cancel')}</Button>
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>{t('wrong.submit')}</Button>
      </div>
    </Sheet>
  );
}
