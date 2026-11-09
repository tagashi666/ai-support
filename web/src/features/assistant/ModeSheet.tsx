import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { AiMode } from '@shared/attention';
import { t } from '@/i18n/ru';
import { MODE_LABEL, OUTCOME_LABEL, tryOutcome, type TryOutcome } from '@/lib/assistant/model';
import { can, recentQuestions, tryQuestion } from '@/lib/assistant/store';
import { Button } from '@/ui/Button';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import a from './assistant.module.css';

const CHANGE: Record<AiMode, 'assistant.change.off' | 'assistant.change.shadow' | 'assistant.change.suggest' | 'assistant.change.auto'> = {
  off: 'assistant.change.off', shadow: 'assistant.change.shadow', suggest: 'assistant.change.suggest', auto: 'assistant.change.auto',
};

interface Preview { id: number; name: string; text: string; outcome: TryOutcome | 'failed'; source: string | null }

/**
 * Лист «Включить «Отвечает сам»?» (6.7): к более смелому режиму — только
 * через «было → станет» и «что изменится»; пока не нажато «Включить»,
 * ничего не применено. Для «Отвечает сам» — «Как бы он ответил на 5
 * последних диалогах» через /api/ai/try (право settings:ai_tools).
 */
export function ModeSheet({ from, to, onClose, onConfirm }: {
  from: AiMode; to: AiMode | null; onClose: () => void; onConfirm: (mode: AiMode) => void;
}): JSX.Element {
  const [previews, setPreviews] = useState<Preview[] | null>(null);
  const [running, setRunning] = useState(false);
  const questions = recentQuestions.value;
  const showPreview = to === 'auto' && can('settings:ai_tools') && questions.length > 0;
  const close = (): void => { setPreviews(null); onClose(); };

  const check = async (): Promise<void> => {
    setRunning(true);
    const out: Preview[] = [];
    // По очереди: проверка идёт через вашу модель, пять запросов разом упрутся в лимиты.
    for (const question of questions) {
      try {
        const result = await tryQuestion(question.text);
        out.push({ ...question, outcome: tryOutcome(result.verdict, result.draft.needsHuman), source: result.usedSources[0] ?? null });
      } catch {
        out.push({ ...question, outcome: 'failed', source: null });
      }
      setPreviews([...out]);
    }
    setRunning(false);
  };

  const target = to ?? 'auto';
  return (
    <Sheet open={to !== null} onClose={close} title={t('assistant.sheet.title', { mode: t(MODE_LABEL[target]) })}>
      <p class={a.wasWill}>{t('assistant.sheet.was', { from: t(MODE_LABEL[from]), to: t(MODE_LABEL[target]) })}</p>
      <p class={sheetStyles.text}><strong>{t('assistant.sheet.what')}</strong> {t(CHANGE[target])}</p>
      {showPreview && (
        <div class={a.preview}>
          <div class={a.previewHead}>
            <span>{t('assistant.sheet.preview', { n: questions.length })}</span>
            <Button variant="secondary" size="sm" disabled={running} onClick={() => void check()}>{t('assistant.sheet.check')}</Button>
          </div>
          {previews && (
            <ul class={a.previewList} aria-live="polite">
              {previews.map((item) => (
                <li key={item.id}>
                  <span class={a.previewName}>{item.name}</span> <span class={a.muted}>«{item.text}»</span>
                  {' → '}<strong>{item.outcome === 'failed' ? t('assistant.sheet.failed') : t(OUTCOME_LABEL[item.outcome])}</strong>
                  {item.source && <span class={a.muted}> · «{item.source}»</span>}
                </li>
              ))}
            </ul>
          )}
          <p class={a.muted}>{t('assistant.sheet.cost')}</p>
        </div>
      )}
      <p class={a.muted}>{t('assistant.sheet.revert')}</p>
      <div class={sheetStyles.actions}>
        <Button variant="quiet" onClick={close}>{t('assistant.sheet.cancel')}</Button>
        <Button variant="primary" onClick={() => { const mode = target; close(); onConfirm(mode); }}>
          {t('assistant.sheet.confirm', { mode: t(MODE_LABEL[target]) })}
        </Button>
      </div>
    </Sheet>
  );
}
