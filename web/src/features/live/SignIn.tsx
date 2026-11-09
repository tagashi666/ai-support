import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { setMode, signIn } from '@/lib/live/store';
import { Button } from '@/ui/Button';
import l from './live.module.css';

/**
 * Вход по ключу. После 401 — «Войдите снова» вместо перезагрузки страницы
 * (6.14): ввод на экране не теряется, после входа список продолжается.
 */
export function SignIn({ again = false, inSheet = false, onDone }: { again?: boolean; inSheet?: boolean; onDone?: () => void }): JSX.Element {
  const [key, setKey] = useState('');
  const [error, setError] = useState<'wrong' | 'network' | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    const result = await signIn(key);
    setBusy(false);
    if (result === 'ok') { setKey(''); onDone?.(); } else setError(result);
  };
  return (
    <form class={l.signIn} data-in-sheet={inSheet ? 'true' : 'false'} onSubmit={(event) => { void submit(event); }}>
      {!inSheet && <h1 class={l.title}>{again ? t('login.again') : t('login.title')}</h1>}
      {again && <p class={l.hint}>{t('login.expired')}</p>}
      <label class={l.field}>
        <span>{t('login.key')}</span>
        <input
          type="password"
          autocomplete="current-password"
          value={key}
          aria-invalid={error ? 'true' : 'false'}
          onInput={(event) => { setKey((event.target as HTMLInputElement).value); setError(null); }}
        />
      </label>
      <p class={l.hint}>{t('login.hint')}</p>
      {error && <p class={l.error} role="alert">{error === 'wrong' ? t('login.wrong') : t('login.network')}</p>}
      <div class={l.actions}>
        <Button type="submit" variant="primary" disabled={busy || !key.trim()}>{t('login.submit')}</Button>
        {again && <Button variant="quiet" onClick={() => setMode('demo')}>{t('login.toDemo')}</Button>}
      </div>
    </form>
  );
}
