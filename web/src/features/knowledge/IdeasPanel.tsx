import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { IdeaRejectReason } from '@shared/api-types';
import { t } from '@/i18n/ru';
import { dayMonth } from '@/lib/format/format';
import { articleRoute, ideaSourceLabel, REJECT_LABEL, REJECT_REASONS } from '@/lib/knowledge/model';
import { decideIdea, ideas, ideasState, loadIdeas, pendingIdeas, readArticle, similarArticles } from '@/lib/knowledge/store';
import { can } from '@/lib/assistant/store';
import { isDesktop } from '@/lib/media';
import { navigate } from '@/lib/router';
import { Button } from '@/ui/Button';
import { Option, Sheet } from '@/ui/Sheet';
import k from './knowledge.module.css';

/** Уверенность модели словом (как в ленте, без чисел). */
function confidenceWord(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return value >= 0.85 ? t('kb.idea.sure') : value >= 0.6 ? t('kb.idea.check') : t('kb.idea.unsure');
}

const openIdea = (id: number | null): void => navigate({ name: 'section', key: 'knowledge', sub: 'ideas', ...(id !== null ? { item: String(id) } : {}) }, true);

function IdeaCard({ id, index, total }: { id: number; index: number; total: number }): JSX.Element {
  const row = pendingIdeas.value.find((item) => item.id === id)!;
  const [text, setText] = useState<string | null | 'error'>(null);
  const [similar, setSimilar] = useState<Array<{ id: number; title: string; ext_id: string | null; source: string }>>([]);
  const [rejecting, setRejecting] = useState(false);
  useEffect(() => {
    let alive = true;
    setText(null); setSimilar([]);
    void readArticle('draft', row.file_name).then((doc) => { if (alive) setText(doc === 'error' ? 'error' : doc?.text ?? 'error'); });
    void similarArticles(row.title).then((found) => { if (alive) setSimilar(found.filter((item) => item.ext_id !== row.file_name)); });
    return () => { alive = false; };
  }, [id]);
  const ids = pendingIdeas.value.map((item) => item.id);
  const decide = (choice: { decision: 'approved' } | { decision: 'rejected'; reason: IdeaRejectReason | null }): void => {
    setRejecting(false);
    const next = decideIdea(id, choice, (back) => openIdea(back));
    openIdea(next);
  };
  const body = typeof text === 'string' && text !== 'error' ? text.replace(/<!--[\s\S]*?-->/g, '').replace(/^#\s+.*\n+/, '').trim() : '';
  const word = confidenceWord(row.confidence);
  return (
    <section class={k.card} aria-label={row.title}>
      <div class={k.cardHead}>
        <span class={k.muted}>{t('kb.idea.counter', { n: index + 1, total })}</span>
        <div class={k.actions}>
          <Button variant="quiet" size="sm" icon="back" label={t('kb.idea.prev')} disabled={index === 0} onClick={() => openIdea(ids[index - 1] ?? null)} />
          <Button variant="quiet" size="sm" icon="right" label={t('kb.idea.next')} disabled={index >= total - 1} onClick={() => openIdea(ids[index + 1] ?? null)} />
        </div>
      </div>
      <h2 class={k.cardTitle}>{row.title}</h2>
      <p class={k.muted}>
        {t('kb.idea.from', { source: t(ideaSourceLabel(row.source)), date: dayMonth(row.created_at) })}
        {word && ` · ${t('kb.idea.confidence', { word })}`}
      </p>
      {text === null && <div class={k.skeleton} aria-hidden="true" />}
      {text === 'error' && <p class={k.error} role="alert">{t('kb.idea.noText')}</p>}
      {body && <div class={k.body}>{body}</div>}
      {similar.length > 0 && (
        <p class={k.muted}>
          {t('kb.idea.similar')}{' '}
          {similar.map((item, i) => (
            <span key={item.id}>{i > 0 && ', '}{item.source === 'files' && item.ext_id
              ? <Button variant="link" size="sm" onClick={() => navigate(articleRoute(item.ext_id!))}>«{item.title}»</Button>
              : `«${item.title}»`}</span>
          ))}
        </p>
      )}
      <div class={k.actions}>
        <Button variant="primary" disabled={text === null || text === 'error'} onClick={() => decide({ decision: 'approved' })}>{t('kb.idea.publish')}</Button>
        {can('knowledge:manage') && (
          <Button onClick={() => navigate(articleRoute(row.file_name))}>{t('kb.idea.edit')}</Button>
        )}
        <Button variant="quiet" aria-haspopup="dialog" onClick={() => setRejecting(true)}>{t('kb.idea.reject')} ▾</Button>
      </div>
      <p class={k.hint}>{t('kb.idea.publishHint')}</p>
      <Sheet open={rejecting} onClose={() => setRejecting(false)} title={t('kb.idea.rejectTitle')}>
        <div class={k.reasons} role="menu" aria-label={t('kb.idea.rejectTitle')}>
          {REJECT_REASONS.map((reason) => (
            <Option key={reason} label={t(REJECT_LABEL[reason])} onSelect={() => decide({ decision: 'rejected', reason })} />
          ))}
        </div>
      </Sheet>
    </section>
  );
}

/**
 * «Идеи из диалогов» (6.6): по одной карточке, как разбор почты. Решение
 * уходит после окна отмены, следующая открывается сразу.
 */
export function IdeasPanel({ current }: { current: number | null }): JSX.Element {
  const list = pendingIdeas.value;
  const desktop = isDesktop.value;
  const chosen = current !== null && list.some((row) => row.id === current) ? current : desktop ? list[0]?.id ?? null : null;
  if (ideasState.value !== 'error' && !ideas.value) return <div class={k.skeleton} aria-hidden="true" />;
  if (ideasState.value === 'error') {
    return <p class={k.error} role="alert">{t('kb.loadFailed')} <Button variant="link" size="sm" onClick={() => void loadIdeas()}>{t('live.retry')}</Button></p>;
  }
  if (!list.length) {
    return (
      <div class={k.empty}>
        <p class={k.muted}>{ideas.value?.length === 0 ? t('kb.idea.none') : t('kb.idea.allDone')}</p>
        {can('settings:read') && <Button onClick={() => navigate({ name: 'section', key: 'assistant' })}>{t('kb.idea.learnSetting')}</Button>}
      </div>
    );
  }
  const index = chosen === null ? -1 : list.findIndex((row) => row.id === chosen);
  // Телефон: список или карточка; компьютер — рядом.
  const showList = desktop || chosen === null;
  return (
    <div class={k.ideas}>
      {showList && (
        <div class={k.panel}>
          <p class={k.muted}>{t('kb.idea.perDay')}</p>
          <ul class={k.list} aria-label={t('kb.tab.ideas')}>
            {list.map((row) => (
              <li key={row.id}>
                <button type="button" class={k.item} aria-current={row.id === chosen ? 'true' : undefined} onClick={() => openIdea(row.id)}>
                  <span class={k.itemTitle}>{row.title}</span>
                  <span class={k.itemMeta}>{t(ideaSourceLabel(row.source))} · {dayMonth(row.created_at)}</span>
                </button>
              </li>
            ))}
          </ul>
          {!desktop && <Button variant="primary" onClick={() => openIdea(list[0]!.id)}>{t('kb.idea.oneByOne')}</Button>}
        </div>
      )}
      {chosen !== null && index >= 0 && (
        <div class={k.panel}>
          {!desktop && <Button variant="link" onClick={() => openIdea(null)}>← {t('kb.tab.ideas')}</Button>}
          <IdeaCard key={chosen} id={chosen} index={index} total={list.length} />
        </div>
      )}
    </div>
  );
}
