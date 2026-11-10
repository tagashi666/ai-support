import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ActivityTotals } from '@shared/api-types';
import type { AiMode } from '@shared/attention';
import { t } from '@/i18n/ru';
import {
  CAUTION_LABEL, CAUTION_STEPS, cautionIndex, isBolder, MODE_CLIENT, MODE_DOES, MODE_LABEL, MODES, periodSince,
} from '@/lib/assistant/model';
import { aiInfo, can, loadActivity, offline, saveSettings, settings } from '@/lib/assistant/store';
import { setDraft, valueOf } from '@/lib/assistant/draft';
import { undoToast } from '@/lib/actions/toasts';
import { bootstrap } from '@/lib/live/store';
import { navigate } from '@/lib/router';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Lock, locked, NumberField, Switch } from './fields';
import { ModeSheet } from './ModeSheet';
import { PauseControls } from './PauseControls';
import a from './assistant.module.css';

/** «Как отвечает»: четыре карточки режима, пауза, «Когда помощник зовёт вас» (6.7). */
export function AnswersPanel(): JSX.Element {
  const saved = settings.value;
  const current = saved?.aiMode ?? bootstrap.value?.assistant.mode ?? 'suggest';
  const keys = bootstrap.value?.assistant.keys ?? true;
  const [asking, setAsking] = useState<AiMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [week, setWeek] = useState<ActivityTotals | null>(null);
  const modeLocked = locked('aiMode');

  useEffect(() => {
    if (!can('stats:read')) return;
    void loadActivity(periodSince('week', Date.now()), { limit: 1 }).then((res) => setWeek(res.totals)).catch(() => setWeek(null));
  }, []);

  const apply = async (mode: AiMode): Promise<void> => {
    setError(null);
    const result = await saveSettings({ aiMode: mode });
    if (!result.ok) setError(result.error);
  };
  const choose = (mode: AiMode): void => {
    if (mode === current || modeLocked) return;
    // К более осторожному — сразу; к более смелому — через лист «Что изменится».
    if (isBolder(current, mode)) setAsking(mode);
    else void apply(mode);
  };

  const caution = cautionIndex(Number(valueOf('minConfidence') ?? 0.7));
  const learn = Boolean(valueOf('autoLearn'));
  const toggleLearn = async (value: boolean): Promise<void> => {
    const result = await saveSettings({ autoLearn: value }, false);
    if (!result.ok) { setError(result.error); return; }
    undoToast(t(value ? 'assistant.learnOn' : 'assistant.learnOff'), () => { void saveSettings({ autoLearn: !value }, false); }, t('toast.undo'));
  };

  return (
    <div class={a.panel}>
      <section class={a.group} aria-labelledby="as-mode">
        <h2 class={a.head} id="as-mode">{t('assistant.answers.title')}</h2>
        <div class={a.cards} role="radiogroup" aria-label={t('assistant.answers.title')}>
          {MODES.map((mode) => {
            const checked = mode === current;
            const disabled = modeLocked || (!keys && mode !== 'off');
            return (
              <label key={mode} class={a.modeCard} data-checked={checked ? 'true' : 'false'} data-disabled={disabled ? 'true' : 'false'}>
                <input type="radio" name="ai-mode" value={mode} checked={checked} disabled={disabled} onChange={() => choose(mode)} />
                <span class={a.modeName}>{t(MODE_LABEL[mode])}</span>
                <span class={a.modeDoes}>{t(MODE_DOES[mode])}</span>
                <span class={a.modeClient}>{t(MODE_CLIENT[mode])}</span>
                {checked && <span class={a.modeNow}>{t('assistant.now')}</span>}
              </label>
            );
          })}
        </div>
        <Lock field="aiMode" />
        {!keys && <p class={a.muted}>{t('assistant.noKeys')}</p>}
        {error && <p class={a.error} role="alert">{error}</p>}
        {week && (
          <p class={a.muted}>
            {t('assistant.week', { n: week.drafts, sent: week.draftsSent, edited: week.draftsEdited, rejected: week.draftsRejected, auto: week.auto })}
            {' '}<Button variant="link" size="sm" onClick={() => navigate({ name: 'section', key: 'assistant', sub: 'activity' })}>
              {t('assistant.toActivity')} <Icon name="right" size={16} />
            </Button>
          </p>
        )}
        <PauseControls />
      </section>

      {saved && (
        <section class={a.group} aria-labelledby="as-rules">
          <div class={a.headRow}>
            <h2 class={a.head} id="as-rules">{t('assistant.rules.title')}</h2>
            <span class={a.muted}>{t('assistant.rules.onlyAuto')}</span>
          </div>
          <div class={`${a.numRow} ${a.scaleRow}`}>
            <span class={a.numLabel} id="as-caution">{t('assistant.key.minConfidence')}
              <span class={a.hint}>{t(CAUTION_LABEL[caution] ?? 'assistant.caution.2')}</span>
            </span>
            <div class={a.scale} role="radiogroup" aria-labelledby="as-caution">
              <span class={a.scaleEnd} aria-hidden="true">{t('assistant.caution.0')}</span>
              {CAUTION_STEPS.map((step, index) => (
                <label key={step} class={a.scaleStep} data-checked={index === caution ? 'true' : 'false'}>
                  <input type="radio" name="ai-caution" checked={index === caution} disabled={locked('minConfidence')}
                    aria-label={t(CAUTION_LABEL[index] ?? 'assistant.caution.2')} onChange={() => setDraft('minConfidence', step)} />
                </label>
              ))}
              <span class={a.scaleEnd} aria-hidden="true">{t('assistant.caution.4')}</span>
            </div>
            <Lock field="minConfidence" />
          </div>
          <Switch label={t('assistant.key.requireKb')} hint={t('assistant.requireKbHint')} checked={Boolean(valueOf('requireKb'))}
            disabled={locked('requireKb')} onChange={(value) => setDraft('requireKb', value)} />
          <NumberField field="humanHoldMinutes" label={t('assistant.key.humanHold')} min={0} max={1440} unit={t('assistant.unitMin')} />
          <NumberField field="maxAgeMinutes" label={t('assistant.key.maxAge')} min={0.5} max={168} step={0.5} scale={60} unit={t('assistant.unitHours')} />
          <NumberField field="autoPerHour" label={t('assistant.key.autoPerHour')} hint={t('assistant.autoPerHourHint')} min={0} max={100} />
          <NumberField field="handoffRepeatMinutes" label={t('assistant.key.handoffRepeat')} min={0} max={10080} unit={t('assistant.unitMin')} />
          <h3 class={a.subhead}>{t('assistant.source.title')}</h3>
          <p class={a.muted}>{t('assistant.source.kb', { n: aiInfo.value?.kb ?? 0 })}</p>
          <Switch label={t('assistant.key.autoLearn')} hint={t('assistant.learnHint')} checked={learn}
            disabled={locked('autoLearn') || offline.value} onChange={(value) => void toggleLearn(value)} />
        </section>
      )}
      <ModeSheet from={current} to={asking} onClose={() => setAsking(null)} onConfirm={(mode) => void apply(mode)} />
    </div>
  );
}
