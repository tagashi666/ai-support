import type { JSX } from 'preact';
import { t } from '@/i18n/ru';
import { letterKeys, navKeys } from '@/lib/device';
import { modLabel } from '@/lib/keys';
import { keysHelpOpen } from '@/lib/palette/run';
import { navigate } from '@/lib/router';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import s from './palette.module.css';

/** Полный список клавиш по `?` (7.3). Подписи клавиш латиницей, привязка — по физической клавише. */
export function KeysHelp(): JSX.Element {
  const mod = modLabel();
  const close = (): void => { keysHelpOpen.value = false; };
  const rows: Array<[string, string]> = [
    [t('keys.palette'), `${mod}K`],
    [t('keys.help'), '?'],
    [t('keys.close'), 'Esc'],
    [t('keys.undo'), `${mod}Z`],
  ];
  const nav: Array<[string, string]> = [
    [t('keys.goToday'), 'G S'], [t('keys.goChats'), 'G D'], [t('keys.goKnowledge'), 'G K'], [t('keys.goAssistant'), 'G A'],
    [t('keys.rows'), '↓ ↑ Home End'], [t('keys.open'), 'Enter'], [t('keys.search'), '/'], [t('keys.prevNext'), '[ ]'],
  ];
  const thread: Array<[string, string]> = [
    [t('keys.send'), `${mod}↵`], [t('keys.attach'), `${mod}⇧U`],
  ];
  const letters: Array<[string, string]> = [
    [t('keys.resolve'), 'E'], [t('keys.note'), 'N'], [t('keys.reply'), 'R'], [t('keys.take'), 'T'], [t('keys.client'), 'I'], [t('keys.select'), 'X'],
  ];
  const block = (title: string, list: Array<[string, string]>, off = false) => (
    <>
      <p class={s.keyHead}>{title}{off ? ` · ${t('keys.off')}` : ''}</p>
      <dl class={s.keys}>{list.map(([label, key]) => <div key={label} class={s.keyRow}><dt>{label}</dt><dd><kbd class={s.kbd}>{key}</kbd></dd></div>)}</dl>
    </>
  );
  return (
    <Sheet open={keysHelpOpen.value} onClose={close} title={t('keys.title')}>
      {block(t('keys.everywhere'), rows)}
      {block(t('keys.navigation'), nav, !navKeys.value)}
      {block(t('keys.thread'), thread)}
      {block(t('keys.letters'), letters, !letterKeys.value)}
      <p class={s.status}>{t('keys.layoutHint')}</p>
      <div>
        <Button variant="secondary" size="sm" onClick={() => { close(); navigate({ name: 'section', key: 'device' }); }}>{t('keys.settings')}</Button>
      </div>
    </Sheet>
  );
}
