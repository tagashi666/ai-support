import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { cancelSend, sendNow } from '@/lib/actions/chat';
import { clock, dayDivider, sameDay } from '@/lib/format/format';
import { now } from '@/lib/store/state';
import type { Chat, FeedItem, Message } from '@/lib/types';
import { Bubble } from '@/ui/Bubble';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import s from './thread.module.css';

const NEAR_BOTTOM = 120;

function voiceLabel(message: Message, chat: Chat): string {
  switch (message.author) {
    case 'client': return chat.name;
    case 'you': return t('feed.you');
    case 'colleague': return message.authorName ?? '';
    case 'assistant': return t('feed.assistant');
    case 'auto': return t('feed.auto');
  }
}

/** Отправка с окном отмены: «Вы · отправим через 4 с · Отменить» (6.3.5). */
function PendingMeta({ chat, message }: { chat: Chat; message: Message }): JSX.Element {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 250);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(1, Math.ceil(((message.sendAt ?? 0) - Date.now()) / 1000));
  return (
    <>
      <span>{t('feed.sendingIn', { s: left })}</span>
      <button type="button" class={s.inlineUndo} onClick={() => cancelSend(chat.id, message.id)}>{t('feed.undo')}</button>
      <button type="button" class={s.inlineNow} onClick={() => sendNow(message.id)} aria-label={t('composer.send')}>
        <Icon name="send" size={14} />
      </button>
    </>
  );
}

function divider(at: number, today: number): string {
  const value = dayDivider(at, today);
  return value === 'today' ? t('feed.today') : value === 'yesterday' ? t('feed.yesterday') : value;
}

/**
 * Лента (6.3.2): клиент слева, вы и коллеги справа, помощник — фиолетовый
 * с ✦; заметки — жёлтые карточки; события — строка по центру.
 * aria-live не на всей ленте: объявление о новом сообщении — отдельной строкой.
 */
export function Feed({ chat }: { chat: Chat }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useRef(chat.feed.length);
  const [unseen, setUnseen] = useState(0);
  const today = now.value;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const added = chat.feed.length - seen.current;
    seen.current = chat.feed.length;
    if (added <= 0) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM + 160;
    const mine = chat.feed[chat.feed.length - 1]?.type === 'message' && (chat.feed[chat.feed.length - 1] as Message).author === 'you';
    if (near || mine) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else setUnseen((value) => value + added);
  }, [chat.feed.length]);

  const items: JSX.Element[] = [];
  let prev: FeedItem | undefined;
  for (const item of chat.feed) {
    if (!prev || !sameDay(prev.at, item.at)) {
      items.push(<div key={`d${item.at}`} class={s.day}><span>{divider(item.at, today)}</span></div>);
    }
    if (item.type === 'event') {
      items.push(<p key={item.id} class={s.event}>{item.text} · <span class="num">{clock(item.at)}</span></p>);
    } else if (item.type === 'note') {
      items.push(
        <section key={item.id} class={s.note} aria-label={t('feed.noteTitle')}>
          <p class={s.noteHead}><Icon name="lock" size={14} />{t('feed.noteTitle')} · {item.authorName}, <span class="num">{clock(item.at)}</span></p>
          <p class={s.noteText}>{item.text}</p>
        </section>,
      );
    } else {
      const grouped = prev?.type === 'message' && prev.author === item.author && sameDay(prev.at, item.at)
        && item.at - prev.at < 10 * 60_000;
      const label = voiceLabel(item, chat);
      const pending = item.sendAt !== undefined;
      items.push(
        <div key={item.id} class={grouped ? s.msgGrouped : s.msg}>
          <Bubble
            voice={item.author}
            label={grouped ? undefined : label}
            pending={pending}
            a11y={`${item.author === 'client' ? t('feed.clientA11y', { name: label }) : label}, ${clock(item.at)}: ${item.text}`}
            meta={pending ? <PendingMeta chat={chat} message={item} /> : clock(item.at)}
          >
            {item.text}
          </Bubble>
        </div>,
      );
    }
    prev = item;
  }

  return (
    <div class={s.feedWrap}>
      <div
        class={s.feed}
        ref={ref}
        role="log"
        aria-label={t('feed.label')}
        tabIndex={0}
        onScroll={() => {
          const el = ref.current;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM) setUnseen(0);
        }}
      >
        <div class={s.column}>{items}</div>
      </div>
      {unseen > 0 && (
        <Button
          variant="secondary"
          size="sm"
          icon="arrowDown"
          class={s.newBelow}
          onClick={() => { ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' }); setUnseen(0); }}
        >
          {t('feed.newBelow', { n: unseen })}
        </Button>
      )}
    </div>
  );
}
