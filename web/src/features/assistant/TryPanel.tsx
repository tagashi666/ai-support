import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { confidenceLevel } from '@shared/confidence';
import { t } from '@/i18n/ru';
import { OUTCOME_LABEL, tryOutcome } from '@/lib/assistant/model';
import { settings, tryQuestion, type TryResult } from '@/lib/assistant/store';
import { ApiError } from '@/lib/live/api';
import { levelLabel } from '@/lib/labels';
import { bootstrap } from '@/lib/live/store';
import { Button } from '@/ui/Button';
import a from './assistant.module.css';

/**
 * «Попробовать» (бывшая AI-студия, 6.7): вопрос клиента → ответ, уверенность
 * словом, попросил бы человека, что было бы в режиме «Отвечает сам»,
 * на чём основано. Ничего не отправляется.
 */
export function TryPanel(): JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (): Promise<void> => {
    if (!text.trim() || busy) return;
    setBusy(true); setError(null);
    try { setResult(await tryQuestion(text.trim())); }
    catch (err) { setResult(null); setError(err instanceof ApiError ? err.message : t('error.network')); }
    setBusy(false);
  };
  const threshold = settings.value?.minConfidence ?? bootstrap.value?.assistant.minConfidence ?? 0.7;
  const level = result ? confidenceLevel({
    score: result.draft.confidence, threshold, hasSources: result.usedSources.length > 0,
    askedHuman: result.draft.needsHuman, gatePassed: result.verdict.action === 'auto', hasText: Boolean(result.draft.reply.trim()),
  }) : null;
  return (
    <div class={a.panel}>
      <form class={a.group} onSubmit={(event) => { event.preventDefault(); void run(); }}>
        <label class={a.field}>
          <span class={a.label}>{t('try.question')}</span>
          <textarea class={a.textarea} rows={3} maxLength={2000} value={text} placeholder={t('try.placeholder')}
            onInput={(event) => setText((event.target as HTMLTextAreaElement).value)} />
        </label>
        <div class={a.actions}>
          <Button type="submit" variant="primary" disabled={busy || !text.trim()}>{busy ? t('try.running') : t('try.run')}</Button>
          <span class={a.muted}>{t('try.nothingSent')}</span>
        </div>
      </form>
      {error && <p class={a.error} role="alert">{error}</p>}
      {result && level && (
        <section class={a.result} aria-live="polite" aria-label={t('try.result')}>
          <blockquote class={a.reply}>{result.draft.reply.trim() || t('try.noReply')}</blockquote>
          <dl class={a.facts}>
            <dt>{t('try.confidence')}</dt><dd>{levelLabel(level)}</dd>
            <dt>{t('try.asksHuman')}</dt><dd>{result.draft.needsHuman ? t('try.yes') : t('try.no')}</dd>
            <dt>{t('try.inAuto')}</dt><dd>{t(OUTCOME_LABEL[tryOutcome(result.verdict, result.draft.needsHuman)])}</dd>
          </dl>
          <h3 class={a.subhead}>{t('try.basedOn')}</h3>
          {result.sources.length === 0 ? <p class={a.muted}>{t('try.noSources')}</p> : (
            <ul class={a.sources}>
              {result.sources.map((source) => (
                <li key={source} data-used={result.usedSources.includes(source) ? 'true' : 'false'}>
                  {source}{result.usedSources.includes(source) && <span class={a.used}> · {t('try.used')}</span>}
                </li>
              ))}
            </ul>
          )}
          {result.draft.operatorNote && <p class={a.muted}>{t('try.note', { note: result.draft.operatorNote })}</p>}
          <details class={a.details}>
            <summary>{t('assistant.tab.expert')}</summary>
            <p class={a.muted}>{t('try.tech', { model: result.model, ms: result.ms })}</p>
          </details>
        </section>
      )}
    </div>
  );
}
