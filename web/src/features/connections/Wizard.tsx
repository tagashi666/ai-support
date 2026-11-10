import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { tr } from '@/i18n/sections/connections';
import {
  businessVerdict, checkFields, emptyFields, requestBody, RUN_STEPS, WIZARD_KINDS, wizardPosition,
  type FieldCode, type WizardFields, type WizardKind,
} from '@/lib/connections/model';
import { clearRun, loadConnections, run, startRun } from '@/lib/connections/store';
import { Button } from '@/ui/Button';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import c from './connections.module.css';

const BOTFATHER = '@BotFather';
const KEY_SAMPLE = '123456789:AAAA…';
const SCHEME = 'https://';
// Без схемы: в сборке не должно быть внешних адресов (scripts/webbudget.ts).
const ADDRESS = 'panel.example.org';

type Stage = 'pick' | 'fields' | 'run';

const KIND_TEXT: Record<WizardKind, { name: Parameters<typeof tr>[0]; hint: Parameters<typeof tr>[0]; title: Parameters<typeof tr>[0] }> = {
  telegram_bot: { name: 'connections.kind.bot', hint: 'connections.kind.botHint', title: 'connections.fields.botTitle' },
  business: { name: 'connections.kind.business', hint: 'connections.kind.businessHint', title: 'connections.fields.businessTitle' },
  remnawave: { name: 'connections.kind.remnawave', hint: 'connections.kind.remnawaveHint', title: 'connections.fields.remnawaveTitle' },
  minishop: { name: 'connections.kind.minishop', hint: 'connections.kind.minishopHint', title: 'connections.fields.minishopTitle' },
};

const WHY: Record<WizardKind, Parameters<typeof tr>[0]> = {
  telegram_bot: 'connections.why.bot',
  business: 'connections.why.business',
  remnawave: 'connections.why.remnawave',
  minishop: 'connections.why.minishop',
};

const CHECK: Record<WizardKind, Parameters<typeof tr>[0]> = {
  telegram_bot: 'connections.check.bot',
  business: 'connections.check.business',
  remnawave: 'connections.check.remnawave',
  minishop: 'connections.check.minishop',
};

const CODE_TEXT: Record<'name' | 'url' | 'token', Partial<Record<FieldCode, Parameters<typeof tr>[0]>>> = {
  name: { empty: 'connections.err.nameEmpty', long: 'connections.err.nameLong', chars: 'connections.err.nameChars' },
  url: { empty: 'connections.err.urlEmpty', chars: 'connections.err.urlChars', https: 'connections.err.urlHttps' },
  token: { empty: 'connections.err.keyEmpty', chars: 'connections.err.keyChars', botKey: 'connections.err.keyBot', short: 'connections.err.keyShort' },
};

