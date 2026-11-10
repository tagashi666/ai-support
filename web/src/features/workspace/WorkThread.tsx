import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { InboxItem, ThreadHead } from '@shared/api-types';
import { t } from '@/i18n/ru';
import { duration, roughDuration } from '@/lib/format/format';
import { channelLabel } from '@/lib/labels';
import { readToken, sendJson } from '@/lib/live/api';
import { liveChannel, liveName } from '@/lib/live/labels';
import { bootstrap, inbox } from '@/lib/live/store';
import { isSplit } from '@/lib/media';
import { navigate, route } from '@/lib/router';
import { now } from '@/lib/store/state';
import {
  askHandover, copyLink, drafts, draftSync, draftTick, giveBack, hide, itemOf, meKey, permissions, reopen, resolve, setImportant, setMode,
  take, takeover, unhide, waitClient,
} from '@/lib/workspace/actions';
import { colleaguesIn, presence as presenceMap, setPresence } from '@/lib/workspace/collab';
import { patches } from '@/lib/workspace/local';
import { availability, type ActionId } from '@/lib/workspace/registry';
import { freshItem, loadThread, openThreadId, threads, updateThread } from '@/lib/workspace/thread';
import { modeHereLabel, modeLabel, roleLabel } from '@/lib/workspace/labels';
import { hereMode, isBolder, whoView, type HereMode } from '@/lib/workspace/who';
import { Avatar } from '@/ui/Avatar';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Chip';
import { Option, Sheet, sheetStyles } from '@/ui/Sheet';
import s from '@/features/thread/thread.module.css';
import { WorkComposer } from './WorkComposer';
import { WorkDraft } from './WorkDraft';
import { WorkFeed } from './WorkFeed';
import w from './workspace.module.css';

const THREE_HOURS = 3 * 60 * 60_000;
const PRESENCE_MS = 15_000;

/** Строка под именем: «ждёт 2 ч», «ответить можно ещё 2 ч 40 мин», «заявка №4411». */
function headStatus(item: InboxItem, head: ThreadHead, at: number): { text: string; attention: boolean } {
  const closesAt = head.window.applies ? head.window.closes_at : null;
  const left = closesAt !== null ? closesAt - at : null;
  const open = item.status !== 'resolved' && item.status !== 'closed';
  if (open && left !== null && left > 0 && left < THREE_HOURS) return { text: t('thread.windowLeft', { left: duration(left) }), attention: true };
  if (head.ticket) return { text: head.ticket.number ? t('thread.ticket', { n: head.ticket.number }) : t('thread.ticketNoNumber'), attention: false };
  if (item.section === 'mine' && item.waiting_since !== null) return { text: t('thread.waits', { for: roughDuration(at - item.waiting_since) }), attention: false };
  if (item.owner && item.owner.id === meKey.value) return { text: t('thread.youLead'), attention: false };
  return { text: '', attention: false };
}

const MODES: readonly HereMode[] = ['inherit', 'suggest', 'shadow', 'off', 'auto'];

/**
 * Шапка до ответа /api/thread — из строки списка (J-2): диалог сразу рисуется
 * своей настоящей раскладкой (шапка, лента-каркас, поле ответа), а не
 * скелетоном другой высоты. Заявка и окно ответа — по каналу и строке.
 */
function guessHead(item: InboxItem): ThreadHead {
  const ticket = item.channel === 'bedolaga' || item.channel === 'minishop' ? { kind: item.channel, number: null } : null;
  return {
    item, ticket, attachments: ticket === null, sender: true, hidden: false, presence: [],
    window: { applies: item.window !== null, open: item.window?.open ?? true, closes_at: item.window?.closes_at ?? null },
  };
}

/**
 * Диалог на живых данных (6.3): шапка с чипом «кто отвечает» и главной
 * кнопкой, лента, черновик помощника, поле ответа. Шапка рисуется сразу из
 * строки списка; лента — после ответа /api/thread.
 */
