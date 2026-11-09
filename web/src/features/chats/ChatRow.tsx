import type { JSX } from 'preact';
import { t } from '@/i18n/ru';
import { listTime } from '@/lib/format/format';
import { reasonView } from '@/lib/labels';
import { composerText, now } from '@/lib/store/state';
import type { Chat, Message } from '@/lib/types';
import { Avatar } from '@/ui/Avatar';
import { Row } from '@/ui/Row';

/** Превью последнего сообщения: «Вы:», «Помощник:», «Мария:», «Черновик:» (6.2). */
export function previewOf(chat: Chat, draftText: string): { who?: string; text: string } {
  if (draftText.trim()) return { who: t('preview.draft'), text: draftText.trim() };
  const last = [...chat.feed].reverse().find((item): item is Message => item.type === 'message');
  if (!last) return { text: '' };
  switch (last.author) {
    case 'you': return { who: t('preview.you'), text: last.text };
    case 'assistant': return { who: t('preview.assistant'), text: last.text };
    case 'colleague': return { who: `${last.authorName ?? ''}:`, text: last.text };
    case 'auto': return { who: `${t('feed.auto')}:`, text: last.text };
    case 'client': return { text: last.text };
  }
}

interface ChatRowProps {
  chat: Chat;
  current?: boolean;
  tabIndex?: number;
  onOpen: () => void;
  onKeyDown?: (event: KeyboardEvent) => void;
}

export function ChatRow({ chat, current, tabIndex, onOpen, onKeyDown }: ChatRowProps): JSX.Element {
  const at = now.value;
  const reason = reasonView(chat.reason, at, chat.waitingSince);
  const preview = previewOf(chat, composerText.value[chat.id] ?? '');
  return (
    <Row
      id={chat.id}
      avatar={<Avatar name={chat.name} channel={chat.channel} />}
      title={chat.name}
      time={listTime(chat.lastAt, at)}
      who={preview.who}
      preview={preview.text}
      reason={reason.text}
      tone={reason.tone}
      unread={chat.unread}
      current={current}
      tabIndex={tabIndex}
      onOpen={onOpen}
      onKeyDown={onKeyDown}
    />
  );
}
