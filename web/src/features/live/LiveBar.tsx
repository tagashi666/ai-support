import type { JSX } from 'preact';
import { t } from '@/i18n/ru';
import { bootstrap, setMode, signOut } from '@/lib/live/store';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import s from '@/app/shell.module.css';

/** Полоса живого режима: кто вошёл, что ещё в классике, и путь назад в неё. */
export function LiveBar(): JSX.Element {
  const me = bootstrap.value?.me;
  return (
    <div class={s.demo}>
      <span class={s.demoTag}><Icon name="chats" size={16} />{t('live.badge')}</span>
      <span class={s.demoText}>{me ? `${me.name} · ` : ''}{t('live.text')}</span>
      <span class={s.demoActions}>
        <a class={s.demoLink} href="/?ui=classic">{t('nav.classic')}</a>
        <Button size="sm" variant="secondary" icon="flask" onClick={() => setMode('demo')}>{t('live.toDemo')}</Button>
        <Button size="sm" variant="quiet" onClick={signOut}>{t('live.signOut')}</Button>
      </span>
    </div>
  );
}
