import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { aiInfo, can, pingModel } from '@/lib/assistant/store';
import { Button } from '@/ui/Button';
import { NumberField, TextField } from './fields';
import a from './assistant.module.css';

/** «Для специалистов» (6.7): модель, запасная модель, порог числом, проверка подключения. */
export function ExpertPanel(): JSX.Element {
  const [ping, setPing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async (): Promise<void> => {
    setBusy(true);
    const result = await pingModel();
    setBusy(false);
    setPing(result.ok ? t('expert.pingOk', { model: result.model, ms: result.ms }) : t('expert.pingFailed', { error: result.error }));
  };
  return (
    <div class={a.panel}>
      <section class={a.group} aria-labelledby="as-expert">
        <h2 class={a.head} id="as-expert">{t('assistant.tab.expert')}</h2>
        <TextField field="model" label={t('assistant.key.model')} min={2} max={80} />
        <TextField field="fallbackModel" label={t('assistant.key.fallbackModel')} hint={t('expert.fallbackHint')} max={80} />
        <NumberField field="minConfidence" label={t('expert.threshold')} hint={t('expert.thresholdHint')} min={0} max={1} step={0.01} />
        <p class={a.muted}>{t('expert.keys', { n: aiInfo.value?.keys ?? 0 })}</p>
        {can('settings:ai_tools') && (
          <div class={a.actions}>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void check()}>{t('expert.ping')}</Button>
            {ping && <span class={a.muted} role="status">{ping}</span>}
          </div>
        )}
      </section>
    </div>
  );
}
