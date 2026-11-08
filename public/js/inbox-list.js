// Панель: инбокс: форматирование, аватарки, список диалогов.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './folds.js';
import { state } from './state.js';
import { WINDOW_MS, SOON_MS, $, esc } from './dom.js';
import { json, reloadMedia, mediaRetryDelay } from './api.js';
import { canPermission, canWrite, canCompose } from './access.js';
import { show } from './nav.js';
import { open } from './conversation.js';

/* ═══ инбокс ═══ */
export const fmtLeft = (ms) => { const h = Math.floor(ms/36e5), m = Math.floor(ms%36e5/6e4); return h ? `${h} ч ${m} мин` : `${m} мин`; };
export const fmtTime = (ts) => new Date(ts).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
export const fmtDate = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? fmtTime(t) : String(v); };
export const nameOf = (c) => c.display_name || (c.username ? '@'+c.username : (c.subject || `#${c.external_id}`));
export const channelLabel = (c) => c.source?.name || (c.channel === 'tg_dm' ? 'Telegram · Business'
  : c.channel === 'tg_bot' ? 'Telegram · Бот'
  : c.channel === 'minishop' ? 'Тикет MiniShop'
  : 'Тикет Bedolaga');
const CONVERSATION_STATUS = Object.freeze({
  open:'Открыто',
  pending:'Ждёт клиента',
  resolved:'Решено',
});
export const conversationStatus = (value) => CONVERSATION_STATUS[value] ?? 'Неизвестный статус';
export const gb = (b) => b == null ? '—' : `${(b / 1073741824).toFixed(1)} ГБ`;
export const initials = (value) => value.replace(/^@/, '').trim().split(/\s+/).slice(0, 2)
  .map((part) => Array.from(part)[0] ?? '').join('').toUpperCase() || '•';
// Версия — хэш file_id аватарки с сервера: URL меняется только вместе с
// картинкой, а не на каждое сообщение или новый билет.
export const avatarUrl = (c) => `/api/conversations/${Number(c.id)}/avatar?v=${encodeURIComponent(c.avatar_version ?? c.avatar_file_id ?? '')}`;
export const avatarMarkup = (c, className, unread = false, id = '') => `<span class="avatar-frame ${className}"${id ? ` id="${id}"` : ''} aria-hidden="true">
  <span class="avatar-initials">${esc(initials(nameOf(c)))}</span>
  ${c.avatar_file_id ? `<img class="avatar-photo" src="${avatarUrl(c)}" data-avatar-key="${esc(avatarUrl(c))}" alt="" width="38" height="38" loading="lazy" decoding="async" draggable="false">` : ''}
  ${unread ? '<span class="dot"></span>' : ''}</span>`;

/** Краткий сетевой сбой не должен навсегда удалять аватар из интерфейса. */
export function armAvatars(root = document) {
  const images = root.matches?.('img.avatar-photo') ? [root] : root.querySelectorAll?.('img.avatar-photo') ?? [];
  for (const image of images) {
    if (image.dataset.retryArmed) continue;
    image.dataset.retryArmed = '1';
    image.addEventListener('load', () => { image.hidden = false; image.dataset.retry = '0'; });
    image.addEventListener('error', async () => {
      image.hidden = true;
      const attempt = Number(image.dataset.retry ?? 0) + 1;
      image.dataset.retry = String(attempt);
      if (attempt > 6) return;
      const url = image.getAttribute('src');
      const wait = url ? await mediaRetryDelay(url, attempt) : null;
      if (wait === null) return;
      setTimeout(() => {
        if (!image.isConnected) return;
        image.hidden = false;
        reloadMedia(image);
      }, Math.max(wait, 1000 * attempt));
    });
  }
}
const visible = () => {
  const folderId = state.filter.startsWith('folder:') ? Number(state.filter.slice(7)) : 0;
  const folder = folderId ? state.inboxFolders.find((item) => item.id === folderId) : null;
  const scoped = state.filter === 'waiting' ? state.conversations.filter(c => c.unread > 0 || !c.first_response_at)
    : state.filter === 'hot' ? state.conversations.filter(c => c.escalated || c.suspicious || c.handoff_at || c.priority === 'high')
    : folder ? state.conversations.filter((c) => (c.source_ids ?? []).some((id) => folder.source_ids.includes(id)))
    : state.conversations;
  if (!state.listQuery) return scoped;
  const query = state.listQuery.toLocaleLowerCase('ru');
  return scoped.filter((c) => [nameOf(c), c.subject, c.username, c.external_id]
    .some((value) => String(value ?? '').toLocaleLowerCase('ru').includes(query)));
};

