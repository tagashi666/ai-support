// Панель: запуск панели.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './live.js';
import { state } from './state.js';
import { $ } from './dom.js';
import { json, refreshTicket } from './api.js';
import { canPermission, applyRoleUi } from './access.js';
import { checkToken, openGate } from './gate.js';
import { show } from './nav.js';
import { loadInboxMeta, renderWindow } from './inbox-list.js';
import { open, refresh } from './conversation.js';
import { loadNavigationCounts } from './queue.js';
import { liveOpen, connect, rotateTicket } from './live.js';

/** Ссылка из уведомления вида /#c12 открывает нужный диалог сразу. */
async function openFromHash() {
  // #v=<раздел> — ссылка «Открыть в классической» из новой панели (план, раздел 12).
  const view = /^#v=([a-z]+)$/.exec(location.hash)?.[1];
  if (view && document.querySelector(`.nav[data-view="${view}"]`)) { show(view); return; }
  const match = /^#c(\d+)$/.exec(location.hash);
  if (!match) return;
  show('inbox');
  await open(Number(match[1]));
}
window.addEventListener('hashchange', openFromHash);

export async function boot() {
  const identity = await json('/api/me');
  state.currentActor = identity?.actor ?? null;
  if (identity?.version) $('ver').textContent = 'v' + identity.version;
  applyRoleUi();
  if (canPermission('conversation:read')) {
    await refreshTicket();
    // События открываем сразу: всё, что придёт, пока грузятся список и
    // настройки, применится поверх и не потеряется.
    connect();
    // Билет живёт десять минут — обновляем заранее вместе с сокетом, чтобы
    // картинки и события не отваливались посреди работы.
    setInterval(() => { void rotateTicket(); }, 8 * 60_000);
  }
  state.templates = canPermission('templates:read') ? (await json('/api/templates'))?.templates ?? [] : [];
  $('templates').innerHTML = '<option value="">Шаблон…</option>';
  $('templates').append(...state.templates.map(t => Object.assign(document.createElement('option'), { value:String(t.id), textContent:t.title })));
  state.settings = canPermission('settings:read') ? await json('/api/settings') : null;
  if (state.settings) $('ver').textContent = 'v' + state.settings.version;
  if (canPermission('conversation:read')) { await loadInboxMeta(); await refresh(); }
  await loadNavigationCounts();
  if (canPermission('conversation:read')) await openFromHash();
  // WebSocket даёт обновление почти мгновенно. Пока он не открыт (разрыв
  // мобильной сети, перезапуск сервера), список опрашивается раз в пять
  // секунд; при живом сокете опрос не нужен.
  if (canPermission('conversation:read')) {
    setInterval(() => { if (document.visibilityState === 'visible' && !liveOpen()) void refresh(); }, 5000);
  }
  setInterval(renderWindow, 30000);
}

let savedTokenCheck = null;
if (state.token) {
  try { savedTokenCheck = await checkToken(state.token); }
  catch { openGate('Сервер сейчас недоступен. Проверьте соединение и попробуйте снова.'); }
}
if (savedTokenCheck?.ok) {
  $('app').hidden = false;
  await boot();
} else if (!state.token) {
  openGate('');
} else if (savedTokenCheck) {
  openGate(savedTokenCheck.status === 429 ? 'Слишком много попыток. Подождите минуту.' : 'Сохранённый токен больше не подходит');
}
