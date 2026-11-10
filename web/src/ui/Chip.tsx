import type { JSX } from 'preact';
import { Icon } from './Icon';
import s from './ui.module.css';

interface ChipProps {
  text: string;
  tone: 'ai' | 'attention' | 'you' | 'quiet';
  lead: 'spark' | 'pause' | 'dot';
  /** Есть лист по нажатию: показываем стрелку. */
  menu?: boolean;
  onClick?: () => void;
  id?: string;
}

/** Чип «кто отвечает» (6.3.1). Значок всегда рядом с цветом: состояние не передаётся только цветом. */
export function Chip({ text, tone, lead: leadKind, menu, onClick, id }: ChipProps): JSX.Element {
  const lead = leadKind === 'spark'
    ? <span class={s.chipDot} aria-hidden="true" />
    : leadKind === 'pause' ? <Icon name="pause" size={16} /> : <span class={s.chipDot} aria-hidden="true" />;
  return (
    <button
      type="button"
      id={id}
      class={s.chip}
      data-tone={tone}
      disabled={!menu}
      aria-haspopup={menu ? 'dialog' : undefined}
      onClick={menu ? onClick : undefined}
    >
      {lead}
      <span class={s.chipText}>{text}</span>
      {menu && <Icon name="down" size={16} />}
    </button>
  );
}
