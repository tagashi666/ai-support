import type { ComponentChildren, JSX } from 'preact';
import { Icon, type IconName } from './Icon';
import s from './ui.module.css';

type Variant = 'primary' | 'secondary' | 'quiet' | 'link' | 'danger';

interface ButtonProps extends Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'icon' | 'size'> {
  variant?: Variant;
  size?: 'md' | 'sm';
  icon?: IconName;
  /** Кнопка только со значком: подпись обязательна (aria-label и подсказка). */
  label?: string;
  disabled?: boolean;
  type?: 'button' | 'submit';
  children?: ComponentChildren;
}

export function Button({
  variant = 'secondary', size = 'md', icon, label, children, class: extra, type = 'button', ...rest
}: ButtonProps): JSX.Element {
  const iconOnly = !children && Boolean(label);
  const cls = [s.btn, s[variant], size === 'sm' ? s.sm : '', iconOnly ? s.iconOnly : '', extra ?? '']
    .filter(Boolean).join(' ');
  return (
    <button type={type} class={cls} aria-label={iconOnly ? label : undefined} title={iconOnly ? label : undefined} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 18 : 20} />}
      {children}
    </button>
  );
}
