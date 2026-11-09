import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { ClientPanel } from '@/features/client/ClientPanel';
import { t } from '@/i18n/ru';
import {
  copyLink, giveBack, hide, intercept, reopen, resolve, resume, setModeHere, take, toggleImportant, waitClient,
  type HereMode,
} from '@/lib/actions/chat';
import { duration, roughDuration } from '@/lib/format/format';
import { channelLabel, chipView, reasonView } from '@/lib/labels';
import { isSplit, isWide } from '@/lib/media';
import { navigate } from '@/lib/router';
import {
  clientPinned, composerMode, effectiveWho, now, pausedUntil, textOf, windowClosed,
} from '@/lib/store/state';
import type { Chat } from '@/lib/types';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Chip';
import { Option, Sheet, sheetStyles } from '@/ui/Sheet';
import { Composer } from './Composer';
import { DraftCard } from './DraftCard';
import { Feed } from './Feed';
import s from './thread.module.css';

const THREE_HOURS = 3 * 60 * 60_000;

/** Строка под именем: «ждёт 2 ч», «вы ведёте», «ответить можно ещё 2 ч 40 мин». */
function headStatus(chat: Chat, at: number): { text: string; attention: boolean } {
  const left = chat.windowEndsAt !== undefined ? chat.windowEndsAt - at : null;
  if (left !== null && left > 0 && left < THREE_HOURS && chat.section !== 'done') {
    return { text: t('thread.windowLeft', { left: duration(left) }), attention: true };
  }
  if (chat.section === 'mine' && chat.waitingSince !== undefined) {
    return { text: t('thread.waits', { for: roughDuration(at - chat.waitingSince) }), attention: false };
  }
  if (chat.who.kind === 'youLead') return { text: t('thread.youLead'), attention: false };
  return { text: reasonView(chat.reason, at, chat.waitingSince).text, attention: false };
}

/**
 * Диалог (6.3): лента трёх голосов, один рычаг «кто отвечает» с главной
 * кнопкой, черновик помощника отдельной карточкой над полем ответа.
 */
