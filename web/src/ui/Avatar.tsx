import type { JSX } from 'preact';
import type { Channel } from '@/lib/types';
import { channelLabel } from '@/lib/labels';
import { Icon } from './Icon';
import s from './ui.module.css';

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '·';
}

/** Спокойный тон аватара из имени: один и тот же человек — один и тот же цвет. */
export function tintOf(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return (hash % 6) + 1;
}

interface AvatarProps {
  name: string;
  size?: 's' | 'm' | 'l';
  channel?: Channel;
}

export function Avatar({ name, size = 'm', channel }: AvatarProps): JSX.Element {
  return (
    <span class={s.avatar} data-size={size} data-tint={String(tintOf(name))} aria-hidden="true">
      {initials(name)}
      {channel && (
        <span class={s.avatarBadge} title={channelLabel(channel)}>
          <Icon name={channel === 'bedolaga' || channel === 'minishop' ? 'ticket' : 'plane'} size={12} />
        </span>
      )}
    </span>
  );
}
