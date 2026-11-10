import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { tr } from '@/i18n/sections/system';
import { PANEL_CHOICES } from '@/lib/system/model';
import { changePanel, loadPanel, panelInfo, rights } from '@/lib/system/store';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import s from './system.module.css';

/** «Панель» (раздел 12, этап 8): что открывается по адресу панели у тех, кто сам не выбирал. */
export function PanelPanel(): JSX.Element {
  useEffect(() => { void loadPanel(); }, []);
  const info = panelInfo.value;
  const r = rights.value;
  if (info === undefined) return <div class={s.panel} aria-busy="true"><div class={s.skeleton} key="skeleton" aria-hidden="true" /></div>;
  if (info === null) {
    return (
      <div class={s.panel}>
        <p class={s.error} role="alert">{tr('system.panel.loadFailed')}</p>
        <div class={s.actions}><Button variant="secondary" onClick={() => void loadPanel()}>{tr('system.retry')}</Button></div>
      </div>
    );
  }
  const env = info.source === 'env';
  const editable = r.panel && !env;
  return (
    <div class={s.panel}>
      {!info.built && <p class={s.result} data-tone="warn" role="status">{tr('system.panel.notBuilt')}</p>}
      <Card label={tr('system.panel.what')}>
        <fieldset class={s.levels}>
          <legend class={s.cardHead}>{tr('system.panel.what')}</legend>
          {PANEL_CHOICES.map((choice) => (
            <label key={choice} class={s.levelOpt} data-checked={info.choice === choice}>
              <input type="radio" name="panel-default" checked={info.choice === choice} disabled={!editable}
                onChange={() => void changePanel(choice)} />
              <span class={s.levelName}>{tr(choice === 'next' ? 'system.panel.next' : 'system.panel.classic')}</span>
              <span class={s.muted}>{tr(choice === 'next' ? 'system.panel.nextHint' : 'system.panel.classicHint')}</span>
            </label>
          ))}
        </fieldset>
        {env ? <p class={s.hint}>{tr('system.panel.env', { name: 'PANEL_UI' })}</p>
          : !r.panel && <p class={s.hint}>{tr('system.panel.locked')}</p>}
        <p class={s.muted}>{tr('system.panel.device')}</p>
      </Card>
    </div>
  );
}
