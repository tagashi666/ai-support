/**
 * Один слой поверх окон (W-1). Листы и палитра — модальные <dialog> в верхнем слое
 * браузера; всё вне верхнего модального окна инертно, z-index его не обгоняет.
 * Поэтому «плавающие» элементы (стопка тостов) живут как popover="manual" и
 * переезжают внутрь верхнего открытого окна: так они и видны (верхний слой, поверх
 * окна), и нажимаются (потомок модального окна не инертен). Нет окон — в <body>.
 */
import { dur } from './motion';

const stack: HTMLDialogElement[] = [];
const hosts = new Set<HTMLElement>();

function place(): void {
  const top = stack.filter((dialog) => dialog.isConnected && dialog.open).pop() ?? document.body;
  for (const host of hosts) {
    if (host.parentElement !== top) top.append(host);
    // После переезда popover закрыт: показать снова — он встанет поверх окна.
    if (host.showPopover && !host.matches(':popover-open')) host.showPopover();
  }
}

/*
 * Выход окна там, где нет `overlay` для transition (WebKit, Firefox — R2 C). Окно закрывается
 * сразу (страница не инертна ни кадра, M-3), а на время выхода остаётся «тенью»: атрибут
 * open без модальности (без фокуса — inert), data-state="closing" играет выход
 * (ui.module.css, palette.module.css), подложка гаснет отдельным элементом. В Chromium
 * выход играет CSS-переход с overlay — тень не нужна.
 */
const OVERLAY = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('overlay', 'auto');

function ghost(dialog: HTMLDialogElement): void {
  if (OVERLAY || !dialog.isConnected || dialog.open) return;
  const scrim = document.createElement('div');
  scrim.className = 'ui-scrim-out';
  dialog.before(scrim);
  dialog.inert = true;
  dialog.dataset.state = 'closing';
  dialog.setAttribute('open', '');
  setTimeout(() => {
    scrim.remove();
    if (dialog.dataset.state !== 'closing') return;
    delete dialog.dataset.state;
    dialog.removeAttribute('open');
    dialog.inert = false;
  }, dur('exit'));
}

function unghost(dialog: HTMLDialogElement): void {
  if (dialog.dataset.state !== 'closing') return;
  delete dialog.dataset.state;
  dialog.removeAttribute('open');
  dialog.inert = false;
}

/** Открыть модальное окно и поднять над ним плавающие элементы. */
export function openModal(dialog: HTMLDialogElement): void {
  unghost(dialog);
  if (dialog.open) return;
  dialog.showModal();
  if (!stack.includes(dialog)) stack.push(dialog);
  dialog.addEventListener('close', () => {
    const index = stack.indexOf(dialog);
    if (index >= 0) stack.splice(index, 1);
    place();
    ghost(dialog);
  }, { once: true });
  place();
}

/** Плавающий элемент (тосты): держать в верхнем слое. Возвращает снятие. */
export function addFloating(host: HTMLElement): () => void {
  host.setAttribute('popover', 'manual');
  hosts.add(host);
  place();
  return () => { hosts.delete(host); host.remove(); };
}

/** Закрыть модальное окно (или снять его из стопки, если его уже убрали из DOM). */
export function closeModal(dialog: HTMLDialogElement): void {
  const index = stack.indexOf(dialog);
  if (index >= 0) stack.splice(index, 1);
  if (dialog.dataset.state === 'closing') return;
  if (dialog.open) { dialog.close(); ghost(dialog); }
  place();
}
