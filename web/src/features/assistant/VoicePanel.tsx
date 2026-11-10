import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { linkKey, validLinkUrl, type CustomerLink } from '@/lib/assistant/model';
import { setDraft, valueOf } from '@/lib/assistant/draft';
import { Button } from '@/ui/Button';
import { locked, Lock, TextField } from './fields';
import a from './assistant.module.css';

/** «Как общается» (6.7): манера, сообщение при передаче, название сервиса и ссылки для клиентов. */
export function VoicePanel(): JSX.Element {
  const links = (valueOf('customerLinks') ?? []) as CustomerLink[];
  const [adding, setAdding] = useState<{ title: string; url: string; when: string } | null>(null);
  const linksLocked = locked('customerLinks');
  const setLinks = (next: CustomerLink[]): void => setDraft('customerLinks', next);
  const addValid = adding !== null && adding.title.trim().length > 0 && adding.title.trim().length <= 80 && validLinkUrl(adding.url);
  const add = (): void => {
    if (!adding || !addValid) return;
    const key = linkKey(adding.title, new Set(links.map((link) => link.key)));
    setLinks([...links, { key, title: adding.title.trim(), url: adding.url.trim(), when: adding.when.trim() }]);
    setAdding(null);
  };
  return (
    <div class={a.panel}>
      <section class={a.group} aria-labelledby="as-voice">
        <h2 class={a.head} id="as-voice">{t('assistant.tab.voice')}</h2>
        <TextField field="brand" label={t('assistant.key.brand')} hint={t('assistant.brandHint')} min={1} max={60} />
        <TextField field="replyStyle" label={t('assistant.key.replyStyle')} hint={t('assistant.styleHint')} multiline max={1200} />
        <TextField field="handoffMessage" label={t('assistant.key.handoffMessage')} hint={t('assistant.handoffHint')} multiline min={5} max={600} />
      </section>
      <section class={a.group} aria-labelledby="as-links">
        <h2 class={a.head} id="as-links">{t('assistant.links.title')}</h2>
        <Lock field="customerLinks" />
        {links.length === 0 && <p class={a.muted}>{t('assistant.links.empty')}</p>}
        {links.length > 0 && (
          <ul class={a.links}>
            {links.map((link, index) => (
              <li key={link.key} class={a.link}>
                <span class={a.linkTitle}>{link.title}</span>
                <span class={a.linkUrl}>{link.url}</span>
                {link.when && <span class={a.muted}>{t('assistant.links.when', { when: link.when })}</span>}
                <span class={a.muted}>{t('assistant.links.example', { url: link.url })}</span>
                {!linksLocked && (
                  <Button variant="quiet" size="sm" onClick={() => setLinks(links.filter((_, i) => i !== index))}>{t('assistant.links.remove')}</Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!linksLocked && adding === null && links.length < 20 && (
          <Button variant="secondary" size="sm" icon="plus" onClick={() => setAdding({ title: '', url: '', when: '' })}>{t('assistant.links.add')}</Button>
        )}
        {adding && (
          <div class={a.linkForm}>
            <label class={a.field}><span class={a.label}>{t('assistant.links.name')}</span>
              <input class={a.input} maxLength={80} value={adding.title} onInput={(event) => setAdding({ ...adding, title: (event.target as HTMLInputElement).value })} /></label>
            <label class={a.field}><span class={a.label}>{t('assistant.links.url')}</span>
              <input class={a.input} type="url" inputMode="url" maxLength={600} value={adding.url}
                aria-invalid={adding.url && !validLinkUrl(adding.url) ? 'true' : undefined}
                onInput={(event) => setAdding({ ...adding, url: (event.target as HTMLInputElement).value })} />
              {adding.url && !validLinkUrl(adding.url) && <span class={a.error} role="alert">{t('assistant.links.badUrl')}</span>}</label>
            <label class={a.field}><span class={a.label}>{t('assistant.links.whenLabel')}</span>
              <input class={a.input} maxLength={300} value={adding.when} onInput={(event) => setAdding({ ...adding, when: (event.target as HTMLInputElement).value })} /></label>
            <div class={a.actions}>
              <Button variant="quiet" size="sm" onClick={() => setAdding(null)}>{t('wrong.cancel')}</Button>
              <Button variant="primary" size="sm" disabled={!addValid} onClick={add}>{t('assistant.links.addOne')}</Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
