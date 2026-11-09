import type { JSX } from 'preact';
import { t } from '@/i18n/ru';
import { sectionLabel } from '@/lib/labels';
import { liveCounts } from '@/lib/live/store';
import l from './live.module.css';

/**
 * Сводка рядом со списком и вместо «Сегодня» в живом режиме: числа с сервера.
 * «Ждут вас» — ваше число, «Ждут человека» — общее для всех (7.1 п.9).
 */
export function LiveSummary({ wide = false }: { wide?: boolean }): JSX.Element {
  const counts = liveCounts.value;
  const tiles: Array<{ label: string; value: number; tone?: 'attention' }> = counts ? [
    { label: t('chats.view.waiting'), value: counts.sections.mine, tone: 'attention' },
    { label: t('live.waitingHuman'), value: counts.waiting },
    { label: sectionLabel('ai'), value: counts.sections.ai },
    { label: sectionLabel('client'), value: counts.sections.client },
  ] : [];
  return (
    <div class={l.summary}>
      {wide && <h1 class={l.title}>{t('nav.today')}</h1>}
      <dl class={l.tiles}>
        {tiles.map((tile) => (
          <div key={tile.label} class={l.tile} data-tone={tile.tone}>
            <dt>{tile.label}</dt>
            <dd class="num">{tile.value}</dd>
          </div>
        ))}
      </dl>
      <p class={l.hint}>{wide ? t('live.todayLater') : t('live.threadHint')}</p>
      <p><a class={l.link} href="/">{t('live.openClassic')}</a></p>
    </div>
  );
}
