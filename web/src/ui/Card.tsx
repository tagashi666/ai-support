import type { ComponentChildren, JSX } from 'preact';
import s from './ui.module.css';

export function Card({ children, class: extra, label }: { children: ComponentChildren; class?: string; label?: string }): JSX.Element {
  return <section class={`${s.card} ${extra ?? ''}`} aria-label={label}>{children}</section>;
}
