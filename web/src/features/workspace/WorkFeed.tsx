import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { InboxItem, ThreadAttachment, ThreadEvent, ThreadMessage, ThreadSuggestion } from '@shared/api-types';
import { ImageEditor, TgsSticker } from '@/features/media/lazy';
import { WrongSheet } from '@/features/assistant/WrongSheet';
import { can, markedWrong } from '@/lib/assistant/store';
import { prefill } from '@/lib/knowledge/store';
import { navigate } from '@/lib/router';
import { t, type Key } from '@/i18n/ru';
import { clock, dayDivider, sameDay } from '@/lib/format/format';
import { liveName } from '@/lib/live/labels';
import { getJson, readToken, sendJson } from '@/lib/live/api';
import { now, announcement } from '@/lib/store/state';
import {
  cancelSend, dismissOutgoing, drafts, draftTick, markRead, meKey, permissions, retrySend, returnToField, sendFile, sendNow,
} from '@/lib/workspace/actions';
import { modeLabel } from '@/lib/workspace/labels';
import { availability } from '@/lib/workspace/registry';
import { claimSent, loadEarlier, sentAs, threads, type Outgoing } from '@/lib/workspace/thread';
import { showToast } from '@/lib/actions/toasts';
import type { Author } from '@/lib/types';
import { Bubble } from '@/ui/Bubble';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Option, Sheet } from '@/ui/Sheet';
import s from '@/features/thread/thread.module.css';
import w from './workspace.module.css';
import { smooth } from '@/ui/motion';

const NEAR_BOTTOM = 120;
/** Лента «прилипла» к низу: рост содержимого или сжатие окна держат низ на месте (J-1). */
const STICK_PX = 24;
const EARLIER_AT = 80;

type Entry =
  | { type: 'message'; at: number; key: string; message: ThreadMessage }
  | { type: 'event'; at: number; key: string; event: ThreadEvent }
  | { type: 'outgoing'; at: number; key: string; outgoing: Outgoing };

const EVENT_KEY: Record<ThreadEvent['kind'], Key> = {
  handoff: 'event.handoff',
  took: 'event.took',
  returned: 'event.returned',
  resolved: 'event.resolvedBy',
  reopened: 'event.reopenedBy',
  pending: 'event.pendingBy',
  important: 'event.importantBy',
  unimportant: 'event.unimportantBy',
  hidden: 'event.hiddenBy',
  unhidden: 'event.unhiddenBy',
  mode: 'event.modeBy',
  claimed: 'event.claimed',
};

function eventText(event: ThreadEvent, me: string): string {
  const who = event.actor ? (event.actor.id === me ? t('feed.you') : event.actor.name) : t('feed.assistant');
  const mode = event.mode ? modeLabel(event.mode) : '';
  return t(EVENT_KEY[event.kind], { who, mode });
}