export function WorkThread({ id }: { id: number }): JSX.Element {
  const [sheet, setSheet] = useState<'who' | 'more' | 'takeover' | 'auto' | { explain: ActionId } | null>(null);
  const close = (): void => setSheet(null);
  draftTick.value;
  const thread = threads.value.get(id);
  const listed = inbox.value.entries.get(id)?.item;
  patches.value;
  const item = freshItem(thread?.head ?? null, listed) ? itemOf(id) ?? null : null;
  void item?.updated_at;
  const head = thread?.head ?? (item ? guessHead(item) : null);
  const at = now.value;
  const perms = permissions.value;
  const me = meKey.value;
  const assistant = bootstrap.value?.assistant ?? { mode: 'suggest' as const, keys: true, minConfidence: 0.9 };

  // Диалог сменился без перемонтирования шапки (J-2): открытые листы — закрыть.
  useEffect(() => {
    setSheet(null);
    openThreadId.value = id;
    void loadThread(id);
    return () => { if (openThreadId.peek() === id) openThreadId.value = null; };
  }, [id]);

  // Свой черновик с сервера (7.8) — когда известны права: по прямой ссылке bootstrap приходит позже.
  const booted = bootstrap.value !== null;
  useEffect(() => { if (booted) void draftSync.open(id); }, [id, booted]);

  // Присутствие раз в 15 с, пока вкладка видна (как сейчас у классики): «Мария смотрит».
  useEffect(() => {
    const beat = (): void => {
      if (document.visibilityState !== 'visible') return;
      void sendJson<{ collaboration?: { presences?: Array<{ actor_key: string; state: string; seen_at: number; name: string }> } }>(
        `/api/conversations/${id}/presence`, readToken() ?? '', { state: 'viewing' },
      ).then((response) => {
        const presence = (response.collaboration?.presences ?? []).map((entry) => ({
          id: entry.actor_key, name: entry.name, state: entry.state === 'typing' ? 'typing' as const : 'viewing' as const, at: entry.seen_at,
        }));
        updateThread(id, (current) => (current.head ? { ...current, head: { ...current.head, presence } } : current));
        setPresence(id, presence);
      }).catch(() => undefined);
    };
    beat();
    const timer = setInterval(beat, PRESENCE_MS);
    return () => clearInterval(timer);
  }, [id]);

  const back = (): void => navigate({ name: 'chats', id: null });

  // Тосты на узком экране встают над полем ответа, а не на него (J-14): --toast-lift = высота низа.
  const foot = useRef<HTMLElement>(null);
  const gone = thread?.status === 'gone' && !head?.hidden;
  useEffect(() => {
    const el = foot.current;
    const root = document.documentElement.style;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => root.setProperty('--toast-lift', `${el.offsetHeight}px`));
    observer.observe(el);
    return () => { observer.disconnect(); root.removeProperty('--toast-lift'); };
  }, [gone, item === null]);

  if (!item || !head) {
    if (thread?.status === 'error') {
      return (
        <div class={w.threadState} role="alert">
          <p><b>{thread.error === 'not_found' ? t('thread.notFound') : thread.error === 'permission' ? t('thread.noAccess') : t('thread.loadFailed')}</b></p>
          <div class={w.stateActions}>
            {thread.error !== 'not_found' && <Button variant="secondary" size="sm" onClick={() => { void loadThread(id); }}>{t('live.retry')}</Button>}
            <Button variant="quiet" size="sm" onClick={back}>{t('thread.toList')}</Button>
          </div>
        </div>
      );
    }
    // Строки ещё нет (прямая ссылка до списка): каркас той же раскладки — шапка, лента, поле ответа.
    return (
      <div class={s.thread} aria-busy="true">
        <div class={`${s.head} ${w.skeletonHead}`} />
        <div class={s.feedWrap}><div class={w.skeletonFeed} /></div>
        <div class={`${s.foot} ${w.skeletonFoot}`} />
      </div>
    );
  }

  const name = liveName(item);
  const own = drafts.get(id);
  const typing = own.mode === 'reply' && own.text.trim().length > 0;
  const who = whoView({ item, me, permissions: perms, assistant, typing });
  const status = headStatus(item, head, at);
  const done = item.status === 'resolved' || item.status === 'closed';
  const channel = liveChannel(item);
  const can = (action: ActionId): boolean => availability(action, perms) === 'show';
  const colleagues = colleaguesIn(presenceMap.value.get(id) ?? head.presence, me, at);

  /** Без права: по нажатию лист «Почему недоступно» (6.14) — на телефоне нет наведения. */
  const guarded = (action: ActionId, run: () => void) => () => {
    if (availability(action, perms) === 'show') run();
    else setSheet({ explain: action });
  };

  const primary = (() => {
    switch (who.primary) {
      case 'take': return <Button variant="primary" onClick={guarded('conv.take', () => { void take(id); })}>{t('who.take')}</Button>;
      case 'return': return <Button variant="secondary" icon="spark" onClick={guarded('conv.return', () => { void giveBack(id); })}>{t('who.giveBack')}</Button>;
      case 'reopen': return <Button variant="secondary" onClick={guarded('conv.reopen', () => reopen(id))}>{t('thread.reopen')}</Button>;
      case 'takeover': return <Button variant="secondary" onClick={() => setSheet('takeover')}>{t('who.intercept')}</Button>;
      case 'askHandover': return <Button variant="secondary" onClick={() => askHandover(id, item.owner?.name ?? '')}>{t('who.askHandover')}</Button>;
      default: return null;
    }
  })();

  const pickMode = (next: HereMode): void => {
    close();
    if (isBolder(next, item.ai.effective, assistant.mode)) { setSheet('auto'); return; }
    void setMode(id, next);
  };

  const resolveNow = (): void => {
    resolve(id);
    // Решённый диалог можно оставить открытым: строка уедет, когда вы уйдёте (7.1 п.6).
  };

  const explainAction = sheet && typeof sheet === 'object' ? sheet.explain : null;
  const current = hereMode(item.ai.configured);

  return (
    <div class={s.thread}>
      <header class={s.head}>
        <div class={`${s.headTop} ${w.headTop}`}>
          {!isSplit.value && <Button variant="quiet" icon="back" label={t('nav.back')} class={s.back} onClick={back} />}
          <span class={s.headAvatar}><Avatar name={name} size="s" channel={channel} /></span>
          <div class={s.headName}>
            <h2 class={`${s.name} ${w.fullName}`}>{name}</h2>
            <p class={s.sub}>
              {channel && <span>{channelLabel(channel)}</span>}
              {item.customer.username && <span>@{item.customer.username}</span>}
              {status.text && <><span aria-hidden="true">·</span><span class={status.attention ? s.subAttention : undefined}>{status.text}</span></>}
            </p>
          </div>
          <div class={`${s.headActions} ${w.headActions}`}>
            {!done && (
              <Button variant="secondary" size="sm" icon="check" onClick={guarded('conv.resolve', resolveNow)}>
                {head.ticket ? t('thread.resolveTicket') : t('thread.resolve')}
              </Button>
            )}
            <Button variant="quiet" size="sm" icon="more" label={t('thread.more')} aria-haspopup="dialog" onClick={() => setSheet('more')} />
            {/* На телефоне — только значок: шапка не шире экрана. */}
            <Button variant="quiet" size="sm" icon="client" aria-haspopup="dialog" label={isSplit.value ? undefined : t('thread.client')}
              onClick={() => navigate({ name: 'chats', id: String(id), client: !(route.value.name === 'chats' && route.value.client) })}>
              {isSplit.value ? t('thread.client') : undefined}
            </Button>
          </div>
        </div>
        <div class={s.chipRow}>
          <Chip text={who.text} tone={who.tone} lead={who.lead} menu={who.menu} onClick={() => setSheet('who')} />
          {primary}
          {who.ledBy && <span class={w.ledBy}>{t('who.ledBy', { name: who.ledBy })}</span>}
          {/* Присутствие — в той же строке, в оставшемся месте (J-3): появляется и пропадает без сдвига шапки. */}
          {colleagues.length > 0 && (
            <span class={`${s.chipFill} ${w.presence}`} aria-live="polite">
              {colleagues.map((entry) => t(entry.state === 'typing' ? 'presence.typing' : 'presence.viewing', { name: entry.name })).join(' · ')}
            </span>
          )}
        </div>
        {item.flags.not_found && <p class={w.quietLine}>{t('thread.notInBase')}</p>}
        {head.hidden && (
          <p class={w.quietLine}>
            {t('thread.hiddenNow')}{' '}
            {can('conv.unhide') && <button type="button" class={w.inlineAction} onClick={() => unhide(id)}>{t('thread.unhide')}</button>}
          </p>
        )}
      </header>

      {thread?.status === 'gone' && !head.hidden ? (
        <div class={w.threadState} role="status">
          <p>{t('thread.gone')}</p>
          <Button variant="secondary" size="sm" onClick={back}>{t('thread.toList')}</Button>
        </div>
      ) : (
        <>
          <WorkFeed key={id} id={id} item={item} />
          <footer class={s.foot} ref={foot}>
            {!done && who.kind !== 'colleague' && <WorkDraft key={id} id={id} item={item} head={head} typing={typing} />}
            <WorkComposer key={id} id={id} item={item} head={head} colleague={who.kind === 'colleague' ? item.owner?.name ?? '' : null} />
          </footer>
        </>
      )}

      <Sheet open={sheet === 'who'} onClose={close} title={t('who.sheetTitle')}>
        <p class={sheetStyles.text}>{t('who.sheetHint')}</p>
        <div role="menu" aria-label={t('who.sheetTitle')}>
          {who.kind !== 'youLead' && can('conv.take') && <Option label={t('who.take')} onSelect={() => { close(); void take(id); }} />}
          {(who.kind === 'handed' || who.kind === 'youLead') && assistant.mode !== 'off' && (
            <Option label={t('who.giveBack')} onSelect={() => { close(); void giveBack(id); }} />
          )}
          {MODES.map((mode) => (
            <Option key={mode} checked={current === mode}
              label={mode === 'inherit' ? t('who.asEverywhereLive', { mode: modeLabel(assistant.mode) }) : modeHereLabel(mode)}
              onSelect={() => pickMode(mode)} />
          ))}
        </div>
      </Sheet>

      <Sheet open={sheet === 'auto'} onClose={close} title={t('who.autoTitle')}>
        <p class={sheetStyles.text}>{t('who.autoWasLive', { mode: modeLabel(item.ai.effective) })}</p>
        <p class={sheetStyles.text}><strong>{t('who.autoWill')}</strong></p>
        <div class={sheetStyles.actions}>
          <Button variant="secondary" onClick={close} autoFocus>{t('sheet.cancel')}</Button>
          <Button variant="primary" icon="spark" onClick={() => { close(); void setMode(id, 'auto'); }}>{t('who.autoYes')}</Button>
        </div>
      </Sheet>

      <Sheet open={sheet === 'takeover'} onClose={close} title={t('who.interceptTitle', { name: item.owner?.name ?? '' })}>
        <p class={sheetStyles.text}>{t('who.interceptText', { name: item.owner?.name ?? '' })}</p>
        <div class={sheetStyles.actions}>
          <Button variant="secondary" onClick={close} autoFocus>{t('sheet.cancel')}</Button>
          <Button variant="danger" onClick={() => { close(); void takeover(id); }}>{t('who.interceptYes')}</Button>
        </div>
      </Sheet>

      <Sheet open={sheet === 'more'} onClose={close} title={t('thread.actions')} side={isSplit.value ? 'right' : 'center'}>
        <div role="menu" aria-label={t('thread.actions')}>
          {!done && can('conv.status') && item.status !== 'pending' && <Option label={t('thread.statusWaitClient')} onSelect={() => { close(); waitClient(id); }} />}
          {done && can('conv.reopen') && <Option label={t('thread.reopen')} onSelect={() => { close(); reopen(id); }} />}
          {can('conv.important') && (
            <Option label={t(item.flags.important ? 'thread.unmarkImportant' : 'thread.markImportant')}
              hint={item.flags.important ? undefined : t('thread.importantHint')}
              onSelect={() => { close(); setImportant(id, !item.flags.important); }} />
          )}
          {can('conv.aimode') && <Option label={t('thread.aiMode')} onSelect={() => setSheet('who')} />}
          {!head.hidden && can('conv.hide') && <Option label={t('thread.hide')} hint={t('list.hideHint')} onSelect={() => { close(); hide(id); back(); }} />}
          {head.hidden && can('conv.unhide') && <Option label={t('thread.unhide')} onSelect={() => { close(); unhide(id); }} />}
          <Option label={t('thread.copyLink')} onSelect={() => { close(); void copyLink(id); }} />
        </div>
      </Sheet>

      <Sheet open={explainAction !== null} onClose={close} title={t('rights.title')}>
        <p class={sheetStyles.text}>{t('rights.text', { role: roleLabel(bootstrap.value?.me.role ?? '') })}</p>
        <div class={sheetStyles.actions}><Button variant="secondary" onClick={close} autoFocus>{t('sheet.close')}</Button></div>
      </Sheet>
    </div>
  );
}
