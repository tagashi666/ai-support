import type { ComponentChildren, JSX } from 'preact';
import type { Author } from '@/lib/types';
import { Icon } from './Icon';
import s from './ui.module.css';

interface BubbleProps {
  voice: Author;
  /** Подпись над пузырём: имя клиента, «Вы», «Мария», «Помощник». */
  label?: string;
  meta: ComponentChildren;
  pending?: boolean;
  foot?: ComponentChildren;
  /** Полная подпись для экранного диктора: «Клиент Анна, 16:21: …». */
  a11y: string;
  /** Кнопка сбоку от пузыря у его низа («⋯» сообщения): не занимает строку под пузырём (J-15). */
  aside?: ComponentChildren;
  children: ComponentChildren;
}

/** Пузырь ленты: голоса различаются формой, цветом и подписью (6.3.2). */
export function Bubble({ voice, label, meta, pending, foot, a11y, aside, children }: BubbleProps): JSX.Element {
  const side = voice === 'client' ? 'in' : 'out';
  return (
    <div class={s.bubbleWrap} data-side={side}>
      {label && (
        <span class={s.bubbleLabel} data-voice={voice} aria-hidden="true">
          {label}
        </span>
      )}
      <div class={s.bubble} data-voice={voice} data-pending={pending ? 'true' : 'false'}>
        <span class="visually-hidden">{a11y}</span>
        <span aria-hidden="true">{children}</span>
        <span class={`${s.bubbleMeta} num`}>{pending && <Icon name="clock" size={12} />}{meta}</span>
        {foot && <div class={s.bubbleFoot}>{foot}</div>}
        {aside && <span class={s.bubbleAside}>{aside}</span>}
      </div>
    </div>
  );
}