export const safeColor = (value) => /^#[0-9a-f]{6}$/i.test(String(value ?? '')) ? value : '#9298ff';
export const sourceKind = (kind) => ({ telegram_bot:'Бот', telegram_business:'Business', bedolaga:'Bedolaga', minishop:'MiniShop', remnawave:'Remnawave' }[kind] ?? kind);

export function renderInboxTabs() {
  const tabs = $('filters');
  if (state.filter.startsWith('folder:') && !state.inboxFolders.some((folder) => `folder:${folder.id}` === state.filter)) state.filter = 'all';
  const builtins = [
    ['all', 'Все'],
    ['waiting', 'Ждут'],
    ['hot', 'Важные'],
  ];
  tabs.innerHTML = builtins.map(([id, label]) => `<button data-filter="${id}" aria-pressed="${state.filter === id}">${label}</button>`).join('')
    + state.inboxFolders.map((folder) => `<button data-filter="folder:${folder.id}" aria-pressed="${state.filter === `folder:${folder.id}`}" title="${esc(folder.source_ids.length)} источников"><i style="--folder-color:${safeColor(folder.color)}"></i>${esc(folder.name)}</button>`).join('');
}

export async function loadInboxMeta() {
  const meta = await json('/api/inbox/meta');
  if (!meta) return;
  state.inboxSources = meta.sources ?? [];
  state.inboxFolders = meta.folders ?? [];
  renderInboxTabs();
  renderList(true);
}

/** Переключение выделения не требует пересборки списка. */
export function markSelected(id) {
  for (const row of $('list').children) {
    if (row.dataset) row.setAttribute('aria-selected', String(Number(row.dataset.id) === id));
  }
}

let listSignature = '';
export function renderList(force = false) {
  const items = visible();
  // Полная перерисовка списка на каждое событие ощутимо тормозит: при
  // потоке сообщений кадр уходит на пересборку одинаковых строк. Выделение
  // в подпись не входит — оно меняется атрибутом.
  const signature = `${state.filter}:${state.listQuery}|` + items.map((c) =>
    `${c.id}:${c.unread}:${c.last_message_at}:${c.status}:${c.priority}:${nameOf(c)}:${c.username}:${c.avatar_file_id}:${c.subject}:${c.source?.name}:${(c.source_ids ?? []).join('.')}:${c.escalated}${c.suspicious}${c.handoff_at ? 1 : 0}${c.ai_mode}:${c.window?.open}`).join(',');
  if (!force && signature === listSignature) return;
  listSignature = signature;

  const box = $('list');
  const frag = document.createDocumentFragment();
  const waiting = state.conversations.filter(c => c.unread > 0).length;
  $('cntInbox').textContent = waiting || state.conversations.length;
  renderBoard();
  if (!items.length) { box.replaceChildren(Object.assign(document.createElement('p'), { className:'empty', textContent:state.listQuery ? 'Ничего не найдено.' : 'Здесь пока пусто.' })); return; }
  // Уже загруженные аватарки переносим в новые строки как есть: новый <img>
  // на каждое событие давал мигание даже при попадании в кэш.
  const loadedAvatars = new Map();
  for (const image of box.querySelectorAll('img.avatar-photo[data-avatar-key]')) {
    if (image.complete && image.naturalWidth) loadedAvatars.set(image.dataset.avatarKey, image);
  }
  for (const c of items) {
    const row = document.createElement('div');
    row.className = 'row'; row.tabIndex = 0; row.dataset.id = String(c.id);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(state.current?.id === c.id));
    row.setAttribute('aria-label', `${nameOf(c)}, ${c.unread ? `${c.unread} непрочитанных` : 'прочитано'}`);
    const closed = c.window.applies && !c.window.open;
    row.innerHTML = `
      ${avatarMarkup(c, 'row-avatar', Boolean(c.unread))}
      <div class="row-main">
        <div class="who"><span class="row-person"><b>${esc(nameOf(c))}</b>${c.username && nameOf(c) !== '@'+c.username ? `<em>@${esc(c.username)}</em>` : ''}</span><small>${c.last_message_at ? fmtTime(c.last_message_at) : ''}</small></div>
        <div class="snippet">${closed ? 'Окно ответа закрыто' : esc(c.subject || conversationStatus(c.status))}</div>
        <div class="chips"><span class="chip channel">${esc(channelLabel(c))}</span>
          ${closed ? '<span class="chip hot">24 ч закрыто</span>' : ''}
          ${c.suspicious ? '<span class="chip hot">нет в базах</span>' : ''}
          ${c.escalated ? '<span class="chip hot">важно</span>' : ''}
          ${c.handoff_at ? '<span class="chip hot">у человека</span>' : ''}
          ${c.ai_mode === 'auto' ? '<span class="chip ai">AI авто</span>' : ''}
          ${c.ai_mode === 'shadow' ? '<span class="chip ai">AI тень</span>' : ''}</div>
      </div>`;
    const freshAvatar = row.querySelector('img.avatar-photo[data-avatar-key]');
    const keptAvatar = freshAvatar && loadedAvatars.get(freshAvatar.dataset.avatarKey);
    if (keptAvatar) { loadedAvatars.delete(freshAvatar.dataset.avatarKey); freshAvatar.replaceWith(keptAvatar); }
    row.onclick = () => open(c.id);
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(c.id); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const sibling = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
        sibling?.focus();
      }
    };
    frag.append(row);
  }
  box.replaceChildren(frag);
  armAvatars(box);
}