/** Мастер «Подключить…» (6.11): что подключаем → поля с «Зачем» → ход на экране. Ключ живёт только в поле и стирается после отправки. */
export function Wizard({ initial, onClose }: { initial: WizardKind | null; onClose: () => void }): JSX.Element {
  const current = run.value;
  const [kind, setKind] = useState<WizardKind>(initial ?? 'telegram_bot');
  const [stage, setStage] = useState<Stage>(current ? 'run' : initial ? 'fields' : 'pick');
  const [fields, setFields] = useState<WizardFields>(emptyFields());
  const [shown, setShown] = useState(false);
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<'yes' | 'no' | null>(null);
  const [advice, setAdvice] = useState(false);
  const first = useRef<HTMLHeadingElement>(null);
  useEffect(() => { first.current?.focus(); }, [stage]);

  const close = (): void => {
    if (run.peek()?.phase === 'done' || run.peek()?.phase === 'failed') clearRun();
    onClose();
  };
  const errors = tried ? checkFields(kind, fields) : {};
  const set = (key: keyof WizardFields) => (event: Event): void => {
    setProblem('');
    setFields({ ...fields, [key]: (event.target as HTMLInputElement | HTMLSelectElement).value });
  };

  const submit = async (): Promise<void> => {
    setTried(true);
    if (kind === 'business' || Object.keys(checkFields(kind, fields)).length > 0 || busy) return;
    setBusy(true);
    const failure = await startRun(requestBody(kind, fields));
    setBusy(false);
    if (failure) { setProblem(failure); return; }
    setFields({ ...fields, token: '' });
    setShown(false);
    setStage('run');
  };

  const checkBusiness = async (): Promise<void> => {
    setBusy(true);
    const data = await loadConnections();
    setBusy(false);
    setVerdict(data && businessVerdict(data) ? 'yes' : 'no');
  };

  const err = (key: 'name' | 'url' | 'token'): string | null => {
    const code = errors[key];
    const id = code ? CODE_TEXT[key][code] : null;
    return id ? tr(id, { sample: KEY_SAMPLE, scheme: SCHEME, example: ADDRESS }) : null;
  };
  const text = (key: 'name' | 'url' | 'token', label: string, why: string, props: { placeholder?: string; secret?: boolean; kindType?: string } = {}): JSX.Element => {
    const id = `wiz-${key}`;
    const message = err(key);
    const input = (
      <input id={id} class={c.input} type={props.secret && !shown ? 'password' : props.kindType ?? 'text'} value={fields[key]} placeholder={props.placeholder}
        autoComplete="off" autoCapitalize="off" spellcheck={false} aria-invalid={message ? 'true' : undefined} aria-describedby={`${id}-why`} onInput={set(key)} />
    );
    return (
      <div class={c.field}>
        <label for={id} class={c.label}>{label}</label>
        {props.secret ? (
          <div class={c.secret}>
            {input}
            <Button variant="secondary" aria-pressed={shown} onClick={() => setShown(!shown)}>{shown ? tr('connections.hide') : tr('connections.show')}</Button>
          </div>
        ) : input}
        <p id={`${id}-why`} class={message ? c.error : c.hint}>{message ?? why}</p>
      </div>
    );
  };

  const title = stage === 'pick' ? tr('connections.wizard.title') : stage === 'fields' ? tr(KIND_TEXT[kind].title) : tr('connections.wizard.running');
  const position = wizardPosition(stage);
  const heading = (label: string): JSX.Element => <h3 class={c.step} tabIndex={-1} ref={first}>{label}</h3>;

  return (
    <Sheet open onClose={close} title={title}>
      {stage === 'pick' && (
        <div class={c.form}>
          {heading(tr('connections.wizard.step', { n: position, total: 3 }))}
          <fieldset class={c.pick}>
            <legend>{tr('connections.wizard.ask')}</legend>
            {WIZARD_KINDS.map((value) => (
              <label key={value} class={c.pickItem} data-checked={kind === value}>
                <input type="radio" name="wizard-kind" checked={kind === value} onChange={() => setKind(value)} />
                <span class={c.pickText}><span class={c.pickName}>{tr(KIND_TEXT[value].name)}</span><span class={c.hint}>{tr(KIND_TEXT[value].hint)}</span></span>
              </label>
            ))}
          </fieldset>
          <div class={sheetStyles.actions}>
            <Button variant="quiet" onClick={close}>{tr('connections.cancel')}</Button>
            <Button variant="primary" onClick={() => setStage('fields')}>{tr('connections.next')}</Button>
          </div>
        </div>
      )}

      {stage === 'fields' && kind === 'business' && (
        <div class={c.form}>
          {heading(tr('connections.wizard.step', { n: position, total: 3 }))}
          <p class={sheetStyles.text}>{tr('connections.business.why')}</p>
          <ol class={c.recipe}>
            <li>{tr('connections.business.s1')}</li>
            <li>{tr('connections.business.s2')}</li>
            <li>{tr('connections.business.s3')}</li>
          </ol>
          {verdict && <p class={verdict === 'yes' ? c.okBox : c.verdict} role="status">{verdict === 'yes' ? tr('connections.business.yes') : tr('connections.business.no')}</p>}
          <div class={sheetStyles.actions}>
            {!initial && <Button variant="quiet" onClick={() => { setVerdict(null); setStage('pick'); }}>{tr('connections.back')}</Button>}
            {verdict === 'yes'
              ? <Button variant="primary" onClick={close}>{tr('connections.done')}</Button>
              : <Button variant="primary" disabled={busy} onClick={() => void checkBusiness()}>{tr('connections.business.check')}</Button>}
          </div>
        </div>
      )}

      {stage === 'fields' && kind !== 'business' && (
        <form class={c.form} noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {heading(tr('connections.wizard.step', { n: position, total: 3 }))}
          <p class={sheetStyles.text}>{tr(WHY[kind])}</p>
          {kind === 'telegram_bot' && (
            <ol class={c.recipe}>
              <li>{tr('connections.bot.s1', { botfather: BOTFATHER })}</li>
              <li>{tr('connections.bot.s2')}</li>
              <li>{tr('connections.bot.s3')}</li>
            </ol>
          )}
          {text('name', tr('connections.field.name'), tr('connections.field.nameWhy'), { placeholder: tr('connections.field.namePlaceholder') })}
          {kind !== 'telegram_bot' && text('url', tr('connections.field.url'), tr(kind === 'remnawave' ? 'connections.field.urlWhyPanel' : 'connections.field.urlWhyShop', { scheme: SCHEME }), { kindType: 'url', placeholder: `${SCHEME}…` })}
          {text('token', tr('connections.field.key'), tr('connections.field.keyWhy'), { secret: true, placeholder: kind === 'telegram_bot' ? KEY_SAMPLE : '' })}
          {kind === 'remnawave' && (
            <label class={c.check}>
              <input type="checkbox" checked={fields.readOnly} onChange={(event) => setFields({ ...fields, readOnly: (event.target as HTMLInputElement).checked })} />
              <span>{tr('connections.field.readOnly')}<br /><span class={c.hint}>{tr('connections.field.readOnlyWhy')}</span></span>
            </label>
          )}
          {kind === 'minishop' && (
            <details class={c.details}>
              <summary>{tr('connections.specialists')}</summary>
              <div>
                <label class={c.label} for="wiz-mode">{tr('connections.field.mode')}</label>
                <select id="wiz-mode" class={c.select} value={fields.mode} onChange={set('mode')}>
                  <option value="plugin">{tr('connections.mode.plugin')}</option>
                  <option value="admin">{tr('connections.mode.admin')}</option>
                </select>
                <p class={c.hint}>{tr('connections.mode.why')}</p>
              </div>
            </details>
          )}
          {problem && <p class={c.error} role="alert">{problem}</p>}
          <div class={sheetStyles.actions}>
            {!initial && <Button variant="quiet" onClick={() => setStage('pick')}>{tr('connections.back')}</Button>}
            <Button variant="primary" type="submit" disabled={busy}>{tr('connections.submit')}</Button>
          </div>
        </form>
      )}

      {stage === 'run' && (
        <div class={c.form}>
          {heading(tr('connections.wizard.step', { n: position, total: 3 }))}
          {current && (
            <>
              <ol class={c.run} aria-label={tr('connections.run.label')}>
                {RUN_STEPS.map((key, index) => {
                  const state = current.phase === 'done' || index < current.step ? 'done' : index === current.step && current.phase !== 'failed' ? 'current' : 'todo';
                  return (
                    <li key={key} class={c.runItem} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
                      <span class={c.runMark} aria-hidden="true">{state === 'done' ? '✓' : ''}</span>{tr(key)}
                    </li>
                  );
                })}
              </ol>
              {current.phase === 'done' && <p class={c.okBox} role="status">{tr('connections.run.success')}</p>}
              {current.phase === 'failed' && (
                <div class={c.failBox} role="alert">
                  <p>{tr('connections.run.failed', { detail: current.detail || tr('connections.run.noDetail') })}</p>
                  <div class={c.actions}>
                    <Button variant="secondary" size="sm" aria-expanded={advice} onClick={() => setAdvice(!advice)}>{tr('connections.run.whatToCheck')}</Button>
                  </div>
                  {advice && <p class={sheetStyles.text}>{tr(CHECK[kind], { botfather: BOTFATHER, scheme: SCHEME })}</p>}
                </div>
              )}
            </>
          )}
          <div class={sheetStyles.actions}>
            {current?.phase === 'failed' && <Button variant="secondary" onClick={() => { clearRun(); setTried(false); setAdvice(false); setStage('fields'); }}>{tr('connections.run.retry')}</Button>}
            {(current?.phase === 'done' || current?.phase === 'failed') && <Button variant="primary" onClick={close}>{current.phase === 'done' ? tr('connections.done') : tr('connections.close')}</Button>}
            {current && current.phase !== 'done' && current.phase !== 'failed' && <Button variant="quiet" onClick={close}>{tr('connections.runHide')}</Button>}
          </div>
        </div>
      )}
    </Sheet>
  );
}
