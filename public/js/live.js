// Панель: живое обновление.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './settings.js';
import { state } from './state.js';
import { $ } from './dom.js';
import { ticket, ticketAt, refreshTicket } from './api.js';
import { toast } from './nav.js';
import { renderWindow } from './inbox-list.js';
import { messageSignature, bubble, renderSuggestion, clearQuote } from './thread.js';
import { renderAiNote } from './inspector.js';
import {
  refreshSoon, markOpenConversationRead, syncCurrentMessages, refresh, mergeLiveConversation,
  removeLiveConversation,
} from './conversation.js';
import { loadDocs } from './kb.js';
import { suggestionAfterFrame } from './rules.js';

/* ═══ живое обновление ═══ */
// Сервер закрывает сокет, когда истекает его билет. Поэтому при каждом
// обновлении билета заранее открываем новый сокет и только после его
// открытия закрываем старый: окна без событий нет. Пока сокет не OPEN,
// работает HTTP-опрос; после восстановления связи — одна полная сверка.
let liveSocket = null, pendingSocket = null, liveRetryTimer = null, liveFailures = 0, liveNeedsResync = false;
export const liveOpen = () => liveSocket?.readyState === WebSocket.OPEN;

export function connect() {
  clearTimeout(liveRetryTimer); liveRetryTimer = null;
  if (pendingSocket) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(ticket)}`);
  pendingSocket = ws;
  let opened = false;
  ws.onopen = () => {
    opened = true;
    if (pendingSocket === ws) pendingSocket = null;
    const previous = liveSocket;
    liveSocket = ws; liveFailures = 0; liveFrameAt = Date.now();
    if (previous && previous !== ws) { previous.onclose = null; previous.close(1000, 'Ticket rotated'); }
    $('pulse').classList.add('live'); $('pulse').title = 'Связь с сервером установлена';
    if (liveNeedsResync) { liveNeedsResync = false; void refresh({ fullThread:true }); }
  };
  ws.onclose = (event) => {
    if (pendingSocket === ws) pendingSocket = null;
    // Не открывшаяся замена при живом старом сокете: пробуем ещё раз позже.
    if (liveSocket && liveSocket !== ws) {
      if (!opened) liveRetryTimer = setTimeout(connect, 5000);
      return;
    }
    liveSocket = null;
    if (opened) liveNeedsResync = true;
    $('pulse').classList.remove('live'); $('pulse').title = 'Переподключаемся…';
    scheduleReconnect(event.code);
  };
  ws.onmessage = (event) => { if (liveSocket === ws) liveFrameAt = Date.now(); handleLiveFrame(event); };
}

/**
 * Сокет может умереть без события close (сон ноутбука, смена сети, вкладка
 * iOS в фоне): liveOpen() остаётся true, запасной опрос не включается, и
 * новые сообщения не приходят, хотя уведомление в Telegram уже есть. Сервер
 * шлёт tick раз в 20 с — нет кадров дольше 50 с, значит сокет мёртв.
 */
let liveFrameAt = Date.now(), hiddenAt = 0;
function dropDeadSocket() {
  const dead = liveSocket;
  if (!dead) return;
  dead.onclose = null; dead.onmessage = null;
  try { dead.close(); } catch { /* уже закрыт */ }
  liveSocket = null; liveNeedsResync = true;
  $('pulse').classList.remove('live'); $('pulse').title = 'Переподключаемся…';
  scheduleReconnect(1006);
}
setInterval(() => {
  if (liveOpen() && Date.now() - liveFrameAt > 50_000) dropDeadSocket();
}, 10_000);

/** Возврат во вкладку или в сеть: проверить сокет, билет и догрузить пропущенное. */
async function resumeLive() {
  if (document.visibilityState !== 'visible' || !state.currentActor) return;
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  // Билет живёт 10 минут; таймеры фоновой вкладки браузер замораживает.
  if (Date.now() - ticketAt > 6 * 60_000) await refreshTicket().catch(() => undefined);
  if (liveOpen() && Date.now() - liveFrameAt > 30_000) dropDeadSocket();
  else if (!liveOpen() && !pendingSocket) connect();
  if (away > 5_000 || !liveOpen()) void refresh({ fullThread:true });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now(); else void resumeLive();
});
window.addEventListener('pageshow', (event) => { if (event.persisted) void resumeLive(); });
window.addEventListener('online', () => void resumeLive());

function scheduleReconnect(code) {
  clearTimeout(liveRetryTimer);
  const delay = liveFailures ? Math.min(15_000, 1000 * 2 ** (liveFailures - 1)) : 200;
  liveFailures += 1;
  liveRetryTimer = setTimeout(async () => {
    // 1008 — билет истёк или сервер перезапущен с новым секретом.
    if (code === 1008 || liveFailures > 1) await refreshTicket().catch(() => undefined);
    connect();
  }, delay);
}

/** Плановое обновление билета: сначала новый сокет, затем закрытие старого. */
export async function rotateTicket() {
  await refreshTicket();
  if (liveOpen()) connect();
}

function handleLiveFrame(event) {
  const frame = JSON.parse(event.data);
  if (frame.type === 'tick') return;
  if (frame.type === 'job') {
    const box = $('logBox');
    if (box) {
      if (frame.status === 'running') box.textContent += `\n${frame.progress}`;
      if (frame.status === 'done') { box.textContent += `\nГотово: ${frame.report.articles.length} статей`; loadDocs(); toast('Сбор закончен'); }
      if (frame.status === 'failed') { box.textContent += `\nОшибка: ${frame.error}`; toast('Сбор не удался'); }
      box.scrollTop = box.scrollHeight;
    }
    return;
  }
  if (frame.type === 'conversation_deleted') {
    removeLiveConversation(frame.conversation.id);
    return;
  }
  // Последнее сообщение уже удалено: не сливаем пустую карточку обратно
  // в список даже на один кадр, пока следом идёт conversation_deleted.
  if (frame.type === 'message_deleted' && frame.conversation.last_message_at == null) {
    removeLiveConversation(frame.conversation.id);
    return;
  }
  if (frame.conversation) mergeLiveConversation(frame.conversation);
  // Предложка открытого диалога живёт по тем же кадрам: новый вопрос клиента,
  // ответ человека (в том числе из Telegram мимо панели), отправка этого
  // черновика AI, решение в другой вкладке, закрытие диалога.
  if (frame.conversation && state.current?.id === frame.conversation.id) {
    const next = suggestionAfterFrame(state.suggestion, frame);
    if (next !== state.suggestion) { state.suggestion = next; renderSuggestion(); }
  }
  if (frame.type === 'message' && state.current?.id === frame.conversation.id) {
    const nearBottom = $('thread').scrollHeight - $('thread').scrollTop - $('thread').clientHeight < 140;
    state.current = frame.conversation;
    const inner = $('thread').dataset.conversationId === String(frame.conversation.id)
      ? $('thread').querySelector('.thread-inner') : null;
    if (inner) {
      if (inner.querySelector('.empty')) inner.innerHTML = '';
      if (!inner.querySelector(`.msg[data-message-id="${frame.message.id}"]`)) {
        const el = bubble(frame.message, frame.attachments ?? {});
        el.classList.add('fresh');
        inner.append(el);
      }
    } else {
      void syncCurrentMessages(frame.conversation.id);
    }
    if (nearBottom || frame.message.direction === 'out') requestAnimationFrame(() => { $('thread').scrollTop = $('thread').scrollHeight; });
    else toast('Новое сообщение ниже по переписке');
    if (frame.message.direction === 'in') markOpenConversationRead(frame.conversation.id);
    renderWindow(); renderAiNote();
  }
  if (frame.type === 'message_updated' && state.current?.id === frame.conversation.id) {
    const inner = $('thread').dataset.conversationId === String(frame.conversation.id)
      ? $('thread').querySelector('.thread-inner') : null;
    const existing = inner?.querySelector(`.msg[data-message-id="${frame.message.id}"]`);
    if (existing) {
      // Подпись та же — пузырь не трогаем, иначе картинки перерисуются.
      if (existing.dataset.messageSignature !== messageSignature(frame.message, frame.attachments?.[frame.message.id] ?? [])) {
        existing.replaceWith(bubble(frame.message, frame.attachments ?? {}));
      }
    } else void syncCurrentMessages(frame.conversation.id, { full:true });
  }
  if (frame.type === 'message_deleted' && state.current?.id === frame.conversation.id) {
    const inner = $('thread').dataset.conversationId === String(frame.conversation.id)
      ? $('thread').querySelector('.thread-inner') : null;
    inner?.querySelector(`.msg[data-message-id="${frame.message.id}"]`)?.remove();
    // Ответ цитатой на удалённое сообщение Telegram не доставит.
    if (state.quoting?.id && state.quoting.id === frame.message.external_msg_id) clearQuote();
    if (inner && !inner.querySelector('.msg[data-message-id]')) {
      inner.innerHTML = '<p class="empty">Сообщений пока нет.</p>';
    }
  }
  // Кадр с карточкой уже применён локально: перезапрашивать весь список
  // незачем. Сверка нужна только для кадров без данных.
  if (!frame.conversation) refreshSoon();
}
