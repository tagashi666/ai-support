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
    <div class={`${s.demo} ${s.liveBar}`}>
      <span class={s.demoTag}><Icon name="chats" size={16} />{t('live.badge')}</span>
      <span class={s.demoText}>{me ? `${me.name} · ` : ''}{t('live.text')}</span>
      <span class={s.demoActions}>
        {/* На узком подписи прячутся (одна строка, ~52 px), имя берётся из aria-label и подсказки. */}
        <a class={s.demoLink} href="/?ui=classic" aria-label={t('nav.classic')} title={t('nav.classic')}>
          <Icon name="back" size={18} /><span class={s.long}>{t('nav.classic')}</span>
        </a>
        <Button size="sm" variant="secondary" icon="flask" aria-label={t('live.toDemo')} title={t('live.toDemo')} onClick={() => setMode('demo')}>
          <span class={s.long}>{t('live.toDemo')}</span>
        </Button>
        <Button size="sm" variant="quiet" icon="lock" aria-label={t('live.signOut')} title={t('live.signOut')} onClick={signOut}>
          <span class={s.long}>{t('live.signOut')}</span>
        </Button>
      </span>
    </div>
  );
}
