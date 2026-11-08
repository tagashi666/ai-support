// Панель: инбокс: открытие диалога, присутствие, синхронизация.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './inspector.js';
import { state } from './state.js';
import { $ } from './dom.js';
import { api, json } from './api.js';
import { canPermission, canWrite } from './access.js';
import { toast } from './nav.js';
import {
  nameOf, channelLabel, initials, avatarUrl, avatarMarkup, armAvatars, markSelected, renderList, renderWindow,
} from './inbox-list.js';
import { messageSignature, bubble, renderQuoting, renderSuggestion } from './thread.js';
import {
  renderCustomer, renderCollaboration, loadUnifiedProfile, renderSubscription, renderAiNote,
} from './inspector.js';
import { renderPendingFiles } from './composer.js';
import { listable } from './rules.js';

/**
 * Открытие диалога.
 *
 * Раньше здесь ждали четыре запроса подряд, и один из них на сервере ходил
 * в бедолагу и Remnawave — переключение занимало под секунду. Теперь шапка
 * и состояние рисуются мгновенно из уже загруженного списка, переписка
 * приходит одним запросом, а карточка и подписка догружаются фоном.
 */
let openToken = 0;

/** Видимость операторов не захватывает диалог и не мешает AI отвечать. */
export async function heartbeatCurrent() {
  if (!state.current || !canPermission('conversation:read') || document.visibilityState !== 'visible') return;
  const id = state.current.id;
  try {
    const response = await api(`/api/conversations/${id}/presence`, {
      method:'POST', body:JSON.stringify({ state:'viewing' }),
    });
    const data = await response.json().catch(() => null);
    if (state.current?.id === id && data?.collaboration) {
      state.current.collaboration = data.collaboration;
      renderCollaboration(data.collaboration);
    }
  } catch {}
}

/** Реальное намерение ответить: теперь AI должен уступить оператору. */
export async function engageCurrent() {
  if (!state.current || !canWrite() || document.visibilityState !== 'visible') return;
  const id = state.current.id;
  try {
    const response = await api(`/api/conversations/${id}/engage`, {
      method:'POST', body:JSON.stringify({ state:'typing' }),
    });
    const data = await response.json().catch(() => null);
    if (state.current?.id === id && data?.collaboration) {
      state.current.collaboration = data.collaboration;
      renderCollaboration(data.collaboration);
    }
  } catch {}
}
setInterval(heartbeatCurrent, 15_000);
window.addEventListener('focus', heartbeatCurrent);
document.addEventListener('visibilitychange', heartbeatCurrent);

/** `keepError` — для живых кадров: они не должны стирать ошибку отправки. */
export function paintHeader(c, { keepError = false } = {}) {
  if (!c) {
    $('title').textContent = 'Диалог не выбран';
    $('subtitle').textContent = 'Выберите обращение в списке';
    for (const id of ['statusSel', 'contextStatusSel', 'aiSel', 'escBtn', 'handoffBtn']) $(id).disabled = true;
    $('foldClient').textContent = '';
    $('err').textContent = '';
    return;
  }
  $('title').textContent = nameOf(c);
  const titleKey = `${c.id}:${c.avatar_file_id ? avatarUrl(c) : ''}:${initials(nameOf(c))}`;
  if ($('titleAvatar').dataset.key !== titleKey) {
    $('titleAvatar').outerHTML = avatarMarkup(c, 'title-avatar', false, 'titleAvatar');
    $('titleAvatar').dataset.key = titleKey;
    armAvatars($('titleAvatar'));
  }
  $('subtitle').textContent = `${c.username ? '@' + c.username + ' · ' : ''}${channelLabel(c)} · ${c.external_id}`;
  $('statusSel').value = c.status;
  $('contextStatusSel').value = c.status;
  $('aiSel').value = c.ai_mode;
  $('escBtn').textContent = c.escalated ? 'Снять важность' : 'Важно';
  $('escBtn').title = c.escalated ? 'Снять отметку важного обращения' : 'Пометить обращение важным';
  $('handoffBtn').textContent = c.handoff_at ? 'Вернуть AI' : 'Взять диалог';
  $('handoffBtn').title = c.handoff_at ? 'Вернуть диалог в автоматический режим' : 'Передать диалог человеку';
  for (const id of ['statusSel', 'contextStatusSel', 'aiSel', 'escBtn', 'handoffBtn', 'hideConversationBtn']) {
    $(id).disabled = !canPermission('conversation:status');
    $(id).title = canPermission('conversation:status') ? '' : 'Действие запрещено настройками роли';
  }
  $('foldClient').textContent = c.suspicious ? 'нет в базах' : '';
  if (!keepError) $('err').textContent = '';
}

