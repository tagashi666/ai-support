import type { JSX } from 'preact';
import { t, type Key } from '@/i18n/ru';
import { navigate, type SectionKey } from '@/lib/router';
import { Button } from '@/ui/Button';
import { Icon, type IconName } from '@/ui/Icon';
import s from './placeholder.module.css';

const NAMES: Record<SectionKey, Key> = {
  knowledge: 'nav.knowledge',
  assistant: 'nav.assistant',
  reports: 'nav.reports',
  connections: 'nav.connections',
  team: 'nav.team',
  system: 'nav.system',
  device: 'nav.device',
};

/** Разделы, которых в прототипе нет: честная заглушка, а не имитация. */
export function Placeholder({ section }: { section: SectionKey }): JSX.Element {
  return (
    <div class={s.wrap}>
      <h1 class={s.title}>{t('placeholder.title', { name: t(NAMES[section]) })}</h1>
      <p class={s.text}>{t('placeholder.text')}</p>
      <Button variant="secondary" onClick={() => navigate({ name: 'today' })}>{t('placeholder.toToday')}</Button>
    </div>
  );
}

const MORE: readonly { key: SectionKey; icon: IconName }[] = [
  { key: 'reports', icon: 'reports' },
  { key: 'connections', icon: 'connections' },
  { key: 'team', icon: 'team' },
  { key: 'system', icon: 'system' },
  { key: 'device', icon: 'client' },
];

/** «Ещё» на телефоне: редкие разделы списком (5.1). */
export function MoreScreen(): JSX.Element {
  return (
    <div class={s.more}>
      <h1 class={s.title}>{t('nav.more')}</h1>
      <ul class={s.list}>
        {MORE.map((item) => (
          <li key={item.key}>
            <button type="button" class={s.item} onClick={() => navigate({ name: 'section', key: item.key })}>
              <Icon name={item.icon} />
              <span class={s.itemText}>{t(NAMES[item.key])}</span>
              <Icon name="right" size={18} />
            </button>
          </li>
        ))}
        <li>
          <a class={s.item} href="/?ui=classic">
            <Icon name="back" />
            <span class={s.itemText}>{t('nav.classic')}</span>
          </a>
        </li>
      </ul>
    </div>
  );
}
