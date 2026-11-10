/**
 * Один слой поверх окон (W-1). Листы и палитра — модальные <dialog> в верхнем слое
 * браузера; всё вне верхнего модального окна инертно, z-index его не обгоняет.
 * Поэтому «плавающие» элементы (стопка тостов) живут как popover="manual" и
 * переезжают внутрь верхнего открытого окна: так они и видны (верхний слой, поверх
 * окна), и нажимаются (потомок модального окна не инертен). Нет окон — в <body>.
 */
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

/** Открыть модальное окно и поднять над ним плавающие элементы. */
export function openModal(dialog: HTMLDialogElement): void {
  if (dialog.open) return;
  dialog.showModal();
  if (!stack.includes(dialog)) stack.push(dialog);
  dialog.addEventListener('close', () => {
    const index = stack.indexOf(dialog);
    if (index >= 0) stack.splice(index, 1);
    place();
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
  if (dialog.open) dialog.close();
  place();
}