/**
 * Черновик ввода у каждого диалога свой. Поле ввода одно на все диалоги, и
 * текст, набранный (или взятый из предложки) для одного клиента, при
 * переключении оставался в поле и уходил другому.
 */
const drafts = new Map();
export const clearDraft = (id) => { drafts.delete(id); };
function swapDraft(fromId, toId) {
  const input = $('input');
  if (fromId) {
    if (input.value.trim()) drafts.set(fromId, input.value); else drafts.delete(fromId);
  }
  input.value = drafts.get(toId) ?? '';
  input.style.height = 'auto';
  if (input.value) input.style.height = Math.min(input.scrollHeight, 148) + 'px';
}

function skeleton(rows = 5) {
  const inner = document.createElement('div');
  inner.className = 'thread-inner';
  for (let i = 0; i < rows; i += 1) {
    const line = document.createElement('div');
    line.className = `msg ${i % 3 === 2 ? 'out' : 'in'}`;
    line.innerHTML = `<div class="bubble skel" style="width:${120 + (i * 47) % 220}px; height:${i % 4 === 1 ? 42 : 26}px"></div>`;
    inner.append(line);
  }
  return inner;
}

/** Кнопка «Показать ранние»: догружает историю порциями, не сдвигая экран. */
function olderButton(conversationId, firstId) {
  const button = Object.assign(document.createElement('button'), { type:'button', className:'btn older-messages', textContent:'Показать ранние сообщения' });
  button.onclick = async () => {
    button.disabled = true; button.textContent = 'Загружаю…';
    const page = await json(`/api/conversations/${conversationId}?before=${firstId}`);
    if (!button.isConnected || state.current?.id !== conversationId) return;
    if (!page) { button.disabled = false; button.textContent = 'Не удалось загрузить. Повторить'; return; }
    const thread = $('thread');
    const fromBottom = thread.scrollHeight - thread.scrollTop;
    const nodes = page.messages.map((m) => bubble(m, page.attachments));
    if (page.hasMore && page.messages.length) nodes.unshift(olderButton(conversationId, page.messages[0].id));
    button.replaceWith(...nodes);
    thread.scrollTop = thread.scrollHeight - fromBottom;
  };
  return button;
}

export async function open(id) {
  if (state.current?.id && state.current.id !== id && state.pendingFiles.length && !state.uploadRunning) {
    for (const item of state.pendingFiles) if (item.preview) URL.revokeObjectURL(item.preview);
    state.pendingFiles = []; renderPendingFiles();
  }
  const switching = state.current?.id !== id;
  if (switching) {
    swapDraft(state.current?.id, id);
    // Цитата относится к сообщению прежнего диалога — и тогда, когда нового
    // диалога нет в списке (поиск, очередь, ссылка #c…).
    state.quoting = null; renderQuoting();
  }
  const openTicket = ++openToken;
  $('inboxSplit').dataset.pane = 'thread';
  history.replaceState(null, '', `#c${id}`);

  // Мгновенная отрисовка: данные диалога уже есть в списке, ждать сервер
  // ради шапки незачем.
  const known = state.conversations.find((c) => c.id === id);
  if (known) {
    state.current = known;
    heartbeatCurrent();
    state.quoting = null;
    paintHeader(known);
    renderWindow(); renderAiNote(); renderQuoting(); renderCollaboration(known.collaboration);
    markSelected(id);
  } else if (switching) {
    // Пока диалог грузится, state.current — ещё прежний: ответ ушёл бы не тому клиенту.
    $('input').disabled = $('send').disabled = true;
  }
  $('suggestBox').innerHTML = '';
  // Скелет показываем не сразу, а только если сервер задумался. На быстром
  // ответе (локальная сеть — обычный случай) мгновенный скелет успевал лишь
  // мигнуть. А из-за guard'а ниже при быстром переборе диалогов реально
  // дорисовывается только последний, но скелет мелькал на КАЖДОМ клике —
  // это и читалось как дёрганье. Порог гасит вспышку: прежняя переписка
  // держится, пока не придут данные, и сразу сменяется плавным появлением.
  const skelTimer = setTimeout(() => {
    if (openTicket === openToken) $('thread').replaceChildren(skeleton());
  }, 140);

  let response = null;
  try { response = await api(`/api/conversations/${id}`); } catch { /* сеть */ }
  const data = response?.ok ? await response.json().catch(() => null) : null;
  clearTimeout(skelTimer);
  if (openTicket !== openToken) return;   // пока грузили, открыли другой
  if (!data) {
    // Раньше при 403/404/5xx скелетон висел вечно. Теперь — причина и повтор.
    const box = document.createElement('div');
    box.className = 'thread-inner';
    const text = Object.assign(document.createElement('p'), { className:'empty',
      textContent: response?.status === 404 ? 'Диалог не найден или удалён.'
        : response?.status === 403 ? 'Нет доступа к этому диалогу.'
        : 'Не удалось загрузить переписку. Проверьте соединение.' });
    const retry = Object.assign(document.createElement('button'), { type:'button', className:'btn', textContent:'Повторить' });
    retry.onclick = () => void open(id);
    box.append(text, retry);
    $('thread').replaceChildren(box);
    $('thread').removeAttribute('data-conversation-id');
    return;
  }

  state.current = data.conversation;
  heartbeatCurrent();
  state.suggestion = data.suggestion;
  paintHeader(state.current);

  const inner = document.createElement('div');
  inner.className = 'thread-inner';
  if (!data.messages.length) inner.innerHTML = '<p class="empty">Сообщений пока нет.</p>';
  // Пузыри по отдельности не анимируем: при открытии это читается как
  // рябь. Появляется вся переписка целиком, одним движением.
  if (data.hasMore && data.messages.length) inner.append(olderButton(id, data.messages[0].id));
  for (const m of data.messages) inner.append(bubble(m, data.attachments));
  inner.classList.add('enter');
  $('thread').replaceChildren(inner);
  $('thread').dataset.conversationId = String(id);
  // Прокрутку ставим тем же кадром, до отрисовки: перенос в rAF давал
  // видимый прыжок от верха к низу.
  $('thread').scrollTop = $('thread').scrollHeight;

  renderWindow(); renderSuggestion(); renderAiNote();
  renderCustomer(data.customer);
  renderCollaboration(state.current.collaboration);
  void loadUnifiedProfile(id);

  // Всё, что ходит в сеть, — после отрисовки и без ожидания.
  markOpenConversationRead(id);
  if (data.customerStale) {
    void json(`/api/conversations/${id}/customer`).then((res) => {
      if (res && openTicket === openToken) renderCustomer(res.customer);
    });
  }
  void renderSubscription();
}