/** Ссылки кликабельны (inv-work P2-18); длинные слова переносит CSS. */
function linkify(text: string): ComponentChildren {
  const parts = text.split(/(https?:\/\/[^\s<>«»"]+)/g);
  return parts.map((part, index) => (index % 2 === 1
    ? <a key={index} href={part} target="_blank" rel="noopener noreferrer nofollow" class={w.link}>{part}</a>
    : part));
}

const size = (bytes: number | null): string => {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return t('file.kb', { n: Math.max(1, Math.round(bytes / 1024)) });
  return t('file.mb', { n: (bytes / 1024 / 1024).toFixed(1).replace('.', ',') });
};

const KIND_KEY: Record<string, Key> = {
  voice: 'file.voice', audio: 'file.audio', video: 'file.video', video_note: 'file.videoNote', document: 'file.document',
  tgs_sticker: 'file.sticker', video_sticker: 'file.sticker', sticker: 'file.sticker', animation: 'file.animation', photo: 'file.photo',
};

/** Вложение в ленте: место под картинку резервируется заранее по width/height — лента не прыгает. */
function AttachmentView({ file, onOpen }: { file: ThreadAttachment; onOpen: (file: ThreadAttachment) => void }): JSX.Element {
  const src = `/api/attachments/${file.id}`;
  const label = file.name || t(KIND_KEY[file.kind] ?? 'file.document');
  if (file.state !== 'ready') {
    return (
      <span class={w.fileCard} data-state={file.state}>
        <Icon name="clock" size={16} />
        <span>{file.state === 'pending' ? t('file.loading') : t('file.failed')}</span>
        {file.state === 'failed' && (
          <>
            <button type="button" class={w.inlineAction} onClick={() => {
              void sendJson(`/api/attachments/${file.id}/retry`, readToken() ?? '', {}).then(() => showToast({ text: t('file.retrying') })).catch(() => undefined);
            }}>{t('live.retry')}</button>
            <a class={w.inlineAction} href={src} download>{t('file.download')}</a>
          </>
        )}
      </span>
    );
  }
  // Размеров нет (старые записи) — место 4:3 у фото и 16:9 у видео заранее, картинка вписывается (J-4).
  const ratio = file.width && file.height ? `${file.width} / ${file.height}` : undefined;
  if (file.kind === 'tgs_sticker' || file.mime === 'application/x-tgsticker') return <TgsSticker id={file.id} />;
  if ((file.kind === 'photo' || file.kind === 'sticker' || (file.kind === 'animation' && file.mime === 'image/gif')) && file.mime !== 'application/x-tgsticker') {
    return (
      <button type="button" class={w.media} style={{ aspectRatio: ratio ?? '4 / 3' }} onClick={() => onOpen(file)} aria-label={t('file.openPhoto')}>
        <img src={src} alt="" loading="lazy" width={file.width ?? undefined} height={file.height ?? undefined} />
      </button>
    );
  }
  if (file.kind === 'video' || file.kind === 'video_note' || file.kind === 'animation') {
    return <video class={w.media} style={{ aspectRatio: ratio ?? '16 / 9' }} src={src} controls preload="none" />;
  }
  if (file.kind === 'voice' || file.kind === 'audio') {
    return <audio class={w.audio} src={src} controls preload="none" aria-label={label} />;
  }
  return (
    <a class={w.fileCard} href={src} download={file.name ?? undefined}>
      <Icon name="arrowDown" size={16} />
      <span class={w.fileName}>{label}</span>
      {file.bytes ? <span class="num">{size(file.bytes)}</span> : null}
    </a>
  );
}

/** «Вы · отправим через 4 с · Отменить» — окно отмены (6.3.5). */
function PendingMeta({ id, entry }: { id: number; entry: Outgoing }): JSX.Element {
  const [, tick] = useState(0);
  useEffect(() => {
    if (entry.state !== 'waiting') return undefined;
    const timer = setInterval(() => tick((value) => value + 1), 250);
    return () => clearInterval(timer);
  }, [entry.state]);
  if (entry.state === 'sending') return <span>{entry.kind === 'file' ? t('file.uploading') : t('feed.sending')}</span>;
  if (entry.state === 'failed') return <span>{t('feed.notSent')}</span>;
  const left = Math.max(1, Math.ceil(((entry.sendAt ?? 0) - Date.now()) / 1000));
  return (
    <>
      <span>{t('feed.sendingIn', { s: left })}</span>
      <button type="button" class={s.inlineUndo} onClick={() => cancelSend(id, entry.localId)}>{t('feed.undo')}</button>
      <button type="button" class={s.inlineNow} onClick={() => sendNow(entry.localId)} aria-label={t('feed.sendNow')}>
        <Icon name="send" size={14} />
      </button>
    </>
  );
}

/**
 * Лента на живых данных (6.3.2): клиент слева, вы и коллеги справа, помощник
 * фиолетовый с ✦, заметки — жёлтые карточки, события — строка по центру.
 * Ранние сообщения подгружаются при прокрутке вверх без сдвига.
 */
export function WorkFeed({ id, item }: { id: number; item: InboxItem }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const thread = threads.value.get(id);
  const me = meKey.value;
  const today = now.value;
  const [unseen, setUnseen] = useState(0);
  const [menu, setMenu] = useState<ThreadMessage | null>(null);
  // «Это неверно» на ответе помощника (6.3.2, 10.4 п.6).
  const [wrongFor, setWrongFor] = useState<number | null>(null);
  const [viewer, setViewer] = useState<ThreadAttachment | null>(null);
  const [editing, setEditing] = useState<File | null>(null);
  const [why, setWhy] = useState<{ state: 'loading' | 'error' } | { state: 'ready'; data: ThreadSuggestion } | null>(null);
  const canEdit = availability('conv.attach', permissions.value) === 'show' && thread?.head?.attachments === true;
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const lastId = useRef<number | null>(null);
  const firstLoad = useRef(true);
  const stick = useRef(true);
  /** Плавная прокрутка вниз из кода ещё идёт: промежуточные scroll не отлепляют ленту. */
  const gliding = useRef(false);
  /**
   * Что уже было на экране (M-8): при открытии и подгрузке ранних пузыри только
   * проявляются, въезжают снизу лишь новые. key → «новый»; решается один раз.
   */
  const born = useRef<Map<string, boolean> | null>(null);
  const bornAt = useRef(0);
  // «Новое» — линия перед непрочитанными при открытии (сколько их было в строке списка).
  const [newFrom] = useState(() => item.unread);
  const canQuote = availability('msg.quote', permissions.value) === 'show';
  // «Почему так?» читает черновик: право на ответ (наблюдатель не видит, раздел 10).
  const canWhy = permissions.value.has('conversation:reply');

  const messages = thread?.messages ?? [];
  // Своё отправленное держит key пузыря в пути: не перемонтируется и не въезжает второй раз (J-5, M-7).
  const claimed = claimSent(messages, thread?.outgoing ?? [], me);
  const entries: Entry[] = [
    ...messages.map((message): Entry => {
      const local = sentAs.get(message.id);
      return { type: 'message', at: message.at, key: local ? `o${local}` : `m${message.id}`, message };
    }),
    ...(thread?.events ?? []).map((event): Entry => ({ type: 'event', at: event.at, key: `e${event.id}`, event })),
    ...(thread?.outgoing ?? []).filter((outgoing) => !claimed.has(outgoing.localId))
      .map((outgoing): Entry => ({ type: 'outgoing', at: outgoing.at, key: `o${outgoing.localId}`, outgoing })),
  ].sort((a, b) => a.at - b.at || (a.type === 'outgoing' ? 1 : b.type === 'outgoing' ? -1 : 0));
  if (thread?.status === 'ready') {
    if (!born.current) born.current = new Map(entries.map((entry) => [entry.key, false]));
    else for (const entry of entries) if (!born.current.has(entry.key)) born.current.set(entry.key, entry.at >= bornAt.current);
    bornAt.current = Math.max(bornAt.current, entries.at(-1)?.at ?? 0);
  }
  const still = (key: string): '' | undefined => (born.current?.get(key) === true || !born.current ? undefined : '');
  const clientIds = messages.filter((message) => message.voice === 'client').map((message) => message.id);
  const firstNew = newFrom > 0 ? clientIds[Math.max(0, clientIds.length - newFrom)] : undefined;

  const atBottom = (): boolean => {
    const el = ref.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
  };

  const glide = (): void => {
    const el = ref.current;
    if (!el) return;
    stick.current = true;
    gliding.current = smooth() === 'smooth';
    el.scrollTo({ top: el.scrollHeight, behavior: smooth() });
  };

  // Низ на месте (J-1): картинка догрузилась, шапка или поле ответа сменили высоту, окно сжалось.
  useEffect(() => {
    const el = ref.current;
    const column = el?.firstElementChild;
    if (!el || !column || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => { if (stick.current && !gliding.current) el.scrollTop = el.scrollHeight; });
    observer.observe(el);
    observer.observe(column);
    return () => observer.disconnect();
  }, []);

  // Первая загрузка — вниз; подгрузка ранних — сохранить место (без сдвига).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || thread?.status !== 'ready') return;
    if (firstLoad.current) {
      firstLoad.current = false;
      el.scrollTop = el.scrollHeight;
      stick.current = true;
      lastId.current = messages.at(-1)?.id ?? null;
      return;
    }
    if (anchor.current) {
      el.scrollTop = el.scrollHeight - anchor.current.height + anchor.current.top;
      anchor.current = null;
    }
    const last = messages.at(-1);
    if (last && last.id !== lastId.current) {
      const added = messages.filter((message) => message.id > (lastId.current ?? 0));
      lastId.current = last.id;
      const fromClient = added.filter((message) => message.voice === 'client');
      if (fromClient.length) announcement.value = t('feed.newMessage', { name: liveName(item) });
      const own = added.some((message) => message.voice === 'operator' && message.author?.id === me);
      if (stick.current && !gliding.current) {
        // Внизу: просто держим низ — новый пузырь сам въезжает (без второй, прокручивающей анимации).
        el.scrollTop = el.scrollHeight;
        if (fromClient.length && document.visibilityState === 'visible') markRead(id);
      } else if (own || el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM + 200) {
        glide();
        // Новое входящее при видимой вкладке и ленте внизу — прочитано (прил. А.C, 7.2).
        if (fromClient.length && document.visibilityState === 'visible') markRead(id);
      } else if (fromClient.length) setUnseen((value) => value + fromClient.length);
    }
  }, [messages.length, messages.at(-1)?.id, thread?.status, thread?.outgoing.length]);

  const onScroll = (): void => {
    const el = ref.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (gliding.current) { if (gap < 2) gliding.current = false; } else stick.current = gap < STICK_PX;
    if (atBottom() && unseen) { setUnseen(0); markRead(id); }
    if (el.scrollTop < EARLIER_AT && thread?.hasMore && !thread.loadingEarlier) {
      anchor.current = { height: el.scrollHeight, top: el.scrollTop };
      void loadEarlier(id);
    }
  };

  const quote = (message: ThreadMessage): void => {
    setMenu(null);
    if (!message.quote_id) return;
    drafts.set(id, { quote: { id: message.id, quoteId: message.quote_id, excerpt: (message.text ?? '').slice(0, 120) }, mode: 'reply' });
    draftTick.value += 1;
  };
  /** «Почему так?» у ответа помощника (6.3.2): данные черновика, из которого ушёл ответ. */
  const explain = (message: ThreadMessage): void => {
    setMenu(null);
    if (message.suggestion_id === null) { setWhy({ state: 'error' }); return; }
    setWhy({ state: 'loading' });
    void getJson<{ suggestion: ThreadSuggestion }>(`/api/suggestions/${message.suggestion_id}`, readToken() ?? '')
      .then((response) => setWhy({ state: 'ready', data: response.suggestion }))
      .catch(() => setWhy({ state: 'error' }));
  };
  /** «Править» в просмотрщике: картинка — в редактор, результат уходит файлом (ярус 1, кнопка названа). */
  const edit = (file: ThreadAttachment): void => {
    const url = `/api/attachments/${file.id}`;
    void fetch(url, { credentials: 'same-origin' })
      // 401 — медиа-билет в cookie истёк: взять новый и повторить один раз.
      .then(async (response) => (response.status === 401
        ? getJson('/api/ticket', readToken() ?? '').then(() => fetch(url, { credentials: 'same-origin' }))
        : response))
      .then((response) => { if (!response.ok) throw new Error(String(response.status)); return response.blob(); })
      .then((blob) => { setViewer(null); setEditing(new File([blob], file.name || 'image.png', { type: blob.type || 'image/png' })); })
      .catch(() => showToast({ text: t('editor.loadFailed'), kind: 'error', ttl: null }));
  };
  /**
   * «В знания…» (6.6): новая статья-черновик из ответа — название из вопроса
   * клиента перед ним, текст — сам ответ. Ничего не публикуется.
   */
  const toKnowledge = (message: ThreadMessage): void => {
    setMenu(null);
    const list = thread?.messages ?? [];
    const at = list.findIndex((entry) => entry.id === message.id);
    const question = list.slice(0, at < 0 ? list.length : at).reverse().find((entry) => entry.voice === 'client' && entry.text)?.text ?? '';
    prefill.value = { title: question.replace(/\s+/g, ' ').trim().slice(0, 120), body: message.text ?? '' };
    navigate({ name: 'section', key: 'knowledge', sub: 'new' });
  };
  const copy = (message: ThreadMessage): void => {
    setMenu(null);
    void navigator.clipboard.writeText(message.text ?? '').then(() => showToast({ text: t('toast.copied') })).catch(() => undefined);
  };

  const out: JSX.Element[] = [];
  let prev: Entry | undefined;
  for (const entry of entries) {
    const quiet = still(entry.key);
    if (!prev || !sameDay(prev.at, entry.at)) {
      const day = dayDivider(entry.at, today);
      out.push(<div key={`d${entry.key}`} class={s.day} data-still={quiet}><span>{day === 'today' ? t('feed.today') : day === 'yesterday' ? t('feed.yesterday') : day}</span></div>);
    }
    if (entry.type === 'message' && entry.message.id === firstNew) out.push(<div key="new" class={w.newLine}><span>{t('feed.newLine')}</span></div>);
    if (entry.type === 'event') {
      out.push(<p key={entry.key} class={s.event}>{eventText(entry.event, me)} · <span class="num">{clock(entry.at)}</span></p>);
    } else if (entry.type === 'message' && entry.message.voice === 'note') {
      const author = entry.message.author ? (entry.message.author.id === me ? t('feed.you') : entry.message.author.name) : t('feed.team');
      out.push(
        <section key={entry.key} class={s.note} aria-label={t('feed.noteTitle')} data-still={quiet}>
          <p class={s.noteHead}><Icon name="lock" size={14} />{t('feed.noteTitle')} · {author}, <span class="num">{clock(entry.at)}</span></p>
          <p class={s.noteText}>{linkify(entry.message.text ?? '')}</p>
        </section>,
      );
    } else if (entry.type === 'message') {
      const message = entry.message;
      const voice: Author = message.voice === 'client' ? 'client' : message.voice === 'assistant' ? 'assistant'
        : message.voice === 'auto' ? 'auto' : message.author && message.author.id === me ? 'you' : 'colleague';
      const label = voice === 'client' ? liveName(item) : voice === 'assistant' ? t('feed.assistant') : voice === 'auto' ? t('feed.auto')
        : voice === 'colleague' ? message.author?.name ?? t('feed.operator') : t('feed.you');
      const mine = message.voice === 'operator' && message.author?.id === me;
      const grouped = (prev?.type === 'message' ? prev.message.voice === message.voice && prev.message.author?.id === message.author?.id
        : prev?.type === 'outgoing' && mine) && prev !== undefined && sameDay(prev.at, entry.at) && entry.at - prev.at < 10 * 60_000;
      const text = message.text ?? '';
      out.push(
        <div key={entry.key} class={`${grouped ? s.msgGrouped : s.msg} ${w.msgRow}`} data-side={voice === 'client' ? 'in' : 'out'} data-message-id={String(message.id)}
          data-still={quiet}
          onContextMenu={(event) => { event.preventDefault(); setMenu(message); }}>
          <Bubble
            voice={voice}
            label={grouped ? undefined : label}
            a11y={`${voice === 'client' ? t('feed.clientA11y', { name: label }) : label}, ${clock(message.at)}: ${text || t(KIND_KEY[message.kind] ?? 'file.document')}`}
            meta={clock(message.at)}
            foot={message.attachments.length ? message.attachments.map((file) => <AttachmentView key={file.id} file={file} onOpen={setViewer} />) : undefined}
            aside={(
              <button type="button" class={w.msgMenu} aria-label={t('message.menu')} aria-haspopup="dialog" onClick={() => setMenu(message)}>
                <Icon name="more" size={18} />
              </button>
            )}
          >
            {message.quote && <span class={w.quote}>↩ {message.quote}</span>}
            {text ? linkify(text) : message.attachments.length ? null : t(KIND_KEY[message.kind] ?? 'file.document')}
          </Bubble>
        </div>,
      );
    } else {
      const outgoing = entry.outgoing;
      const failed = outgoing.state === 'failed';
      // Та же раскладка и то же правило группы, что у отправленного: пузырь не меняет высоту, став настоящим (J-5).
      const grouped = (prev?.type === 'outgoing' || (prev?.type === 'message' && prev.message.voice === 'operator' && prev.message.author?.id === me))
        && sameDay(prev.at, entry.at) && entry.at - prev.at < 10 * 60_000;
      out.push(
        <div key={entry.key} class={`${grouped ? s.msgGrouped : s.msg} ${w.msgRow}`} data-side="out" data-still={quiet}>
          <Bubble
            voice="you"
            label={grouped ? undefined : t('feed.you')}
            pending
            a11y={`${t('feed.you')}: ${outgoing.text || outgoing.fileName || ''}`}
            meta={<PendingMeta id={id} entry={outgoing} />}
            foot={failed && outgoing.error ? (
              <span class={w.sendError} role="alert">
                <span>{t(outgoing.error.text)}</span>
                {outgoing.error.retry && outgoing.kind === 'text' && <Button variant="secondary" size="sm" onClick={() => retrySend(id, outgoing.localId)}>{t('live.retry')}</Button>}
                {outgoing.kind === 'text'
                  ? <Button variant="quiet" size="sm" onClick={() => returnToField(id, outgoing.localId)}>{t('feed.toField')}</Button>
                  : <Button variant="quiet" size="sm" onClick={() => dismissOutgoing(id, outgoing.localId)}>{t('sheet.close')}</Button>}
              </span>
            ) : undefined}
          >
            {outgoing.quote && <span class={w.quote}>↩ {outgoing.quote.excerpt}</span>}
            {outgoing.kind === 'file' ? t('file.sent', { name: outgoing.fileName ?? '' }) : outgoing.text}
          </Bubble>
        </div>,
      );
    }
    prev = entry;
  }

  return (
    <div class={s.feedWrap}>
      <div class={s.feed} ref={ref} role="log" aria-label={t('feed.label')} aria-busy={thread?.status === 'loading' ? 'true' : 'false'} tabIndex={0} onScroll={onScroll}>
        <div class={s.column}>
          {/* Место под «Загружаем ранние…» стоит, пока есть ранние: надпись не сдвигает ленту (J-13). */}
          {thread?.hasMore && <p class={s.event} aria-hidden={thread.loadingEarlier ? undefined : 'true'}>{thread.loadingEarlier ? t('feed.loadingEarlier') : '\u00a0'}</p>}
          {thread?.status === 'loading' && (
            <div class={w.skeletonBubbles} aria-hidden="true">{[0, 1, 2, 3].map((index) => <span key={index} />)}</div>
          )}
          {thread?.status === 'ready' && entries.length === 0 && <p class={s.event}>{t('feed.empty')}</p>}
          {out}
        </div>
      </div>
      {unseen > 0 && (
        <Button variant="secondary" size="sm" icon="arrowDown" class={s.newBelow}
          onClick={() => { glide(); setUnseen(0); markRead(id); }}>
          {t('feed.newBelow', { n: unseen })}
        </Button>
      )}

      <Sheet open={menu !== null} onClose={() => setMenu(null)} title={t('message.menu')}>
        {menu && (
          <div role="menu" aria-label={t('message.menu')}>
            {menu.voice === 'client' && canQuote && (menu.quote_id
              ? <Option label={t('message.quote')} onSelect={() => quote(menu)} />
              : <Option label={t('message.quote')} hint={t('message.quoteUnavailable')} onSelect={() => setMenu(null)} />)}
            {menu.text && <Option label={t('message.copy')} onSelect={() => copy(menu)} />}
            {menu.text && menu.voice !== 'client' && can('knowledge:manage') && <Option label={t('message.toKnowledge')} onSelect={() => toKnowledge(menu)} />}
            {menu.voice === 'assistant' && canWhy && <Option label={t('why.title')} onSelect={() => explain(menu)} />}
            {menu.voice === 'assistant' && canWhy && !markedWrong.value.has(menu.id) && (
              <Option label={t('today.wrong')} onSelect={() => { setWrongFor(menu.id); setMenu(null); }} />
            )}
          </div>
        )}
      </Sheet>
      <WrongSheet messageId={wrongFor} onClose={() => setWrongFor(null)} />

      <Sheet open={why !== null} onClose={() => setWhy(null)} title={t('why.title')}>
        {why?.state === 'loading' && <p>{t('live.loading')}</p>}
        {why?.state === 'error' && <p>{t('why.noSources')}</p>}
        {why?.state === 'ready' && (
          <div class={w.why}>
            <p>{why.data.sources.length ? t('why.from', { sources: why.data.sources.map((source) => `«${source}»`).join(', ') }) : t('why.noSources')}</p>
            <p>{t('why.level', { level: t(why.data.level === 'sure' ? 'draft.sure' : why.data.level === 'check' ? 'draft.check' : 'draft.unsure') })}{why.data.reason ? ` — ${why.data.reason}` : ''}</p>
            {why.data.operator_note && <p>{t('draft.noteForYou', { note: why.data.operator_note })}</p>}
            <details class={w.expert}>
              <summary>{t('draft.expert')}</summary>
              <p>{t('draft.expertText', { score: why.data.confidence === null ? '—' : `${Math.round(why.data.confidence * 100)}%`, model: why.data.model ?? '—' })}</p>
            </details>
          </div>
        )}
      </Sheet>

      {editing && (
        <ImageEditor file={editing} saveLabel={t('editor.send')} onClose={() => setEditing(null)}
          onSave={(edited) => { setEditing(null); void sendFile(id, edited, { dangerousConfirmed: false, quote: null }); }} />
      )}

      <Sheet open={viewer !== null} onClose={() => setViewer(null)} title={viewer?.name || t('file.photo')}>
        {viewer && (
          <div class={w.viewer}>
            <img src={`/api/attachments/${viewer.id}`} alt="" />
            <div class={w.viewerActions}>
              {canEdit && <Button variant="secondary" size="sm" icon="edit" onClick={() => edit(viewer)}>{t('editor.edit')}</Button>}
              <a class={w.inlineAction} href={`/api/attachments/${viewer.id}`} download={viewer.name ?? undefined}>{t('file.download')}</a>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}
