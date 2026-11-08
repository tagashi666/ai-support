// Панель: инбокс: пузыри сообщений, медиа, цитаты, подсказка.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './inbox-list.js';
import { state } from './state.js';
import { $, esc } from './dom.js';
import {
  mutate, refreshTicket, attachmentUrl, reloadMedia, mediaRetryDelay, showMediaFailure, loadAttachmentImage,
} from './api.js';
import { canPermission, canWrite } from './access.js';
import { toast } from './nav.js';
import { fmtTime } from './inbox-list.js';
import { sendText, formatBytes, openImageEditorFromUrl } from './composer.js';

/** Цитата: на что отвечает это сообщение. Без неё «Да» повисает в воздухе. */
function quoteBlock(m) {
  if (!m.reply_excerpt && !m.reply_to_external_id) return null;
  const el = document.createElement('div');
  el.className = 'reply-to';
  el.innerHTML = `<span>${esc(m.reply_excerpt ?? 'сообщение выше')}</span>`;
  if (m.reply_to_external_id) el.onclick = () => jumpTo(m.reply_to_external_id);
  return el;
}

export const messageSignature = (m, files = []) => JSON.stringify([
  m.text, m.media_type, m.reply_to_external_id, m.reply_excerpt,
  files.map((file) => [file.id, file.media_type, file.mime_type, file.bytes]),
]);

let lottiePlayerPromise = null;
const tgsAnimations = new WeakMap();
new MutationObserver((records) => {
  for (const record of records) for (const removed of record.removedNodes) {
    if (!(removed instanceof Element)) continue;
    const boxes = removed.matches('.tgs-sticker') ? [removed] : [...removed.querySelectorAll('.tgs-sticker')];
    for (const box of boxes) {
      tgsAnimations.get(box)?.destroy();
      tgsAnimations.delete(box);
    }
  }
}).observe(document.body, { childList:true, subtree:true });

function loadLottiePlayer() {
  if (window.lottie) return Promise.resolve(window.lottie);
  if (lottiePlayerPromise) return lottiePlayerPromise;
  lottiePlayerPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/lottie.min.js'; script.async = true;
    script.onload = () => window.lottie ? resolve(window.lottie) : reject(new Error('Lottie не загрузился'));
    script.onerror = () => reject(new Error('Не удалось загрузить Lottie'));
    document.head.append(script);
  }).catch((error) => { lottiePlayerPromise = null; throw error; });
  return lottiePlayerPromise;
}

async function renderTgsSticker(box, attachmentId) {
  try {
    let animationData = null;
    for (let attempt = 0; attempt < 12 && box.isConnected; attempt += 1) {
      const response = await fetch(attachmentUrl(attachmentId, '/lottie'));
      if (response.status === 200) { animationData = await response.json(); break; }
      if (response.status === 401) await refreshTicket();
      if (![202, 401].includes(response.status)) throw new Error(`TGS: HTTP ${response.status}`);
      const retryAfter = Number(response.headers.get('retry-after')) || 0;
      await new Promise((resolve) => setTimeout(resolve, retryAfter
        ? Math.min(60_000, retryAfter * 1000) : Math.min(5_000, 750 * (attempt + 1))));
    }
    if (!animationData || !box.isConnected) throw new Error('TGS пока недоступен');
    const player = await loadLottiePlayer();
    if (!box.isConnected) return;
    box.textContent = '';
    const animation = player.loadAnimation({
      container: box, renderer:'svg', loop:true, autoplay:true, animationData,
      rendererSettings:{ progressiveLoad:true, preserveAspectRatio:'xMidYMid meet' },
    });
    tgsAnimations.set(box, animation);
    box.classList.add('ready');
  } catch {
    if (box.isConnected) box.textContent = '[анимацию не удалось загрузить]';
  }
}