let refreshTimer = null;
export const refreshSoon = () => { if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 400); };
let refreshPromise = null, refreshAgain = false;
let currentSyncPromise = null, currentSyncId = null;
let readTimer = null;

export function markOpenConversationRead(id = state.current?.id) {
  if (!canPermission('conversation:read') || !id || state.current?.id !== id) return;
  state.current = { ...state.current, unread:0 };
  const index = state.conversations.findIndex((item) => item.id === id);
  if (index >= 0) state.conversations[index] = { ...state.conversations[index], unread:0 };
  renderList();
  clearTimeout(readTimer);
  readTimer = setTimeout(async () => {
    if (state.current?.id !== id) return;
    try {
      const response = await api(`/api/conversations/${id}/read`, { method:'POST' });
      const data = response.ok ? await response.json().catch(() => null) : null;
      if (data?.conversation) mergeLiveConversation(data.conversation);
    } catch (error) {
      console.warn('Не удалось подтвердить прочтение диалога', error);
    }
  }, 120);
}

/**
 * HTTP-reconciliation открытой переписки. WebSocket остаётся быстрым путём,
 * но краткий сетевой разрыв больше не требует закрывать и открывать диалог.
 */
export async function syncCurrentMessages(id = state.current?.id, { full = false } = {}) {
  if (!id) return;
  if (currentSyncPromise) {
    if (currentSyncId === id && !full) return currentSyncPromise;
    await currentSyncPromise;
    return state.current?.id === id ? syncCurrentMessages(id, { full }) : undefined;
  }
  currentSyncId = id;
  currentSyncPromise = (async () => {
    // Обычно нужна только дозагрузка: правки и удаления приходят по WS.
    // Полная сверка — после разрыва связи или если переписка ещё не нарисована.
    const thread = $('thread');
    const drawn = thread.dataset.conversationId === String(id) ? thread.querySelector('.thread-inner') : null;
    const lastId = drawn ? Math.max(0, ...[...drawn.querySelectorAll('.msg[data-message-id]')]
      .map((node) => Number(node.dataset.messageId) || 0)) : 0;
    const incremental = !full && lastId > 0;
    const data = await json(incremental ? `/api/conversations/${id}?after=${lastId}` : `/api/conversations/${id}`);
    if (!data || state.current?.id !== id) return;
    let inner = thread.dataset.conversationId === String(id) ? thread.querySelector('.thread-inner') : null;
    if (!inner) {
      inner = document.createElement('div');
      inner.className = 'thread-inner';
      thread.replaceChildren(inner);
      thread.dataset.conversationId = String(id);
    }
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;
    if (!incremental) {
      const serverIds = new Set(data.messages.map((message) => message.id));
      // Сервер отдаёт последние 200: догруженная кнопкой ранняя история
      // старше этого окна и удалённой не считается.
      const oldestServerId = data.hasMore && data.messages.length ? data.messages[0].id : 0;
      for (const node of inner.querySelectorAll('.msg[data-message-id]')) {
        const nodeId = Number(node.dataset.messageId);
        if (nodeId >= oldestServerId && !serverIds.has(nodeId)) node.remove();
      }
    }
    if (inner.querySelector('.empty') && data.messages.length) inner.innerHTML = '';
    let appended = 0;
    for (const message of data.messages) {
      const existing = inner.querySelector(`.msg[data-message-id="${message.id}"]`);
      const files = data.attachments[message.id] ?? [];
      if (existing) {
        if (existing.dataset.messageSignature !== messageSignature(message, files)) {
          existing.replaceWith(bubble(message, data.attachments));
        }
      } else {
        inner.append(bubble(message, data.attachments));
        appended += 1;
      }
    }
    if (!incremental && !data.messages.length) inner.innerHTML = '<p class="empty">Сообщений пока нет.</p>';
    state.current = data.conversation;
    state.suggestion = data.suggestion;
    paintHeader(state.current); renderWindow(); renderSuggestion(); renderAiNote();
    renderCollaboration(state.current.collaboration);
    if (appended && data.messages.some((message) => message.direction === 'in')) markOpenConversationRead(id);
    if (appended && nearBottom) requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
    else if (appended) toast('Новые сообщения ниже по переписке');
  })();
  try { await currentSyncPromise; }
  finally { currentSyncPromise = null; currentSyncId = null; }
}

