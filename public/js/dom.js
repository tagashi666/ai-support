// Панель: DOM-хелперы и сочетания клавиш платформы.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './state.js';

export const WINDOW_MS = 864e5, SOON_MS = 108e5;
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// Подсказки соответствуют системе пользователя, сами обработчики принимают
// оба варианта. navigator.platform оставлен fallback для старых браузеров.
const applePlatform = /Mac|iPhone|iPad|iPod/i.test(
  navigator.userAgentData?.platform || navigator.platform || navigator.userAgent,
);
function applyPlatformShortcuts() {
  const modifier = applePlatform ? '⌘' : 'Ctrl+';
  $('globalShortcut').textContent = `${modifier}K`;
  $('globalSearch').setAttribute('aria-keyshortcuts', applePlatform ? 'Meta+K' : 'Control+K');
  $('send').title = `Отправить (${modifier}${applePlatform ? '↵' : 'Enter'})`;
  $('send').setAttribute('aria-keyshortcuts', applePlatform ? 'Meta+Enter' : 'Control+Enter');
}
applyPlatformShortcuts();
