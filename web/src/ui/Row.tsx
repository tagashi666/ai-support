import type { ComponentChildren, JSX } from 'preact';
import { t } from '@/i18n/ru';
import type { Tone } from '@/lib/labels';
import { Icon } from './Icon';
import s from './ui.module.css';

interface RowProps {
  id: string;
  avatar: ComponentChildren;
  title: string;
  time: string;
  /** «Вы:», «Помощник:» — приглушённая подпись перед превью. */
  who?: string;
  preview: string;
  reason: string;
  tone: Tone;
  unread?: boolean;
  current?: boolean;
  tabIndex?: number;
  onOpen: () => void;
  /** Режим выбора: строка — переключатель (aria-pressed). */
  pressed?: boolean;
  onKeyDown?: (event: KeyboardEvent) => void;
  /** Строка внутри обёртки с меню «⋯»: data-row-id ставит обёртка (FLIP двигает строку целиком). */
  wrapped?: boolean;
}

/** Строка списка (6.2): постоянная высота, превью и причина в одну строку. */
export function Row(props: RowProps): JSX.Element {
  const { id, avatar, title, time, who, preview, reason, tone, unread, current, tabIndex, onOpen, onKeyDown, wrapped, pressed } = props;
  return (
    <button
      type="button"
      class={s.row}
      data-row-id={wrapped ? undefined : id}
      data-unread={unread ? 'true' : 'false'}
      aria-current={current ? 'true' : undefined}
      aria-pressed={pressed === undefined ? undefined : pressed ? 'true' : 'false'}
      tabIndex={tabIndex}
      onClick={onOpen}
      onKeyDown={onKeyDown}
    >
      {avatar}
      <span class={s.rowBody}>
        <span class={s.rowTop}>
          <span class={s.rowTitle}>{title}</span>
          {unread && <span class={s.unreadDot} role="img" aria-label={t('chats.unread')} />}
          <span class={`${s.rowTime} num`}>{time}</span>
        </span>
        <span class={s.rowLine}>
          {who && <span class={s.rowWho}>{who} </span>}
          {preview}
        </span>
        <span class={s.rowReason} data-tone={tone}>
          {tone === 'attention' && <Icon name="urgent" size={14} />}
          {tone === 'ai' && <Icon name="spark" size={14} />}
          <span>{reason}</span>
        </span>
      </span>
    </button>
  );
}
