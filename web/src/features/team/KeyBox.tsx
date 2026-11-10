import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { tr } from '@/i18n/sections/team';
import { Button } from '@/ui/Button';
import k from './team.module.css';

/**
 * Ключ входа, виден один раз (6.10): выделяемое поле только для чтения и «Скопировать».
 * Ключ живёт только в состоянии этого компонента — не в адресе и не в хранилище.
 */
export function KeyBox({ value }: { value: string }): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<'copied' | 'fail' | null>(null);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setMessage('copied');
    } catch {
      setMessage('fail');
      input.current?.focus();
      input.current?.select();
    }
  };
  return (
    <div class={k.field}>
      <label class={k.label} for="team-key">{tr('team.add.keyLabel')}</label>
      <div class={k.keyRow}>
        <input id="team-key" ref={input} class={`${k.input} ${k.keyInput}`} readOnly value={value} autocomplete="off" spellcheck={false}
          onFocus={(event) => (event.currentTarget as HTMLInputElement).select()} />
        <Button variant="secondary" onClick={() => void copy()}>{tr('team.add.copy')}</Button>
      </div>
      <p class={k.hint}>{tr('team.add.keyOnce')}</p>
      <p class={k.hint} role="status">{message === 'copied' ? tr('team.add.copied') : message === 'fail' ? tr('team.add.copyFail') : ''}</p>
    </div>
  );
}
