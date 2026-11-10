import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { loadIdeas, loadKb, loadMineJob, mineJob, startMine, startMineExport } from '@/lib/knowledge/store';
import { Button } from '@/ui/Button';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import k from './knowledge.module.css';

type Source = 'archive' | 'panel' | 'export';
const SOURCES: readonly { value: Source; label: 'kb.mine.archive' | 'kb.mine.panel' | 'kb.mine.export' }[] = [
  { value: 'archive', label: 'kb.mine.archive' },
  { value: 'panel', label: 'kb.mine.panel' },
  { value: 'export', label: 'kb.mine.export' },
];

/**
 * «Найти статьи в старых диалогах» (бывшее «Собрать из чатов», 6.6): источник,
 * сколько взять, запуск; ход работы — на экране. Результат — черновики и идеи.
 */
export function MineSheet({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const [source, setSource] = useState<Source>('archive');
  const [limit, setLimit] = useState(200);
  const [file, setFile] = useState<File | null>(null);
  const [people, setPeople] = useState<string[] | null>(null);
  const [me, setMe] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const job = mineJob.value;
  const running = job?.status === 'running';

  useEffect(() => {
    if (!open) return;
    void loadMineJob();
    const timer = setInterval(() => {
      void loadMineJob().then((next) => {
        // Сбор закончился — в списках появятся новые черновики и идеи.
        if (next && next.status !== 'running') { void loadKb(); void loadIdeas(); }
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [open]);

  const limitOk = Number.isInteger(limit) && limit >= 10 && limit <= 1000;
  const run = async (): Promise<void> => {
    setBusy(true); setError(null);
    if (source === 'export') {
      if (!file) { setBusy(false); setError(t('kb.mine.needFile')); return; }
      const result = await startMineExport(file, people ? me : null);
      if ('participants' in result) { setPeople(result.participants); setMe(result.participants[0] ?? ''); }
      else if ('error' in result) setError(result.error);
    } else {
      const failed = await startMine(source, limit);
      if (failed) setError(failed);
    }
    setBusy(false);
  };

  return (
    <Sheet open={open} onClose={onClose} title={t('kb.mine.title')}>
      <p class={sheetStyles.text}>{t('kb.mine.hint')}</p>
      <fieldset class={k.radios}>
        <legend>{t('kb.mine.source')}</legend>
        {SOURCES.map((item) => (
          <label key={item.value} class={k.radio}>
            <input type="radio" name="mine-source" checked={source === item.value} disabled={running}
              onChange={() => { setSource(item.value); setPeople(null); setError(null); }} />
            {t(item.label)}
          </label>
        ))}
      </fieldset>
      {source !== 'export' ? (
        <label class={k.field}>
          <span class={k.label}>{t('kb.mine.limit')}</span>
          <input class={k.input} type="number" min={10} max={1000} step={10} value={limit} disabled={running} aria-invalid={limitOk ? undefined : 'true'}
            onInput={(event) => setLimit(Number((event.target as HTMLInputElement).value))} />
          <span class={k.hint}>{t('kb.mine.limitHint')}</span>
        </label>
      ) : (
        <>
          <label class={k.field}>
            <span class={k.label}>{t('kb.mine.file')}</span>
            <input class={k.input} type="file" accept=".json,application/json" disabled={running}
              onChange={(event) => { setFile((event.target as HTMLInputElement).files?.[0] ?? null); setPeople(null); }} />
            <span class={k.hint}>{t('kb.mine.fileHint')}</span>
          </label>
          {people && (
            <label class={k.field}>
              <span class={k.label}>{t('kb.mine.me')}</span>
              <select class={k.select} value={me} onChange={(event) => setMe((event.target as HTMLSelectElement).value)}>
                {people.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
          )}
        </>
      )}
      {error && <p class={k.error} role="alert">{error}</p>}
      {job && (
        <div class={k.field} aria-live="polite">
          <span class={k.label}>{running ? t('kb.mine.running') : job.status === 'failed' ? t('kb.mine.failed') : t('kb.mine.done')}</span>
          {(job.progress || job.error) && <pre class={k.log}>{(job.error ?? job.progress ?? '').split('\n').slice(-12).join('\n')}</pre>}
        </div>
      )}
      <div class={sheetStyles.actions}>
        <Button variant="quiet" onClick={onClose}>{t('kb.close')}</Button>
        <Button variant="primary" disabled={busy || running || (source !== 'export' && !limitOk)} onClick={() => void run()}>
          {people ? t('kb.mine.runAgain') : t('kb.mine.run')}
        </Button>
      </div>
    </Sheet>
  );
}
