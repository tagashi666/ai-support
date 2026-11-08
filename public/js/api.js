// Панель: запросы к API, билет и загрузка медиа.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './dom.js';
import { state } from './state.js';
import { toast } from './nav.js';

export const api = async (path, options = {}) => {
  // content-type объявляем только когда тело есть: заголовок без тела
  // Fastify считает ошибкой и отбивает запрос до обработчика.
  const headers = { authorization: `Bearer ${state.token}`, ...options.headers };
  if (options.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) { localStorage.removeItem('panelToken'); location.reload(); }
  return res;
};
export const json = async (path, options) => { const r = await api(path, options); return r.ok ? r.json() : null; };

/**
 * Изменение состояния. Ошибку сервера показываем всегда: раньше отказ
 * возвращался как null, и кнопка выглядела нерабочей — так пропала
 * публикация черновиков, падавшая с нехваткой прав.
 */
export async function mutate(path, options, okText) {
  let res;
  try { res = await api(path, options); }
  catch (err) { toast(`Нет связи с сервером: ${err.message}`); return null; }
  if (res.ok) { if (okText) toast(okText); return await res.json().catch(() => ({})); }
  const body = await res.json().catch(() => ({}));
  toast(body.error ?? `Ошибка ${res.status}`);
  return null;
}

// Билет для WebSocket: сам токен панели в адресную строку не попадает —
// оттуда он утекает в историю браузера и в логи nginx. Вместе с билетом
// сервер ставит HttpOnly-cookie: её браузер прикладывает к картинкам,
// видео и аватаркам, поэтому их URL не меняются и живут в кэше браузера.
export let ticket = '';
let ticketPromise = null;
export let ticketAt = 0;
export async function refreshTicket() {
  if (ticketPromise) return ticketPromise;
  ticketPromise = (async () => {
    const data = await json('/api/ticket');
    if (data?.ticket) {
      ticket = data.ticket; ticketAt = Date.now();
      refreshMediaTicketUrls();
    }
    return ticket;
  })();
  try { return await ticketPromise; }
  finally { ticketPromise = null; }
}

export const attachmentUrl = (id, suffix = '') => `/api/attachments/${id}${suffix}`;

/** Повторяет загрузку медиа, которое не смогло загрузиться до обновления билета. */
function refreshMediaTicketUrls() {
  for (const node of document.querySelectorAll('[data-attachment-id]')) {
    if (node instanceof HTMLImageElement && node.complete && !node.naturalWidth && node.dataset.mediaFailed) {
      delete node.dataset.mediaFailed;
      reloadMedia(node);
    } else if (node instanceof HTMLVideoElement && node.error) reloadMedia(node);
  }
}

/** Тот же URL заново: 202/401 сервер отдаёт с no-store, кэш их не держит. */
export function reloadMedia(node) {
  const url = node.getAttribute('src');
  if (!url) return;
  node.removeAttribute('src');
  node.src = url;
  if (node instanceof HTMLVideoElement) node.load();
}

/**
 * Почему медиа не загрузилось. <img> статус не видит, поэтому спрашиваем
 * HEAD: 202 — файл ещё качается (ждём Retry-After), 401 — истёк билет,
 * остальные 4xx — ждать нечего. Возвращает паузу до повтора или null.
 */
export async function mediaRetryDelay(url, attempt) {
  if (attempt > 15) return null;
  let status = 0, retryAfter = 0;
  try {
    const response = await fetch(url, { method:'HEAD', cache:'no-store' });
    status = response.status;
    retryAfter = Number(response.headers.get('retry-after')) || 0;
  } catch { /* сеть — повторим с паузой */ }
  if (status === 202) return Math.min(60, Math.max(1, retryAfter || 1)) * 1000;
  if (status === 401) { await refreshTicket(); return attempt > 3 ? null : 300; }
  if (status >= 400 && status < 500) return null;
  if (status >= 200 && status < 300) return attempt > 2 ? null : 1500;
  return Math.min(1500 * attempt, 15_000);
}

/**
 * Окончательная ошибка вложения: причина с сервера, «Повторить» и ссылка на
 * скачивание. Файл с форматом, который браузер не рисует (HEIC и т.п.), сервер
 * отдаёт как скачивание — тогда показываем карточку файла, а не ошибку.
 */
export async function showMediaFailure(box, url, reload) {
  box.classList.remove('media-pending');
  let status = 0, reason = '';
  try {
    const response = await fetch(url, { method:'HEAD', cache:'no-store' });
    status = response.status;
    reason = decodeURIComponent(response.headers.get('x-attachment-error') ?? '');
  } catch { /* сеть */ }
  if (!box.isConnected) return;
  const card = document.createElement('div');
  card.className = 'media-failed';
  const text = document.createElement('span');
  text.textContent = status >= 200 && status < 300 ? 'Формат не отображается в браузере' : (reason || 'Файл не удалось загрузить');
  card.append(text);
  if (status >= 200 && status < 300) {
    const link = Object.assign(document.createElement('a'), { href:url, target:'_blank', rel:'noopener', textContent:'Скачать' });
    card.append(link);
  } else {
    const retry = Object.assign(document.createElement('button'), { type:'button', className:'ghost', textContent:'Повторить' });
    retry.onclick = async () => {
      retry.disabled = true;
      const id = url.match(/\/api\/attachments\/(\d+)/)?.[1];
      if (id && status === 424) await api(`/api/attachments/${id}/retry`, { method:'POST' }).catch(() => undefined);
      if (card.isConnected) { card.replaceWith(box); reload(); }
    };
    card.append(retry);
  }
  box.replaceWith(card);
}

/** Картинка вложения: скелетон, пока файл качается, и повторы по статусу. */
export function loadAttachmentImage(img, box, url) {
  let attempts = 0;
  box.classList.add('media-pending');
  img.onload = () => { img.classList.add('ready'); box.classList.remove('media-pending'); };
  img.onerror = async () => {
    if (!box.isConnected) return;
    const wait = await mediaRetryDelay(url, ++attempts);
    if (!box.isConnected) return;
    if (wait === null) { void showMediaFailure(box, url, () => { loadAttachmentImage(img, box, url); reloadMedia(img); }); return; }
    img.dataset.mediaFailed = '1';
    setTimeout(() => { if (box.isConnected) { delete img.dataset.mediaFailed; reloadMedia(img); } }, wait);
  };
  img.src = url;
}
