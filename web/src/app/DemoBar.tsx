import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { demoIncoming, demoReset, demoSetDraft, demoSetState, type DemoState } from '@/demo/sim';
import { t, type Key } from '@/i18n/ru';
import { openChat, setTheme, theme, type Theme } from '@/lib/store/state';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Option, Sheet, sheetStyles } from '@/ui/Sheet';
import { Tabs } from '@/ui/Tabs';
import s from './shell.module.css';

const STATES: readonly { value: DemoState; label: Key }[] = [
  { value: 'handed', label: 'demo.state.handed' },
  { value: 'aiAuto', label: 'demo.state.aiAuto' },
  { value: 'youLead', label: 'demo.state.youLead' },
  { value: 'colleague', label: 'demo.state.colleague' },
  { value: 'window', label: 'demo.state.window' },
];

/**
 * Полоса прототипа: честно говорит, что данные вымышленные, и даёт кнопки
 * для проверки — новое сообщение, состояния диалога, тема. В рабочей панели её нет.
 */
export function DemoBar(): JSX.Element {
  const [open, setOpen] = useState(false);
  const chat = openChat.value;
  return (
    <div class={s.demo}>
      <span class={s.demoTag}><Icon name="flask" size={16} />{t('demo.badge')}</span>
      <span class={s.demoText}>{t('demo.text')}</span>
      <span class={s.demoActions}>
        <Button size="sm" variant="secondary" icon="plus" onClick={demoIncoming}>
          <span class={s.long}>{t('demo.incoming')}</span><span class={s.short}>{t('demo.incomingShort')}</span>
        </Button>
        <Button size="sm" variant="quiet" icon="more" label={t('demo.open')} aria-haspopup="dialog" onClick={() => setOpen(true)} />
      </span>
      <Sheet open={open} onClose={() => setOpen(false)} title={t('demo.title')}>
        <p class={sheetStyles.text}>{t('demo.text')} {t('demo.incomingHint')}</p>
        <Button variant="primary" icon="plus" onClick={() => { demoIncoming(); setOpen(false); }}>{t('demo.incoming')}</Button>
        <h3 class={sheetStyles.text}>{t('demo.state')}</h3>
        {chat ? (
          <div role="menu" aria-label={t('demo.state')}>
            {STATES.map((item) => (
              <Option key={item.value} label={t(item.label)} onSelect={() => { demoSetState(item.value); setOpen(false); }} />
            ))}
            <Option label={`${t('demo.draft')}: ${t('draft.sure')}`} onSelect={() => { demoSetDraft('sure'); setOpen(false); }} />
            <Option label={`${t('demo.draft')}: ${t('draft.check')}`} onSelect={() => { demoSetDraft('check'); setOpen(false); }} />
            <Option label={`${t('demo.draft')}: ${t('draft.unsure')}`} onSelect={() => { demoSetDraft('unsure'); setOpen(false); }} />
          </div>
        ) : <p class={sheetStyles.text}>{t('demo.noChat')}</p>}
        <h3 class={sheetStyles.text}>{t('demo.theme')}</h3>
        <Tabs<Theme>
          label={t('demo.theme')}
          value={theme.value}
          onChange={setTheme}
          items={[
            { value: 'auto', label: t('demo.theme.auto') },
            { value: 'light', label: t('demo.theme.light') },
            { value: 'dark', label: t('demo.theme.dark') },
          ]}
        />
        <div class={sheetStyles.actions}>
          <Button variant="quiet" icon="undo" onClick={() => { demoReset(); setOpen(false); }}>{t('demo.reset')}</Button>
        </div>
      </Sheet>
    </div>
  );
}
