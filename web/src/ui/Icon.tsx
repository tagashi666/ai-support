/**
 * Собственные значки: сетка 24, линия 1,75, скруглённые концы, currentColor
 * (план, 8.5). Знак помощника ✦ — тоже SVG, а не символ шрифта.
 */
import type { JSX } from 'preact';

const PATHS = {
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></>,
  today: <><circle cx="12" cy="12" r="4" /><path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M5.6 18.4l1.1-1.1M17.3 6.7l1.1-1.1" /></>,
  chats: <path d="M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 17 16h-6l-4.5 3.5V16H7a2.5 2.5 0 0 1-2.5-2.5z" />,
  knowledge: <><path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H19v14H6.5A1.5 1.5 0 0 0 5 19.5z" /><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3" /></>,
  spark: <path d="M12 3.5c.65 4.6 3.9 7.85 8.5 8.5-4.6.65-7.85 3.9-8.5 8.5-.65-4.6-3.9-7.85-8.5-8.5 4.6-.65 7.85-3.9 8.5-8.5z" fill="currentColor" stroke="none" />,
  assistant: <><path d="M12 3.5c.65 4.6 3.9 7.85 8.5 8.5-4.6.65-7.85 3.9-8.5 8.5-.65-4.6-3.9-7.85-8.5-8.5 4.6-.65 7.85-3.9 8.5-8.5z" /></>,
  reports: <path d="M5 19.5V12M10 19.5V5M15 19.5v-7M20 19.5V9" />,
  connections: <><path d="M9 3.5v4M15 3.5v4M7 7.5h10v3a5 5 0 0 1-10 0z" /><path d="M12 15.5v5" /></>,
  team: <><circle cx="9" cy="8.5" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M15.5 5.8a3 3 0 0 1 0 5.4M17 14.2a5.5 5.5 0 0 1 3.5 4.8" /></>,
  system: <path d="M3 12h4l2-5 4 10 2-5h6" />,
  more: <><circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" /></>,
  back: <path d="M14.5 5.5 8 12l6.5 6.5" />,
  down: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  right: <path d="M9.5 5.5 16 12l-6.5 6.5" />,
  send: <path d="M12 19V5.5M6 11.5 12 5.5l6 6" />,
  arrowDown: <path d="M12 5v13.5M6 12.5l6 6 6-6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  urgent: <path d="M12 6.2c.5 0 .9.25 1.15.68l5.4 9.4c.5.87-.12 1.97-1.15 1.97H6.6c-1.03 0-1.65-1.1-1.15-1.97l5.4-9.4c.25-.43.65-.68 1.15-.68z" fill="currentColor" stroke="none" />,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></>,
  lock: <><rect x="5.5" y="10.5" width="13" height="9" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
  pause: <path d="M9 6.5v11M15 6.5v11" />,
  client: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 19.5a7 7 0 0 1 14 0" /></>,
  plane: <path d="M20.5 4.5 3.5 11.2l6.1 2.1 2.2 6.2 3.1-4.2 4.6 3.2z" />,
  ticket: <path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5V10a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5V14a2 2 0 0 0 0-4z" />,
  note: <><path d="M6 4.5h9l3.5 3.5v11.5H6z" /><path d="M9 11h6M9 14.5h4" /></>,
  flask: <path d="M9.5 3.5h5M10.5 3.5v5.2L5.6 17.4a2 2 0 0 0 1.8 3.1h9.2a2 2 0 0 0 1.8-3.1l-4.9-8.7V3.5" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  undo: <><path d="M9 7.5 4.5 12 9 16.5" /><path d="M5 12h9.5a5 5 0 0 1 5 5v1" /></>,
  edit: <path d="M14.5 5.5l4 4L9 19H5v-4z" />,
  filter: <path d="M4.5 6h15M7.5 12h9M10.5 18h3" />,
} as const;

export type IconName = keyof typeof PATHS;

interface IconProps {
  name: IconName;
  size?: number;
  class?: string;
  /** Подпись для экранного диктора; без неё значок декоративный. */
  label?: string;
}

export function Icon({ name, size = 20, class: className, label }: IconProps): JSX.Element {
  return (
    <svg
      class={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
