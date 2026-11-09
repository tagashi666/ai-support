import type { JSX } from 'preact';
import { ME } from '@/demo/seed';
import { t, tn } from '@/i18n/ru';
import { pause, resume } from '@/lib/actions/chat';
import { clock, fullDate } from '@/lib/format/format';
import { isDesktop } from '@/lib/media';
import { navigate } from '@/lib/router';
import { serverOrder } from '@/lib/store/order';
import { aiLeads, chats, now, pausedUntil, waitingYou } from '@/lib/store/state';
import type { Message } from '@/lib/types';
import { ChatRow } from '@/features/chats/ChatRow';
import { StatusLine } from '@/features/chats/StatusLine';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Icon } from '@/ui/Icon';
import s from './today.module.css';

function greeting(at: number): string {
  const hour = new Date(at).getHours();
  const key = hour < 5 ? 'today.night' : hour < 12 ? 'today.morning' : hour < 18 ? 'today.day' : hour < 23 ? 'today.evening' : 'today.night';
  return t(key, { name: ME.name });
}

/** Вердикт одной-двумя фразами (6.1). */
function verdict(waiting: number, ai: number, paused: number | null): string[] {
  if (paused !== null) return [t('today.pausedVerdict', { time: clock(paused) })];
  if (waiting > 0) {
    return [t(waiting === 1 ? 'today.waiting' : 'today.waitingMany', { n: waiting, dialogs: tn('plural.dialogs', waiting) }), t('today.calm')];
  }
  if (ai > 0) return [t('today.nobody'), t('today.aiLeads', { n: ai, dialogs: tn('plural.dialogs', ai) })];
  return [t('today.empty')];
}

/**
 * «Сегодня»: одна фраза и три карточки — кому ответить, что делает помощник,
 * всё ли работает. compact — сводка справа на компьютере, пока диалог не выбран.
 */
export function Today({ compact = false }: { compact?: boolean }): JSX.Element {
  const at = now.value;
  const waiting = serverOrder(waitingYou.value);
  const paused = pausedUntil.value;
  const lines = verdict(waiting.length, aiLeads.value.length, paused);
  const open = (id: string) => navigate({ name: 'chats', id });
  const Heading = compact ? 'h2' : 'h1';
  // Последнее действие помощника — из тех же данных, что и список.
  const lastAi = chats.value
    .flatMap((chat) => chat.feed.filter((item): item is Message => item.type === 'message' && item.author === 'assistant')
      .map((message) => ({ chat, message })))
    .sort((a, b) => b.message.at - a.message.at)[0];

  const waitingCard = waiting.length > 0 && (
    <Card class={s.card} label={t('today.waitingCard')}>
      <h2 class={s.cardTitle}>{t('today.waitingCard')} <span class={`${s.count} num`}>{waiting.length}</span></h2>
      <div class={s.rows}>
        {waiting.slice(0, 5).map((chat) => <ChatRow key={chat.id} chat={chat} onOpen={() => open(chat.id)} />)}
      </div>
      <Button variant="link" size="sm" class={s.more} onClick={() => navigate({ name: 'chats', id: null })}>
        {t('today.allChats')} <Icon name="right" size={16} />
      </Button>
    </Card>
  );

  const awayCard = !compact && (
    <Card class={s.card} label={t('today.away')}>
      <h2 class={s.cardTitle}>{t('today.away')} <span class={s.cardMeta}>{t('today.awaySince', { time: clock(at - 7 * 60 * 60_000) })}</span></h2>
      <p class={s.text}>{t('today.awayText', { n: 3 })}</p>
      {waiting[0] && (
        <div class={s.actions}>
          <Button variant="secondary" size="sm" onClick={() => waiting[0] && open(waiting[0].id)}>{t('today.openFirst')}</Button>
        </div>
      )}
    </Card>
  );

  const assistantCard = (
    <Card class={`${s.card} ${s.ai}`} label={t('today.assistant')}>
      <h2 class={s.cardTitle}>{t('today.assistant')}</h2>
      <p class={s.mode}>
        <Icon name={paused ? 'pause' : 'spark'} size={18} />
        {paused ? t('today.modePaused', { time: clock(paused) }) : t('today.modeSuggest')}
      </p>
      <p class={s.text}>{paused ? t('today.modePausedHint') : t('today.modeSuggestHint')}</p>
      <div class={s.actions}>
        {paused
          ? <Button variant="primary" size="sm" onClick={resume}>{t('status.resume')}</Button>
          : <Button variant="secondary" size="sm" icon="pause" onClick={pause}>{t('today.pause')}</Button>}
        <Button variant="quiet" size="sm" onClick={() => navigate({ name: 'section', key: 'assistant' })}>
          {t('today.change')} <Icon name="right" size={16} />
        </Button>
      </div>
      {!compact && (
        <>
          <p class={s.small}>{t('today.dayStats')}</p>
          {lastAi && (
            <>
              <p class={s.small}>{t('today.lastAction', { name: lastAi.chat.name, time: clock(lastAi.message.at) })}</p>
              <blockquote class={s.quote}>{lastAi.message.text}</blockquote>
              <div class={s.actions}>
                <Button variant="quiet" size="sm" onClick={() => navigate({ name: 'chats', id: lastAi.chat.id })}>{t('today.look')}</Button>
                <Button variant="quiet" size="sm">{t('today.wrong')}</Button>
              </div>
            </>
          )}
        </>
      )}
    </Card>
  );

  const attentionCard = (
    <Card class={s.card} label={t('today.attention')}>
      <h2 class={s.cardTitle}>{t('today.attention')} <span class={`${s.cardMeta} num`}>2</span></h2>
      <ul class={s.list}>
        <li class={s.item}>
          <span class={s.itemText}>{t('today.ideas')}</span>
          <Button variant="link" size="sm" onClick={() => navigate({ name: 'section', key: 'knowledge' })}>{t('today.ideasAction')}</Button>
        </li>
        <li class={s.item}>
          <span class={s.itemText}>{t('today.version')}</span>
          <Button variant="link" size="sm" onClick={() => navigate({ name: 'section', key: 'system' })}>{t('today.versionAction')}</Button>
        </li>
      </ul>
    </Card>
  );

  return (
    <div class={s.screen} data-compact={compact ? 'true' : 'false'}>
      {!compact && <StatusLine />}
      <div class={s.inner}>
        <header class={s.head}>
          <div class={s.headRow}>
            <Heading class={s.greeting}>{greeting(at)}</Heading>
            {(isDesktop.value || compact) && <span class={s.date}>{fullDate(at)}</span>}
          </div>
          <p class={s.verdict}>{lines.join(' ')}</p>
        </header>
        <div class={s.grid}>
          <div class={s.col}>
            {waitingCard}
            {awayCard}
            {compact ? null : attentionCard}
          </div>
          <div class={s.col}>
            {assistantCard}
            {compact && attentionCard}
            <p class={s.system}>
              <span class={s.okDot} aria-hidden="true" />
              <span><strong>{t('today.system')}:</strong> {t('today.systemOk')}</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