let refreshFullThread = false;
export async function refresh({ fullThread = false } = {}) {
  if (fullThread) refreshFullThread = true;
  if (refreshPromise) { refreshAgain = true; return refreshPromise; }
  refreshPromise = (async () => {
    const full = refreshFullThread;
    refreshFullThread = false;
    const data = await json('/api/conversations');
    if (!data) return;
    const openId = state.current?.id;
    const previousLastMessageAt = Number(state.current?.last_message_at ?? 0);
    const previousUpdatedAt = Number(state.current?.updated_at ?? 0);
    state.conversations = data.conversations;
    if (state.current) state.current = state.conversations.find(c => c.id === state.current.id) ?? state.current;
    renderList();
    // Контрольный опрос раньше обновлял только левый список. Если push-кадр
    // потерялся, открытая переписка оставалась старой до повторного входа.
    if (openId && (full || Number(state.current?.last_message_at ?? 0) > previousLastMessageAt
      || Number(state.current?.updated_at ?? 0) > previousUpdatedAt)) {
      void syncCurrentMessages(openId, { full });
    }
  })();
  try { await refreshPromise; }
  catch (error) { console.warn('Conversation refresh failed; the live connection or next poll will retry.', error); }
  finally {
    refreshPromise = null;
    if (refreshAgain) { refreshAgain = false; void refresh(); }
  }
}

/** Событие попадает в список сразу, не дожидаясь контрольного HTTP-запроса. */
export function mergeLiveConversation(conversation) {
  if (!conversation?.id) return;
  const index = state.conversations.findIndex((item) => item.id === conversation.id);
  // Скрытый диалог (скрыт в другой вкладке, а кадр пришёл от фонового
  // обновления профиля или прочтения) в список не возвращаем: сервер его не отдаёт.
  if (!listable(conversation)) { if (index >= 0) state.conversations.splice(index, 1); }
  else if (index >= 0) state.conversations[index] = { ...state.conversations[index], ...conversation };
  else state.conversations.push(conversation);
  state.conversations.sort((a, b) => Number(b.last_message_at ?? b.created_at ?? 0) - Number(a.last_message_at ?? a.created_at ?? 0));
  if (state.current?.id === conversation.id) {
    state.current = { ...state.current, ...conversation };
    // Статус, режим AI и передача могли смениться не здесь: другой оператор,
    // AI, новое сообщение клиента, Bedolaga. Шапка и подпись режима — по кадру.
    paintHeader(state.current, { keepError:true }); renderWindow(); renderAiNote();
  }
  renderList();
}

export function removeLiveConversation(conversationId) {
  state.conversations = state.conversations.filter((item) => item.id !== conversationId);
  if (state.current?.id === conversationId) {
    state.current = null; state.suggestion = null;
    $('thread').removeAttribute('data-conversation-id');
    $('thread').innerHTML = '<p class="empty">Диалог скрыт или удалён.</p>';
    paintHeader(null); renderWindow(); renderSuggestion(); renderAiNote();
  }
  renderList();
}
