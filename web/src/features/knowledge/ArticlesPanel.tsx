import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { listTime } from '@/lib/format/format';
import { articleRoute, filterArticles, STATE_LABEL, type ArticleFilter } from '@/lib/knowledge/model';
import { kb, kbState, loadKb, rights, rows } from '@/lib/knowledge/store';
import { now } from '@/lib/store/state';
import { href, navigate } from '@/lib/router';
import { Button } from '@/ui/Button';
import { MineSheet } from './MineSheet';
import k from './knowledge.module.css';

const FILTERS: readonly { value: ArticleFilter; label: 'kb.filter.all' | 'kb.filter.published' | 'kb.filter.draft' | 'kb.filter.edited' }[] = [
  { value: 'all', label: 'kb.filter.all' },
  { value: 'published', label: 'kb.filter.published' },
  { value: 'draft', label: 'kb.filter.draft' },
  { value: 'edited', label: 'kb.filter.edited' },
];

/** «Статьи» (6.6): заголовок, начало текста, дата и состояние; поиск и фильтр на месте. */
export function ArticlesPanel(): JSX.Element {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ArticleFilter>('all');
  const [mining, setMining] = useState(false);
  const r = rights.value;
  const all = rows.value;
  const shown = filterArticles(all, filter, query);
  // Время у всех строк одно и то же — это шум, не показываем (R-19).
  const times = new Set(shown.map((row) => listTime(row.updatedAt, now.value)));
  const open = (name: string): void => navigate(articleRoute(name));
  return (
    <div class={k.panel}>
      <div class={k.bar}>
        <input class={`${k.input} ${k.search}`} type="search" value={query} aria-label={t('kb.search')} placeholder={t('kb.search')}
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)} />
        {r.manage && <Button variant="primary" icon="plus" onClick={() => navigate({ name: 'section', key: 'knowledge', sub: 'new' })}>{t('kb.new')}</Button>}
      </div>
      {r.review && (
        <div class={k.filters} role="radiogroup" aria-label={t('kb.filter.label')}>
          {FILTERS.map((item) => (
            <label key={item.value} class={k.filter} data-checked={filter === item.value ? 'true' : 'false'}>
              <input type="radio" name="kb-filter" checked={filter === item.value} onChange={() => setFilter(item.value)} />
              {t(item.label)}
            </label>
          ))}
        </div>
      )}
      {kbState.value === 'loading' && !kb.value && <div class={k.skeleton} key="skeleton" aria-hidden="true" />}
      {kbState.value === 'error' && (
        <p class={k.error} role="alert">{t('kb.loadFailed')} <Button variant="link" size="sm" onClick={() => void loadKb()}>{t('live.retry')}</Button></p>
      )}
      {kb.value && all.length === 0 && (
        <div class={k.empty}>
          <p class={k.muted}>{t('kb.empty')}</p>
          <div class={k.actions}>
            {r.manage && <Button variant="primary" onClick={() => navigate({ name: 'section', key: 'knowledge', sub: 'new' })}>{t('kb.new')}</Button>}
            {r.mine && <Button onClick={() => setMining(true)}>{t('kb.mine.open')}</Button>}
          </div>
        </div>
      )}
      {kb.value && all.length > 0 && shown.length === 0 && <p class={k.muted}>{t('kb.nothingFound')}</p>}
      {shown.length > 0 && (
        <ul class={k.list} aria-label={t('kb.tab.articles')}>
          {shown.map((row) => (
            <li key={row.name}>
              <a class={k.item} href={href(articleRoute(row.name))}
                onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey) return; event.preventDefault(); open(row.name); }}>
                <span class={k.itemHead}>
                  <span class={k.itemTitle}>{row.title}</span>
                  {times.size > 1 && <span class={k.itemMeta}>{listTime(row.updatedAt, now.value)}</span>}
                </span>
                {/* Одна метка на строку (R2 B): опубликованная — без метки, иначе состояние или «идея на проверке». */}
                {(row.idea || row.state !== 'published') && (
                  <span class={k.itemMeta}>
                    <span class={k.tag} data-tone={row.idea ? 'idea' : undefined}>{row.idea ? t('kb.state.idea') : t(STATE_LABEL[row.state])}</span>
                  </span>
                )}
                {row.excerpt && <span class={k.itemText}>{row.excerpt}</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
      {r.mine && all.length > 0 && <div><Button variant="link" onClick={() => setMining(true)}>{t('kb.mine.open')}</Button></div>}
      {!r.review && r.manage && <p class={k.hint}>{t('kb.draftsHidden')}</p>}
      <MineSheet open={mining} onClose={() => setMining(false)} />
    </div>
  );
}
