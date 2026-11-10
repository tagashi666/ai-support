import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { tr } from '@/i18n/sections/connections';
import { businessVerdict, cardsOf, isEmpty, type CardKind, type ConnectionCard, type WizardKind } from '@/lib/connections/model';
import { connections, connectionsError, connectionsState, loadConnections, rights } from '@/lib/connections/store';
import { navigate } from '@/lib/router';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import { ProfileSheet } from './ProfileSheet';
import { Wizard } from './Wizard';
import c from './connections.module.css';
import { useInvalidate } from '@/lib/live/store';

const BOTFATHER = '@BotFather';

const HELP: Record<CardKind, Parameters<typeof tr>[0]> = {
  bot: 'connections.help.bot',
  business: 'connections.help.business',
  bedolaga: 'connections.help.bedolaga',
  remnawave: 'connections.help.remnawave',
  minishop: 'connections.help.minishop',
};

const WIZARD_OF: Partial<Record<CardKind, WizardKind>> = { bot: 'telegram_bot', business: 'business', remnawave: 'remnawave', minishop: 'minishop' };

interface WizardOpen {
  kind: WizardKind | null;
}

/** Вкладка «Каналы и источники» (6.11): карточки подключений без запроса в сеть. */
export function ChannelsPanel(): JSX.Element {
  const data = connections.value;
  const state = connectionsState.value;
  const r = rights.value;
  const [wizard, setWizard] = useState<WizardOpen | null>(null);
  const [profile, setProfile] = useState<string | null>(null);
  const [info, setInfo] = useState<ConnectionCard | null>(null);
  const [verdict, setVerdict] = useState<'yes' | 'no' | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => { void loadConnections(); }, []);
  useInvalidate('connections', () => void loadConnections());

  if (state === 'loading' || state === 'idle') return <div class={c.skeleton} key="skeleton" aria-hidden="true" />;
  if (!data) {
    return (
      <div class={c.panel}>
        <p class={c.error} role="alert">{tr('connections.loadFailed', { reason: connectionsError.value })}</p>
        <div class={c.actions}><Button variant="secondary" onClick={() => void loadConnections()}>{tr('connections.retry')}</Button></div>
      </div>
    );
  }

  const now = Date.now();
  const cards = cardsOf(data, now);
  const empty = isEmpty(data);
  const sourceName = (id: string | undefined): string => data.sources.find((source) => source.id === id)?.name ?? '';

  const checkBusiness = async (): Promise<void> => {
    setChecking(true);
    const fresh = await loadConnections();
    setChecking(false);
    setVerdict(fresh && businessVerdict(fresh) ? 'yes' : 'no');
  };

  const connect = (kind: WizardKind | null): void => setWizard({ kind });

  const actionsOf = (card: ConnectionCard): JSX.Element | null => {
    if (card.kind === 'bot') {
      return (
        <>
          {r.services && card.sourceId && <Button variant="secondary" size="sm" onClick={() => setProfile(card.sourceId ?? null)}>{tr('connections.profile.open')}</Button>}
          <Button variant="secondary" size="sm" aria-haspopup="dialog" aria-label={tr('connections.more', { name: card.title })} onClick={() => setInfo(card)}>{tr('connections.details')}</Button>
        </>
      );
    }
    if (card.kind === 'business') {
      return (
        <>
          <Button variant="secondary" size="sm" disabled={checking} onClick={() => void checkBusiness()}>{tr('connections.business.check')}</Button>
          <Button variant="secondary" size="sm" aria-haspopup="dialog" aria-label={tr('connections.more', { name: card.title })} onClick={() => setInfo(card)}>{tr('connections.details')}</Button>
        </>
      );
    }
    if (!card.connected) {
      return r.sources && card.kind === 'minishop'
        ? <Button variant="primary" size="sm" onClick={() => connect('minishop')}>{tr('connections.connect')}</Button>
        : card.kind === 'bedolaga' ? <Button variant="secondary" size="sm" onClick={() => setInfo(card)}>{tr('connections.details')}</Button> : (
          r.sources ? <Button variant="primary" size="sm" onClick={() => connect('remnawave')}>{tr('connections.connect')}</Button> : null
        );
    }
    return <Button variant="secondary" size="sm" onClick={() => setInfo(card)}>{tr('connections.details')}</Button>;
  };

  return (
    <div class={c.panel}>
      {empty && (
        <div class={c.empty}>
          <p class={c.emptyTitle}>{tr('connections.empty.title')}</p>
          {r.sources && <Button variant="primary" onClick={() => connect('telegram_bot')}>{tr('connections.empty.action')}</Button>}
        </div>
      )}
      <ul class={c.grid} aria-label={tr('connections.cards')}>
        {cards.map((card) => (
          <li key={card.id}>
            <Card class={c.card} label={card.title}>
              <h2 class={c.cardTitle}>{card.title}</h2>
              <p class={c.state} data-tone={card.tone}><span class={c.dot} aria-hidden="true" /><span>{card.state}</span></p>
              {card.kind === 'business' && verdict && (
                <p class={c.verdict} role="status">{verdict === 'yes' ? tr('connections.business.yes') : tr('connections.business.no')}</p>
              )}
              <div class={c.actions}>{actionsOf(card)}</div>
            </Card>
          </li>
        ))}
      </ul>
      {r.sources && <div class={c.actions}><Button variant="secondary" icon="plus" onClick={() => connect(null)}>{tr('connections.add')}</Button></div>}

      {wizard && <Wizard initial={wizard.kind} onClose={() => setWizard(null)} />}
      {profile && <ProfileSheet sourceId={profile} sourceName={sourceName(profile)} onClose={() => setProfile(null)} />}
      <Sheet open={info !== null} onClose={() => setInfo(null)} title={info?.title ?? ''}>
        {info && (
          <>
            <p class={c.state} data-tone={info.tone}><span class={c.dot} aria-hidden="true" /><span>{info.state}</span></p>
            <p class={sheetStyles.text}>{tr(HELP[info.kind], { botfather: BOTFATHER })}</p>
            <div class={sheetStyles.actions}>
              {r.sources && WIZARD_OF[info.kind] && info.kind !== 'bot' && (
                <Button variant="secondary" onClick={() => { const kind = WIZARD_OF[info.kind] ?? null; setInfo(null); connect(kind); }}>
                  {info.kind === 'business' ? tr('connections.business.again') : tr('connections.connectAnother')}
                </Button>
              )}
              {(info.kind === 'bot' || info.kind === 'business') && (
                <Button variant="secondary" onClick={() => { setInfo(null); navigate({ name: 'chats', id: null }); }}>{tr('connections.openChats')}</Button>
              )}
              <Button variant="primary" onClick={() => setInfo(null)}>{tr('connections.close')}</Button>
            </div>
          </>
        )}
      </Sheet>
    </div>
  );
}