export function bubble(m, attachments = {}) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${m.direction === 'in' ? 'in' : m.direction === 'note' ? 'note' : 'out'}`;
  wrap.dataset.messageId = String(m.id);
  if (m.external_msg_id) wrap.dataset.mid = m.external_msg_id;

  const quote = quoteBlock(m);
  if (quote) wrap.append(quote);

  const el = document.createElement('div');
  el.className = 'bubble';
  if (m.text) el.append(document.createTextNode(m.text));

  const files = attachments[m.id] ?? [];
  wrap.dataset.messageSignature = messageSignature(m, files);
  for (const a of files) {
    const mediaUrl = attachmentUrl(a.id);
    if (a.media_type === 'photo' || a.media_type === 'sticker' || (a.media_type === 'animation' && a.mime_type === 'image/gif')) {
      // Пропорции знаем заранее — под картинку сразу отводится ровно
      // столько места, сколько она займёт. Ничего не сдвинется при загрузке.
      const box = document.createElement('div');
      box.className = 'shot';
      const ratio = a.width && a.height ? a.width / a.height : 4 / 3;
      const width = Math.min(240, Math.round(280 * ratio));
      box.style.width = `${width}px`;
      box.style.aspectRatio = String(ratio);

      const img = document.createElement('img');
      img.dataset.attachmentId = String(a.id);
      img.alt = 'вложение'; img.loading = 'lazy'; img.decoding = 'async';
      loadAttachmentImage(img, box, mediaUrl);
      box.onclick = () => openImage(img.src);
      box.append(img);
      if (canPermission('conversation:attachments')) {
        const actions = document.createElement('span'); actions.className = 'shot-actions';
        const edit = document.createElement('button'); edit.className = 'shot-edit'; edit.type = 'button';
        edit.textContent = 'Править'; edit.title = 'Создать отредактированную копию';
        edit.onclick = (event) => { event.stopPropagation(); openImageEditorFromUrl(attachmentUrl(a.id), a.original_name || 'image.png'); };
        actions.append(edit); box.append(actions);
      }
      el.append(box);
    } else if (a.media_type === 'tgs_sticker') {
      const box = document.createElement('div');
      box.className = 'tgs-sticker';
      box.textContent = '[анимация загружается]';
      box.style.aspectRatio = String(a.width && a.height ? a.width / a.height : 1);
      el.append(box);
      void renderTgsSticker(box, a.id);
    } else if (a.media_type === 'video' || a.media_type === 'video_note' || a.media_type === 'animation' || a.media_type === 'video_sticker') {
      const video = document.createElement('video'); video.className = 'media-video'; video.controls = true;
      video.dataset.attachmentId = String(a.id);
      if (a.media_type === 'animation' || a.media_type === 'video_sticker') {
        video.autoplay = true; video.loop = true; video.muted = true; video.playsInline = true;
        if (a.media_type === 'video_sticker') video.controls = false;
      }
      let videoAttempts = 0;
      video.classList.add('media-pending');
      video.addEventListener('loadedmetadata', () => video.classList.remove('media-pending'));
      video.addEventListener('error', async () => {
        if (!video.isConnected) return;
        const wait = await mediaRetryDelay(mediaUrl, ++videoAttempts);
        if (wait === null) {
          videoAttempts = 0;
          void showMediaFailure(video, mediaUrl, () => reloadMedia(video));
          return;
        }
        setTimeout(() => { if (video.isConnected) reloadMedia(video); }, wait);
      });
      video.preload = 'metadata'; video.src = mediaUrl; el.append(video);
    } else {
      const link = document.createElement('a');
      link.className = 'file-card'; link.target = '_blank'; link.rel = 'noopener'; link.href = mediaUrl;
      link.dataset.attachmentId = String(a.id);
      const label = document.createElement('span'); label.textContent = a.original_name || `[${a.media_type ?? 'файл'}]`;
      const size = document.createElement('small'); size.textContent = a.bytes ? formatBytes(a.bytes) : 'скачать';
      link.append('⇩', label, size);
      el.append(document.createElement('br'), link);
    }
  }
  // Запасная отрисовка: вложение могло ещё не скачаться или прийти без
  // текста. Пустой пузырь выглядит как потерянное сообщение.
  if (!m.text && !files.length) {
    el.append(Object.assign(document.createElement('div'), {
      className: 'mono',
      textContent: m.media_type ? `[${m.media_type} — загружается]` : '[сообщение без текста]',
    }));
  }
  wrap.append(el);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.append(document.createTextNode(`${m.author} · ${fmtTime(m.created_at)}`));

  // Ответить можно только на сообщение клиента из лички: тикеты бедолаги
  // цитирование не поддерживают.
  if (canWrite() && m.direction === 'in' && m.external_msg_id && state.current?.channel?.startsWith('tg_')) {
    const act = document.createElement('button');
    act.className = 'act';
    act.textContent = '↩ ответить';
    act.onclick = () => setQuote(m);
    meta.append(act);
  }
  wrap.append(meta);
  return wrap;
}

/** Полный размер вложения: в переписке показываем только превью. */
function openImage(src) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', 'Просмотр вложения');
  const full = document.createElement('img');
  full.src = src;
  full.onclick = (event) => event.stopPropagation();
  const closeButton = document.createElement('button');
  closeButton.className = 'lightbox-close';
  closeButton.type = 'button';
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', 'Закрыть изображение');
  let onKey;
  const close = () => {
    document.removeEventListener('keydown', onKey);
    box.remove();
  };
  closeButton.onclick = (event) => { event.stopPropagation(); close(); };
  box.append(full, closeButton);
  box.onclick = close;
  onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  document.body.append(box);
  closeButton.focus();
}

/** Переход к процитированному сообщению, если оно есть в открытом треде. */
function jumpTo(externalId) {
  const target = document.querySelector(`.msg[data-mid="${CSS.escape(String(externalId))}"]`);
  if (!target) return toast('Исходное сообщение выше по переписке');
  target.scrollIntoView({ behavior:'smooth', block:'center' });
  target.classList.remove('flash');
  void target.offsetWidth;
  target.classList.add('flash');
}

function setQuote(m) {
  if (!canWrite()) return;
  state.quoting = { id: m.external_msg_id, excerpt: (m.text ?? `[${m.media_type ?? 'вложение'}]`).slice(0, 160) };
  renderQuoting();
  $('input').focus();
}
export function clearQuote() { state.quoting = null; renderQuoting(); }
export function renderQuoting() {
  const box = $('quotingBox');
  if (!box) return;
  if (!state.quoting) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="quoting"><span>В ответ: ${esc(state.quoting.excerpt)}</span>
    <button class="btn quiet" id="dropQuote" style="margin-left:auto">Отменить</button></div>`;
  $('dropQuote').onclick = clearQuote;
}

