import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { t, type Key } from '@/i18n/ru';
import { bootstrap, useInvalidate } from '@/lib/live/store';
import { articleName } from '@/lib/knowledge/model';
import { loadIdeas, loadKb, pendingIdeas, rights } from '@/lib/knowledge/store';
import { navigate } from '@/lib/router';
import { Tabs } from '@/ui/Tabs';
import { ArticleEditor } from './ArticleEditor';
import { ArticlesPanel } from './ArticlesPanel';
import { HintsPanel } from './HintsPanel';
import { IdeasPanel } from './IdeasPanel';
import { TemplatesPanel } from './TemplatesPanel';
import k from './knowledge.module.css';

type Tab = 'articles' | 'ideas' | 'templates' | 'hints';
const SUB: Record<Tab, string | undefined> = { articles: undefined, ideas: 'ideas', templates: 'templates', hints: 'hints' };
const LABEL: Record<Tab, Key> = { articles: 'kb.tab.articles', ideas: 'kb.tab.ideas', templates: 'kb.tab.templates', hints: 'kb.tab.hints' };

/** Вкладки по правам (6.6, состояния): без knowledge:review нет «Идей», без Bedolaga — «Подсказок». */
function tabsFor(): Tab[] {
  const tabs: Tab[] = [];
  const r = rights.value;
  if (r.read) tabs.push('articles');
  if (r.review) tabs.push('ideas');
  if (r.templates) tabs.push('templates');
  if (r.read && bootstrap.value?.capabilities.bedolaga) tabs.push('hints');
  return tabs;
}

/**
 * «Знания» (6.6): Статьи · Идеи из диалогов N · Шаблоны · Подсказки по кабинету.
 * Редактор статьи — отдельная страница: /next/knowledge/articles/<имя>, новая — /next/knowledge/new.
 */
export function KnowledgeScreen({ sub, item }: { sub?: string; item?: string }): JSX.Element {
  const ready = bootstrap.value !== null;
  useEffect(() => { if (ready) { void loadKb(); void loadIdeas(); } }, [ready]);
  // L-4: чужая правка статьи или новая идея — открытый раздел перечитывает себя.
  useInvalidate('kb', () => { if (ready) void loadKb(); });
  useInvalidate('ideas', () => { if (ready) void loadIdeas(); });
  if (ready && (sub === 'new' || (sub === 'articles' && item))) {
    return <ArticleEditor key={item ?? 'new'} name={sub === 'new' || !item ? null : articleName(item)} />;
  }
  const tabs = tabsFor();
  const asked = (Object.keys(SUB) as Tab[]).find((tab) => SUB[tab] === sub) ?? 'articles';
  const tab: Tab | undefined = tabs.includes(asked) ? asked : tabs[0];
  const count = pendingIdeas.value.length || (bootstrap.value?.counts.ideas ?? 0);
  return (
    <div class={k.screen}>
      <div class={k.inner}>
        <h1 class={k.title}>{t('nav.knowledge')}</h1>
        {!ready ? <div class={k.skeleton} key="skeleton" aria-hidden="true" /> : tabs.length === 0 ? <p class={k.muted}>{t('kb.noAccess')}</p> : (
          <>
            <div class={k.tabsScroll}>
              <Tabs<Tab> label={t('nav.knowledge')} value={tab ?? 'articles'}
                onChange={(next) => navigate({ name: 'section', key: 'knowledge', ...(SUB[next] ? { sub: SUB[next] } : {}) }, true)}
                items={tabs.map((value) => ({ value, label: t(LABEL[value]), ...(value === 'ideas' ? { count } : {}) }))} />
            </div>
            {tab === 'articles' && <ArticlesPanel />}
            {tab === 'ideas' && <IdeasPanel current={item ? Number(item) : null} />}
            {tab === 'templates' && <TemplatesPanel />}
            {tab === 'hints' && <HintsPanel />}
          </>
        )}
      </div>
    </div>
  );
}