/** Живая сводка внизу навигации: клик ведёт к соответствующему фильтру. */
function renderBoard() {
  const board = $('pulseBoard');
  if (!board) return;
  const unread = state.conversations.filter(c => c.unread > 0).length;
  const noAnswer = state.conversations.filter(c => !c.first_response_at && c.last_inbound_at).length;
  const waitHuman = state.conversations.filter(c => c.handoff_at).length;
  const unknown = state.conversations.filter(c => c.suspicious).length;

  const rows = [
    ['Непрочитанных', unread, unread ? 'hot' : '', 'waiting'],
    ['Без ответа', noAnswer, noAnswer ? 'warn' : '', 'waiting'],
    ['Ждут человека', waitHuman, waitHuman ? 'warn' : '', 'hot'],
    ['Нет в базах', unknown, unknown ? 'hot' : '', 'hot'],
  ];
  board.innerHTML = rows.map(([label, value, tone, target]) =>
    `<button data-filter="${target}"><span class="mark ${tone}"></span>${esc(label)}<b>${value}</b></button>`).join('');
  board.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    show('inbox');
    state.filter = b.dataset.filter;
    for (const o of $('filters').children) o.setAttribute('aria-pressed', String(o.dataset.filter === state.filter));
    renderList(true);
  };
}

export function renderWindow() {
  const box = $('composer');
  if (!state.current) { box.hidden = true; return; }
  box.hidden = false;
  if (!canCompose()) {
    box.dataset.window = 'closed';
    $('ring').style.setProperty('--p', 0);
    $('wleft').textContent = 'режим просмотра';
    $('input').disabled = $('send').disabled = true;
    $('input').placeholder = 'Наблюдатель не может отвечать или оставлять заметки';
    $('send').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
    $('send').setAttribute('aria-label', 'Ответы недоступны в режиме просмотра');
    return;
  }
  if (!canWrite()) {
    box.dataset.window = 'open'; $('ring').style.setProperty('--p', 0);
    $('wleft').textContent = 'без права ответа';
    $('input').disabled = !canPermission('conversation:notes'); $('send').disabled = true;
    $('input').placeholder = canPermission('conversation:notes') ? 'Текст внутренней заметки' : 'Ответы запрещены настройками роли';
    $('send').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
    $('send').setAttribute('aria-label', 'Ответы запрещены настройками роли');
    return;
  }
  if (!state.current.window.applies) {
    box.dataset.window = 'open'; $('ring').style.setProperty('--p', 100);
    $('wleft').textContent = 'без ограничения';
    $('input').disabled = $('send').disabled = false;
    $('send').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 14-7-4 14-3-6-7-1Z"/></svg>';
    $('send').setAttribute('aria-label', 'Отправить сообщение'); return;
  }
  const left = Math.max(0, (state.current.last_inbound_at ?? 0) + WINDOW_MS - Date.now());
  const windowState = left === 0 ? 'closed' : left < SOON_MS ? 'soon' : 'open';
  box.dataset.window = windowState;
  $('ring').style.setProperty('--p', Math.round(left / WINDOW_MS * 100));
  $('wleft').textContent = windowState === 'closed' ? 'окно ответа закрыто' : `осталось ${fmtLeft(left)}`;
  $('input').disabled = $('send').disabled = windowState === 'closed';
  $('send').innerHTML = windowState === 'closed'
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 14-7-4 14-3-6-7-1Z"/></svg>';
  $('send').setAttribute('aria-label', windowState === 'closed' ? 'Окно ответа закрыто' : 'Отправить сообщение');
  $('input').placeholder = windowState === 'closed'
    ? 'Клиент не писал больше суток — Telegram не пропустит ответ'
    : 'Ответ уйдёт от имени аккаунта поддержки';
}