export function renderSuggestion() {
  const box = $('suggestBox');
  if (!state.suggestion) { box.innerHTML = ''; return; }
  const pct = state.suggestion.confidence == null ? 0 : Math.round(state.suggestion.confidence * 100);
  let sources = []; try { sources = state.suggestion.sources ? JSON.parse(state.suggestion.sources) : []; } catch {}
  // Пустой текст — модель просит человека и клиенту ничего не предлагает:
  // отправлять нечего, остаётся подсказка оператору.
  const hasText = !!state.suggestion.text?.trim();
  box.innerHTML = `<div class="suggest">
    <div class="head"><b>AI-помощник</b><span>уверенность ${pct}%${state.suggestion.needs_human ? ' · нужен человек' : ''}</span></div>
    ${hasText ? `<div class="text">${esc(state.suggestion.text)}</div>` : '<div class="src">Текста для клиента нет.</div>'}
    ${state.suggestion.operator_note ? `<div class="src">Оператору: ${esc(state.suggestion.operator_note)}</div>` : ''}
    ${state.suggestion.reason ? `<div class="src">Модель: ${esc(state.suggestion.reason)}</div>` : ''}
    ${sources.length ? `<div class="src">Источники: ${esc(sources.join(' · '))}</div>` : ''}
    ${canWrite() ? `<div class="acts">${hasText ? `<button class="btn primary" id="sgSend">Отправить</button>
      <button class="btn" id="sgEdit">Править</button>` : ''}<button class="btn danger" id="sgNo">Отклонить</button></div>` : '<div class="hint">Предложка доступна только для просмотра.</div>'}
    <div class="gauge"><i style="width:${pct}%"></i></div></div>`;
  if (!canWrite()) return;
  if (hasText) {
    $('sgSend').onclick = () => sendText(state.suggestion.text, { suggestionId: state.suggestion.id, edited: false });
    $('sgEdit').onclick = () => { $('input').value = state.suggestion.text; $('input').focus(); };
  }
  $('sgNo').onclick = async () => {
    const id = state.suggestion.id;
    await mutate(`/api/suggestions/${id}/decide`,
      { method:'POST', body: JSON.stringify({ status:'rejected' }) }, 'Предложка отклонена');
    // Пока шёл запрос, мог открыться другой диалог со своей предложкой.
    if (state.suggestion?.id === id) { state.suggestion = null; renderSuggestion(); }
  };
}