export function Thread({ chat }: { chat: Chat }): JSX.Element {
  const at = now.value;
  const mode = composerMode.value[chat.id] ?? 'reply';
  const typing = mode === 'reply' && textOf(chat.id).trim().length > 0;
  const who = effectiveWho(chat, pausedUntil.value);
  const chip = chipView(who, typing);
  const closed = windowClosed(chat, at);
  const status = headStatus(chat, at);
  const [sheet, setSheet] = useState<'who' | 'more' | 'intercept' | 'client' | 'auto' | null>(null);
  const close = () => setSheet(null);
  const done = chat.section === 'done';

  const primary = (() => {
    switch (chip.primary) {
      case 'take': return <Button variant="primary" onClick={() => take(chat.id)}>{t('who.take')}</Button>;
      case 'giveBack': return <Button variant="secondary" icon="spark" onClick={() => giveBack(chat.id)}>{t('who.giveBack')}</Button>;
      case 'resume': return <Button variant="primary" onClick={resume}>{t('who.resume')}</Button>;
      case 'intercept': return <Button variant="secondary" onClick={() => setSheet('intercept')}>{t('who.intercept')}</Button>;
      case 'reopen': return <Button variant="secondary" onClick={() => reopen(chat.id)}>{t('thread.reopen')}</Button>;
      default: return null;
    }
  })();

  const openClient = (): void => {
    if (isWide.value) clientPinned.value = !(clientPinned.value ?? false);
    else setSheet('client');
  };

  const pickMode = (next: HereMode): void => {
    close();
    if (next === 'aiAuto') { setSheet('auto'); return; }
    setModeHere(chat.id, next);
  };

  return (
    <div class={s.thread}>
      <header class={s.head}>
        <div class={s.headTop}>
          {!isSplit.value && (
            <Button variant="quiet" icon="back" label={t('nav.back')} class={s.back} onClick={() => navigate({ name: 'chats', id: null })} />
          )}
          <span class={s.headAvatar}><Avatar name={chat.name} size="s" channel={chat.channel} /></span>
          <div class={s.headName}>
            <h2 class={s.name}>{chat.name}</h2>
            <p class={s.sub}>
              <span>{channelLabel(chat.channel)}</span>
              <span aria-hidden="true">·</span>
              <span class={status.attention ? s.subAttention : undefined}>{status.text}</span>
            </p>
          </div>
          <div class={s.headActions}>
            {!done && <Button variant="secondary" size="sm" icon="check" onClick={() => resolve(chat.id)}>{t('thread.resolve')}</Button>}
            <Button variant="quiet" size="sm" icon="more" label={t('thread.more')} aria-haspopup="dialog" onClick={() => setSheet('more')} />
            {isSplit.value
              ? <Button variant="quiet" size="sm" icon="client" aria-pressed={isWide.value ? Boolean(clientPinned.value) : undefined} onClick={openClient}>{t('thread.client')}</Button>
              : <Button variant="quiet" size="sm" icon="client" label={t('thread.client')} onClick={openClient} />}
          </div>
        </div>
        <div class={s.chipRow}>
          <Chip text={chip.text} tone={chip.tone} lead={chip.lead} menu={chip.menu} onClick={() => setSheet('who')} />
          {primary}
        </div>
      </header>

      <Feed chat={chat} />

      <footer class={s.foot}>
        {who.kind === 'colleague' && <p class={s.notice}>{t('composer.colleagueLeads', { name: who.name })}</p>}
        {chat.draft && who.kind !== 'colleague' && !done && <DraftCard chat={chat} closed={closed} typing={typing} />}
        {closed && mode === 'reply' && !done ? (
          <section class={s.windowCard} aria-label={t('window.closedTitle')}>
            <p class={s.windowTitle}>{t('window.closedTitle')}</p>
            <p class={s.windowText}>{t('window.closedText')}</p>
            <div class={s.windowActions}>
              <Button variant="secondary" size="sm" icon="lock" onClick={() => { composerMode.value = { ...composerMode.value, [chat.id]: 'note' }; }}>{t('window.note')}</Button>
              <Button variant="secondary" size="sm" onClick={() => waitClient(chat.id)}>{t('window.waitClient')}</Button>
              <Button variant="secondary" size="sm" icon="check" onClick={() => resolve(chat.id)}>{t('window.resolve')}</Button>
            </div>
            <p class={s.windowFoot}>{t('window.comesBack')}</p>
          </section>
        ) : (
          <Composer chat={chat} noteOnly={who.kind === 'colleague'} closed={closed} />
        )}
      </footer>

      <Sheet open={sheet === 'who'} onClose={close} title={t('who.sheetTitle')}>
        <p class={sheetStyles.text}>{t('who.sheetHint')}</p>
        <div role="menu" aria-label={t('who.sheetTitle')}>
          {(who.kind === 'handed' || who.kind === 'youLead') && (
            <Option label={t('who.giveBack')} onSelect={() => { close(); giveBack(chat.id); }} />
          )}
          {who.kind === 'paused' && <Option label={t('who.resume')} onSelect={() => { close(); resume(); }} />}
          <Option label={t('who.asEverywhere')} onSelect={() => pickMode('aiSuggest')} />
          <Option checked={who.kind === 'aiSuggest'} label={t('who.suggestHere')} onSelect={() => pickMode('aiSuggest')} />
          <Option checked={who.kind === 'aiWatch'} label={t('who.watchHere')} onSelect={() => pickMode('aiWatch')} />
          <Option checked={who.kind === 'aiOffHere'} label={t('who.offHere')} onSelect={() => pickMode('aiOffHere')} />
          <Option checked={who.kind === 'aiAuto'} label={t('who.autoHere')} onSelect={() => pickMode('aiAuto')} />
        </div>
      </Sheet>

      <Sheet open={sheet === 'auto'} onClose={close} title={t('who.autoTitle')}>
        <p class={sheetStyles.text}>{t('who.autoWas')}</p>
        <p class={sheetStyles.text}><strong>{t('who.autoWill')}</strong></p>
        <div class={sheetStyles.actions}>
          <Button variant="secondary" onClick={close} autoFocus>{t('sheet.cancel')}</Button>
          <Button variant="primary" icon="spark" onClick={() => { close(); setModeHere(chat.id, 'aiAuto'); }}>{t('who.autoYes')}</Button>
        </div>
      </Sheet>

      <Sheet open={sheet === 'intercept' && who.kind === 'colleague'} onClose={close}
        title={t('who.interceptTitle', { name: who.kind === 'colleague' ? who.name : '' })}>
        <p class={sheetStyles.text}>{t('who.interceptText', { name: who.kind === 'colleague' ? who.name : '' })}</p>
        <div class={sheetStyles.actions}>
          <Button variant="secondary" onClick={close} autoFocus>{t('sheet.cancel')}</Button>
          <Button variant="danger" onClick={() => { close(); if (who.kind === 'colleague') intercept(chat.id, who.name); }}>{t('who.interceptYes')}</Button>
        </div>
      </Sheet>

      <Sheet open={sheet === 'more'} onClose={close} title={t('thread.actions')}>
        <div role="menu" aria-label={t('thread.actions')}>
          <Option label={t(chat.important ? 'thread.unmarkImportant' : 'thread.markImportant')} onSelect={() => { close(); toggleImportant(chat.id); }} />
          {!done && <Option label={t('thread.statusWaitClient')} onSelect={() => { close(); waitClient(chat.id); }} />}
          <Option label={t('thread.copyLink')} onSelect={() => { close(); copyLink(chat.id); }} />
          <Option label={t('thread.hide')} onSelect={() => { close(); hide(chat.id); navigate({ name: 'chats', id: null }); }} />
        </div>
      </Sheet>

      <Sheet open={sheet === 'client'} onClose={close} title={t('client.title')} side={isSplit.value ? 'right' : 'center'}>
        <ClientPanel chat={chat} embedded />
      </Sheet>
    </div>
  );
}
