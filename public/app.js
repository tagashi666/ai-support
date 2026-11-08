const WINDOW_MS = 864e5, SOON_MS = 108e5;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

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

let token = localStorage.getItem('panelToken') || '';

const api = async (path, options = {}) => {
  // content-type объявляем только когда тело есть: заголовок без тела
  // Fastify считает ошибкой и отбивает запрос до обработчика.
  const headers = { authorization: `Bearer ${token}`, ...options.headers };
  if (options.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) { localStorage.removeItem('panelToken'); location.reload(); }
  return res;
};
const json = async (path, options) => { const r = await api(path, options); return r.ok ? r.json() : null; };

/**
 * Изменение состояния. Ошибку сервера показываем всегда: раньше отказ
 * возвращался как null, и кнопка выглядела нерабочей — так пропала
 * публикация черновиков, падавшая с нехваткой прав.
 */
async function mutate(path, options, okText) {
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
let ticket = '';
let ticketPromise = null;
let ticketAt = 0;
async function refreshTicket() {
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

const attachmentUrl = (id, suffix = '') => `/api/attachments/${id}${suffix}`;

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
function reloadMedia(node) {
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
async function mediaRetryDelay(url, attempt) {
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
async function showMediaFailure(box, url, reload) {
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
function loadAttachmentImage(img, box, url) {
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

let conversations = [], current = null, suggestion = null, filter = 'all', listQuery = '', templates = [], settings = null;
let inboxSources = [], inboxFolders = [];
let kbTab = 'kb', docs = { kb: [], drafts: [], interfaceScreens: [], candidates: [] }, quoting = null, currentActor = null;
let pendingFiles = [], uploadRunning = false;
const canPermission = (permission) => Boolean(currentActor?.root || currentActor?.permissions?.includes(permission));
const canWrite = () => canPermission('conversation:reply');
const canCompose = () => ['conversation:reply','conversation:attachments','conversation:notes'].some(canPermission);
const canReview = () => canPermission('knowledge:review');

function applyRoleUi() {
  const reviewer = canReview();
  $('templates').disabled = !canPermission('templates:read');
  $('noteBtn').disabled = !canPermission('conversation:notes');
  $('attachBtn').disabled = !canPermission('conversation:attachments');
  $('captureBtn').disabled = !canPermission('conversation:attachments');
  $('statusSel').disabled = !canPermission('conversation:status');
  $('aiSel').disabled = !canPermission('conversation:status');
  $('escBtn').disabled = !canPermission('conversation:status');
  $('closeAllTickets').hidden = !canPermission('conversation:status');
  $('newDoc').hidden = !canPermission('knowledge:manage');
  $('mineBtn').hidden = !canPermission('knowledge:mine');
  $('manageFolders').hidden = !canPermission('settings:sources');
  $('slaPoliciesBtn').hidden = !canPermission('queue:manage');
  const learningTab = $('kbTabs').querySelector('[data-tab="learning"]');
  if (learningTab) learningTab.hidden = !reviewer;
  if (!reviewer && kbTab === 'learning') kbTab = 'kb';
  const viewPermissions = {
    inbox:'conversation:read', queue:'queue:read', kb:'knowledge:read', lab:'settings:ai_tools',
    nodes:'settings:nodes', stats:'stats:read', diagnostics:'diagnostics:read', settings:'settings:read',
  };
  for (const [view, permission] of Object.entries(viewPermissions)) {
    const button = document.querySelector(`.nav[data-view="${view}"]`);
    if (button) button.hidden = !canPermission(permission);
  }
  const teamVisible = ['team:read','operator_stats:read','roles:manage','audit:read'].some(canPermission);
  const teamButton = document.querySelector('.nav[data-view="team"]');
  if (teamButton) teamButton.hidden = !teamVisible;
  $('globalSearch').hidden = !canPermission('conversation:read');
  const activeNav = document.querySelector('.nav[data-view][aria-current="true"]');
  if (activeNav?.hidden) {
    const firstAllowed = document.querySelector('.nav[data-view]:not([hidden])');
    if (firstAllowed) show(firstAllowed.dataset.view);
  }
}

/* ═══ оформление ═══ */
const THEMES = [
  ['system','Автоматически','Как в системе'],
  ['light','Светлая','Для яркого окружения'],
  ['dark','Тёмная','Для слабого освещения'],
];
const ACCENTS = [['system-blue','#0A84FF','Системный синий']];

$('themePick').innerHTML = THEMES.map(([id, name, description]) =>
  `<button type="button" class="theme-card" data-theme="${id}" title="${name}" aria-label="Тема: ${name} — ${description}">
     <span class="theme-preview" aria-hidden="true"><i class="preview-rail"></i><span class="preview-list"><i></i><i></i><i></i></span><span class="preview-chat"><i></i><i></i></span></span>
     <span class="theme-meta"><span><b>${name}</b><small>${description}</small></span><i class="theme-check">✓</i></span>
   </button>`).join('');
$('accentPick').innerHTML = ACCENTS.map(([n,hex,label]) =>
  `<button type="button" class="swatch" data-accent="${n}" style="--swatch:${hex}" title="${label}" aria-label="Акцент: ${label}"><i></i><span>${label}</span></button>`).join('');

function applyLook() {
  const savedTheme = localStorage.getItem('theme');
  const theme = THEMES.some(([id]) => id === savedTheme) ? savedTheme : 'system';
  const accent = 'system-blue';
  localStorage.setItem('accent', accent);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.accent = accent;
  for (const b of $('themePick').children) b.setAttribute('aria-pressed', String(b.dataset.theme === theme));
  for (const b of $('accentPick').children) b.setAttribute('aria-pressed', String(b.dataset.accent === accent));
}
$('themePick').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const change = () => { localStorage.setItem('theme', b.dataset.theme); applyLook(); };
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.documentElement.classList.add('theme-transition');
    const transition = document.startViewTransition(change);
    void transition.finished.finally(() => document.documentElement.classList.remove('theme-transition'));
  } else change();
};
$('accentPick').onclick = () => {};
applyLook();

// Навигация настроек следует за реальной позицией прокрутки, как в
// desktop settings: выбранная категория всегда соответствует содержимому.
const settingsScroller = document.querySelector('.settings-content-scroll');
const settingsLinks = [...document.querySelectorAll('.settings-nav a')];
let requestedSettingsSection = 'settings-appearance';
const setSettingsCategory = (id) => {
  requestedSettingsSection = id;
  for (const link of settingsLinks) link.setAttribute('aria-current', String(link.hash === `#${id}`));
};
const scrollToSettingsCategory = (id, smooth = true) => {
  const section = document.getElementById(id);
  if (!section) return;
  const scrollerTop = settingsScroller.getBoundingClientRect().top;
  const sectionTop = section.getBoundingClientRect().top;
  const top = Math.max(0, settingsScroller.scrollTop + sectionTop - scrollerTop - 4);
  settingsScroller.scrollTo({ top, behavior:smooth ? 'smooth' : 'auto' });
  setSettingsCategory(id);
};
let settingsScrollFrame = 0;
const syncSettingsCategory = () => {
  settingsScrollFrame = 0;
  const scrollerTop = settingsScroller.getBoundingClientRect().top;
  let active = settingsLinks[0]?.hash.slice(1) ?? requestedSettingsSection;
  if (settingsScroller.scrollTop + settingsScroller.clientHeight >= settingsScroller.scrollHeight - 4) {
    active = settingsLinks.at(-1)?.hash.slice(1) ?? active;
  } else {
    for (const link of settingsLinks) {
      const section = document.querySelector(link.hash);
      if (section && section.getBoundingClientRect().top - scrollerTop <= 72) active = section.id;
    }
  }
  if (active) setSettingsCategory(active);
};
for (const link of settingsLinks) link.onclick = (event) => {
  event.preventDefault();
  const id = link.hash.slice(1);
  history.replaceState(null, '', link.hash);
  scrollToSettingsCategory(id);
};
settingsScroller.addEventListener('scroll', () => {
  if (!settingsScrollFrame) settingsScrollFrame = requestAnimationFrame(syncSettingsCategory);
}, { passive:true });
setSettingsCategory('settings-appearance');

/* ═══ вход ═══
   Раньше здесь стоял prompt() — он не показывает ошибку, не даёт
   стереть неверный токен и выглядит как сбой браузера. */
async function checkToken(candidate) {
  return fetch('/api/settings', { headers: { authorization: `Bearer ${candidate}` } });
}
function openGate(message) {
  $('app').hidden = true;
  $('gate').hidden = false;
  $('gateErr').textContent = message ?? '';
  $('gateToken').focus();
}
$('gateForm').onsubmit = async (e) => {
  e.preventDefault();
  const candidate = $('gateToken').value.trim();
  if (!candidate) return;
  $('gateGo').disabled = true;
  $('gateErr').textContent = '';
  try {
    const res = await checkToken(candidate);
    if (res.ok) {
      token = candidate;
      localStorage.setItem('panelToken', candidate);
      $('gate').hidden = true;
      $('app').hidden = false;
      await boot();
    } else if (res.status === 429) {
      // Не «неверный токен», а временная блокировка за частые попытки: иначе
      // человек с верным токеном решает, что тот перестал работать.
      const wait = Number(res.headers.get('retry-after')) || 60;
      $('gateErr').textContent = `Слишком много попыток. Подождите ${wait} с и попробуйте снова.`;
    } else {
      $('gateErr').textContent = 'Токен не подошёл';
      $('gateToken').select();
    }
  } catch (err) {
    $('gateErr').textContent = `Сервер недоступен: ${err.message}`;
  }
  $('gateGo').disabled = false;
};

/* ═══ размеры колонок ═══
   Ширины двигаются мышью и запоминаются: на разных мониторах удобны
   разные пропорции, а угадать за пользователя нельзя. */
const LAYOUT = [
  { grip:'gripSide', target:() => $('app'), probe:'.sidebar', varName:'--w-side', min:170, max:340, sign:1 },
  { grip:'gripList', target:() => document.querySelector('.split'), probe:'.col.left', varName:'--w-list', min:240, max:620, sign:1 },
  { grip:'gripCtx',  target:() => $('app'), probe:'.context', varName:'--w-ctx', min:240, max:560, sign:-1 },
];
function applyLayout() {
  for (const item of LAYOUT) {
    // Сохранённую ширину зажимаем в те же границы, что и при перетаскивании:
    // значение, запомненное на узком мониторе, не должно применяться дословно
    // на 2К и превращать колонку в неуместно тонкую полосу.
    const saved = Number(localStorage.getItem(`layout:${item.varName}`));
    if (Number.isFinite(saved) && saved > 0) {
      const clamped = Math.min(item.max, Math.max(item.min, saved));
      item.target()?.style.setProperty(item.varName, `${clamped}px`);
    }
  }
}
for (const item of LAYOUT) {
  const grip = $(item.grip);
  if (!grip) continue;
  grip.onpointerdown = (e) => {
    const el = item.target();
    if (!el) return;
    const startX = e.clientX;
    // Значение по умолчанию задано через clamp() и как число не читается,
    // поэтому берём фактическую ширину колонки на экране.
    const probe = document.querySelector(item.probe);
    const startW = probe ? probe.getBoundingClientRect().width : 240;
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('dragging');
    document.body.classList.add('resizing');
    // Перерасчёт grid-раскладки всего приложения на каждый pointermove
    // (а их десятки за кадр) и есть источник рывков при ресайзе. Коалесцируем
    // в одну запись переменной на кадр через requestAnimationFrame.
    let raf = 0;
    let pendingX = startX;
    const move = (ev) => {
      pendingX = ev.clientX;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const next = Math.round(Math.min(item.max, Math.max(item.min, startW + (pendingX - startX) * item.sign)));
        el.style.setProperty(item.varName, `${next}px`);
      });
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      grip.releasePointerCapture(e.pointerId);
      grip.classList.remove('dragging');
      document.body.classList.remove('resizing');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      const finalWidth = document.querySelector(item.probe)?.getBoundingClientRect().width;
      if (finalWidth) localStorage.setItem(`layout:${item.varName}`, String(Math.round(finalWidth)));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  };
  // Двойной щелчок возвращает ширину по умолчанию.
  grip.ondblclick = () => {
    item.target()?.style.removeProperty(item.varName);
    localStorage.removeItem(`layout:${item.varName}`);
  };
}
applyLayout();

/* ═══ навигация ═══ */
const VIEWS = ['inbox','queue','kb','lab','nodes','stats','team','diagnostics','settings'];
const VIEW_LOADERS = Object.freeze({
  kb:loadDocs,
  queue:loadQueue,
  nodes:loadNodes,
  stats:loadStats,
  team:loadTeam,
  diagnostics:loadDiagnostics,
  settings:async () => {
    const resetSettingsPosition = () => {
      settingsScroller.scrollTop = 0;
      setSettingsCategory('settings-appearance');
    };
    resetSettingsPosition();
    await loadSettings().finally(() => requestAnimationFrame(() => {
      resetSettingsPosition();
      requestAnimationFrame(resetSettingsPosition);
    }));
  },
});
let viewNavigationToken = 0;
const viewLoadTasks = new Map();
const supportsViewTransitions = typeof document.startViewTransition === 'function';
document.documentElement.classList.toggle('supports-view-transitions', supportsViewTransitions);

const viewLoaderMarkup = () => `<div class="view-loading" role="status" aria-live="polite" aria-label="Загружаю раздел">
  <span class="view-progress" aria-hidden="true"></span>
  <div class="view-skeleton" aria-hidden="true">
    <div class="view-skeleton-summary"><i></i><i></i><i></i></div>
    <div class="view-skeleton-toolbar"><i></i><i></i></div>
    <div class="view-skeleton-rows">${Array.from({ length:6 }, () => '<i></i>').join('')}</div>
  </div>
</div>`;

function prepareViewLoading(view, token) {
  const section = $(`view-${view}`);
  if (!section || !VIEW_LOADERS[view]) return null;
  clearTimeout(section._settleTimer);
  section.classList.remove('is-settling');
  if (!section.querySelector('.view-loading')) section.insertAdjacentHTML('beforeend', viewLoaderMarkup());
  section.dataset.loadToken = String(token);
  section.setAttribute('aria-busy', 'true');
  section.classList.toggle('is-loading', section.dataset.loaded !== 'true');
  section.classList.toggle('is-refreshing', section.dataset.loaded === 'true');
  return section;
}

function finishViewLoading(section, token) {
  if (!section || section.dataset.loadToken !== String(token)) return;
  const wasInitialLoad = section.classList.contains('is-loading');
  section.dataset.loaded = 'true';
  section.removeAttribute('aria-busy');
  section.classList.remove('is-loading', 'is-refreshing');
  if (wasInitialLoad) {
    section.classList.add('is-settling');
    section._settleTimer = setTimeout(() => section.classList.remove('is-settling'), 180);
  }
}

function runViewLoader(view) {
  const pending = viewLoadTasks.get(view);
  if (pending) return pending;
  const task = Promise.resolve().then(() => VIEW_LOADERS[view]()).finally(() => {
    if (viewLoadTasks.get(view) === task) viewLoadTasks.delete(view);
  });
  viewLoadTasks.set(view, task);
  return task;
}

async function show(view) {
  if (!VIEWS.includes(view)) return;
  const token = ++viewNavigationToken;
  const target = prepareViewLoading(view, token);
  const activate = () => {
    for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
    for (const b of document.querySelectorAll('.nav')) b.setAttribute('aria-current', String(b.dataset.view === view));
    $('app').dataset.context = view === 'inbox' ? 'on' : 'off';
    closeInspector();
  };
  const active = document.querySelector('.view:not([hidden])')?.id;
  let transition = null;
  if (active !== `view-${view}` && supportsViewTransitions && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    transition = document.startViewTransition(activate);
  } else activate();
  if (view === 'lab') {
    const focusLab = () => $('labInput')?.focus({ preventScroll:true });
    if (transition) void transition.updateCallbackDone.then(focusLab, focusLab);
    else focusLab();
  }
  const loader = VIEW_LOADERS[view];
  if (!loader) return;
  const minimumPaint = target?.dataset.loaded === 'true' ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, 180));
  try { await Promise.all([runViewLoader(view), minimumPaint]); }
  catch (error) {
    console.error(`Не удалось загрузить раздел ${view}`, error);
  }
  finally { finishViewLoading(target, token); }
}
for (const b of document.querySelectorAll('.nav[data-view]')) b.onclick = () => void show(b.dataset.view);

/**
 * Телефон: в нижней панели помещаются пять пунктов, остальные разделы — в
 * «Ещё». Пункты меню нажимают исходные кнопки, поэтому права и счётчики
 * остаются как в боковой панели: скрытый по роли раздел не попадает в меню.
 */
const MORE_TARGETS = [
  ['globalSearch', 'Найти'],
  ['.nav[data-view="lab"]', 'AI-студия'],
  ['.nav[data-view="nodes"]', 'Инфраструктура'],
  ['.nav[data-view="team"]', 'Команда'],
  ['.nav[data-view="diagnostics"]', 'Состояние системы'],
  ['.nav[data-view="settings"]', 'Настройки'],
  ['lockBtn', 'Выйти'],
];
function closeMoreSheet() {
  $('moreSheet').hidden = true;
  $('moreNav').setAttribute('aria-expanded', 'false');
}
$('moreNav').onclick = (event) => {
  event.stopPropagation();
  const sheet = $('moreSheet');
  if (!sheet.hidden) { closeMoreSheet(); return; }
  sheet.replaceChildren(...MORE_TARGETS.flatMap(([selector, label]) => {
    const target = selector.startsWith('.') ? document.querySelector(selector) : $(selector);
    if (!target || target.hidden || target.closest('[hidden]')) return [];
    const item = Object.assign(document.createElement('button'), { type:'button', textContent:label });
    item.setAttribute('role', 'menuitem');
    item.onclick = () => { closeMoreSheet(); target.click(); };
    return [item];
  }));
  sheet.hidden = false;
  $('moreNav').setAttribute('aria-expanded', 'true');
  sheet.querySelector('button')?.focus();
};
document.addEventListener('click', (event) => {
  if (!$('moreSheet').hidden && !event.target.closest?.('#moreSheet')) closeMoreSheet();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('moreSheet').hidden) { closeMoreSheet(); $('moreNav').focus(); } });

function animateContentChange(element) {
  if (!element || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  element.classList.remove('content-switch-in');
  void element.offsetWidth;
  element.classList.add('content-switch-in');
  element.addEventListener('animationend', () => element.classList.remove('content-switch-in'), { once:true });
}

function closeInspector() {
  $('app').dataset.inspector = 'closed';
  $('contextToggle').setAttribute('aria-expanded', 'false');
}
$('contextToggle').onclick = () => {
  const open = $('app').dataset.inspector !== 'open';
  $('app').dataset.inspector = open ? 'open' : 'closed';
  $('contextToggle').setAttribute('aria-expanded', String(open));
};
$('contextClose').onclick = closeInspector;
$('app').addEventListener('click', (e) => { if (e.target === $('app')) closeInspector(); });
// На телефоне инспектор накрывает переписку: тап мимо него закрывает панель,
// как у обычного листа. Модальные окна, открытые из инспектора, не считаются.
document.addEventListener('pointerdown', (e) => {
  if ($('app').dataset.inspector !== 'open' || !matchMedia('(max-width:860px)').matches) return;
  if (e.target.closest?.('.context, #contextToggle, #backdrop, .toast, #moreSheet, dialog')) return;
  closeInspector();
});
$('lockBtn').onclick = () => {
  localStorage.removeItem('panelToken');
  location.reload();
};

function toast(text) {
  const el = $('toast'); el.textContent = text; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 2600);
}
let sheetReturn = null;
function sheet(title, body, foot, variant = '') {
  sheetReturn = document.activeElement;
  $('sheet').className = variant ? `sheet ${variant}` : 'sheet';
  $('sheet').innerHTML = `<header><b>${esc(title)}</b><button class="btn quiet sheet-close" id="sheetX">Закрыть</button></header>
    <div class="body">${body}</div><div class="foot">${foot ?? ''}</div>`;
  $('backdrop').hidden = false;
  $('sheetX').onclick = closeSheet;
  requestAnimationFrame(() => $('sheetX').focus());
}
const closeSheet = () => {
  if ($('backdrop').hidden) return;
  $('backdrop').hidden = true;
  $('sheet').className = 'sheet';
  sheetReturn?.focus?.();
  sheetReturn = null;
};
$('backdrop').onclick = (e) => { if (e.target === $('backdrop')) closeSheet(); };

function openGlobalSearch() {
  sheet('Поиск по всей поддержке', `<input class="search-box" id="globalSearchInput" placeholder="Диалог, сообщение, клиент или статья…" autocomplete="off"><div class="search-results" id="globalSearchResults"><span class="hint">Введите хотя бы два символа.</span></div>`);
  const input = $('globalSearchInput');
  let timer = null;
  input.oninput = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { $('globalSearchResults').innerHTML = '<span class="hint">Введите хотя бы два символа.</span>'; return; }
    timer = setTimeout(() => runGlobalSearch(q), 180);
  };
  requestAnimationFrame(() => input.focus());
}

let globalSearchSeq = 0;
async function runGlobalSearch(q) {
  const box = $('globalSearchResults');
  if (!box) return;
  // Медленный ответ на «ab» не должен затирать уже показанные результаты «abc».
  const seq = ++globalSearchSeq;
  box.innerHTML = '<span class="hint">Ищу…</span>';
  const data = await json(`/api/search?q=${encodeURIComponent(q)}`);
  if (seq !== globalSearchSeq || !box.isConnected) return;
  if (!data) { box.innerHTML = '<span class="hint">Поиск не удался. Попробуйте ещё раз.</span>'; return; }
  const rows = [
    ...data.conversations.map((r) => ({ kind:'Диалог', id:r.id, title:r.display_name || r.username || `#${r.id}`, text:`${channelLabel(r)} · ${conversationStatus(r.status)} · ${r.subject || ''}` })),
    ...data.messages.map((r) => ({ kind:'Сообщение', id:r.conversation_id, title:r.author || `Диалог #${r.conversation_id}`, text:r.text })),
    ...data.customers.map((r) => ({ kind:'Клиент', title:r.display_name || r.username || `Клиент #${r.id}`, text:[r.company,r.email,r.phone].filter(Boolean).join(' · ') })),
    ...data.knowledge.map((r) => ({ kind:'База знаний', title:r.title, text:r.excerpt, knowledge:true })),
  ];
  if (!rows.length) { box.innerHTML = '<span class="hint">Совпадений нет.</span>'; return; }
  box.innerHTML = rows.slice(0, 80).map((r, i) => `<article class="search-result" data-search-index="${i}"><span class="badge">${esc(r.kind)}</span><div><b>${esc(r.title)}</b><p>${esc(r.text || '')}</p></div></article>`).join('');
  for (const el of box.querySelectorAll('[data-search-index]')) el.onclick = async () => {
    const row = rows[Number(el.dataset.searchIndex)];
    closeSheet();
    if (row.id) { show('inbox'); await open(Number(row.id)); }
    else if (row.knowledge) show('kb');
  };
}
$('globalSearch').onclick = openGlobalSearch;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSheet(); closeInspector(); clearQuote(); }
  if (e.key === 'Tab' && !$('backdrop').hidden) {
    const focusable = [...$('sheet').querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.offsetParent !== null);
    if (focusable.length) {
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openGlobalSearch(); }
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '')) {
    e.preventDefault();
    show('inbox');
    $('listSearch').focus();
  }
});

/* ═══ свёрнутые разделы ═══
   Что открыто — запоминаем: у каждого оператора свой порядок работы. */
for (const fold of document.querySelectorAll('.fold')) {
  const key = `fold:${fold.dataset.fold}`;
  const saved = localStorage.getItem(key);
  if (saved !== null) fold.open = saved === '1';
  fold.addEventListener('toggle', () => {
    localStorage.setItem(key, fold.open ? '1' : '0');
    // Подписку тянем в тот момент, когда её решили посмотреть.
    if (fold.dataset.fold === 'sub' && fold.open) void renderSubscription();
  });
}

/* ═══ инбокс ═══ */
const fmtLeft = (ms) => { const h = Math.floor(ms/36e5), m = Math.floor(ms%36e5/6e4); return h ? `${h} ч ${m} мин` : `${m} мин`; };
const fmtTime = (ts) => new Date(ts).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
const fmtDate = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? fmtTime(t) : String(v); };
const nameOf = (c) => c.display_name || (c.username ? '@'+c.username : (c.subject || `#${c.external_id}`));
const channelLabel = (c) => c.source?.name || (c.channel === 'tg_dm' ? 'Telegram · Business'
  : c.channel === 'tg_bot' ? 'Telegram · Бот'
  : c.channel === 'minishop' ? 'Тикет MiniShop'
  : 'Тикет Bedolaga');
const CONVERSATION_STATUS = Object.freeze({
  open:'Открыто',
  pending:'Ждёт клиента',
  resolved:'Решено',
});
const conversationStatus = (value) => CONVERSATION_STATUS[value] ?? 'Неизвестный статус';
const gb = (b) => b == null ? '—' : `${(b / 1073741824).toFixed(1)} ГБ`;
const initials = (value) => value.replace(/^@/, '').trim().split(/\s+/).slice(0, 2)
  .map((part) => Array.from(part)[0] ?? '').join('').toUpperCase() || '•';
// Версия — хэш file_id аватарки с сервера: URL меняется только вместе с
// картинкой, а не на каждое сообщение или новый билет.
const avatarUrl = (c) => `/api/conversations/${Number(c.id)}/avatar?v=${encodeURIComponent(c.avatar_version ?? c.avatar_file_id ?? '')}`;
const avatarMarkup = (c, className, unread = false, id = '') => `<span class="avatar-frame ${className}"${id ? ` id="${id}"` : ''} aria-hidden="true">
  <span class="avatar-initials">${esc(initials(nameOf(c)))}</span>
  ${c.avatar_file_id ? `<img class="avatar-photo" src="${avatarUrl(c)}" data-avatar-key="${esc(avatarUrl(c))}" alt="" width="38" height="38" loading="lazy" decoding="async" draggable="false">` : ''}
  ${unread ? '<span class="dot"></span>' : ''}</span>`;

/** Краткий сетевой сбой не должен навсегда удалять аватар из интерфейса. */
function armAvatars(root = document) {
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
  const folderId = filter.startsWith('folder:') ? Number(filter.slice(7)) : 0;
  const folder = folderId ? inboxFolders.find((item) => item.id === folderId) : null;
  const scoped = filter === 'waiting' ? conversations.filter(c => c.unread > 0 || !c.first_response_at)
    : filter === 'hot' ? conversations.filter(c => c.escalated || c.suspicious || c.handoff_at || c.priority === 'high')
    : folder ? conversations.filter((c) => (c.source_ids ?? []).some((id) => folder.source_ids.includes(id)))
    : conversations;
  if (!listQuery) return scoped;
  const query = listQuery.toLocaleLowerCase('ru');
  return scoped.filter((c) => [nameOf(c), c.subject, c.username, c.external_id]
    .some((value) => String(value ?? '').toLocaleLowerCase('ru').includes(query)));
};

const safeColor = (value) => /^#[0-9a-f]{6}$/i.test(String(value ?? '')) ? value : '#9298ff';
const sourceKind = (kind) => ({ telegram_bot:'Бот', telegram_business:'Business', bedolaga:'Bedolaga', minishop:'MiniShop', remnawave:'Remnawave' }[kind] ?? kind);

function renderInboxTabs() {
  const tabs = $('filters');
  if (filter.startsWith('folder:') && !inboxFolders.some((folder) => `folder:${folder.id}` === filter)) filter = 'all';
  const builtins = [
    ['all', 'Все'],
    ['waiting', 'Ждут'],
    ['hot', 'Важные'],
  ];
  tabs.innerHTML = builtins.map(([id, label]) => `<button data-filter="${id}" aria-pressed="${filter === id}">${label}</button>`).join('')
    + inboxFolders.map((folder) => `<button data-filter="folder:${folder.id}" aria-pressed="${filter === `folder:${folder.id}`}" title="${esc(folder.source_ids.length)} источников"><i style="--folder-color:${safeColor(folder.color)}"></i>${esc(folder.name)}</button>`).join('');
}

async function loadInboxMeta() {
  const meta = await json('/api/inbox/meta');
  if (!meta) return;
  inboxSources = meta.sources ?? [];
  inboxFolders = meta.folders ?? [];
  renderInboxTabs();
  renderList(true);
}

/** Переключение выделения не требует пересборки списка. */
function markSelected(id) {
  for (const row of $('list').children) {
    if (row.dataset) row.setAttribute('aria-selected', String(Number(row.dataset.id) === id));
  }
}

let listSignature = '';
function renderList(force = false) {
  const items = visible();
  // Полная перерисовка списка на каждое событие ощутимо тормозит: при
  // потоке сообщений кадр уходит на пересборку одинаковых строк. Выделение
  // в подпись не входит — оно меняется атрибутом.
  const signature = `${filter}:${listQuery}|` + items.map((c) =>
    `${c.id}:${c.unread}:${c.last_message_at}:${c.status}:${c.priority}:${nameOf(c)}:${c.username}:${c.avatar_file_id}:${c.subject}:${c.source?.name}:${(c.source_ids ?? []).join('.')}:${c.escalated}${c.suspicious}${c.handoff_at ? 1 : 0}${c.ai_mode}:${c.window?.open}`).join(',');
  if (!force && signature === listSignature) return;
  listSignature = signature;

  const box = $('list');
  const frag = document.createDocumentFragment();
  const waiting = conversations.filter(c => c.unread > 0).length;
  $('cntInbox').textContent = waiting || conversations.length;
  renderBoard();
  if (!items.length) { box.replaceChildren(Object.assign(document.createElement('p'), { className:'empty', textContent:listQuery ? 'Ничего не найдено.' : 'Здесь пока пусто.' })); return; }
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
    row.setAttribute('aria-selected', String(current?.id === c.id));
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
  const unread = conversations.filter(c => c.unread > 0).length;
  const noAnswer = conversations.filter(c => !c.first_response_at && c.last_inbound_at).length;
  const waitHuman = conversations.filter(c => c.handoff_at).length;
  const unknown = conversations.filter(c => c.suspicious).length;

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
    filter = b.dataset.filter;
    for (const o of $('filters').children) o.setAttribute('aria-pressed', String(o.dataset.filter === filter));
    renderList(true);
  };
}

function renderWindow() {
  const box = $('composer');
  if (!current) { box.hidden = true; return; }
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
  if (!current.window.applies) {
    box.dataset.window = 'open'; $('ring').style.setProperty('--p', 100);
    $('wleft').textContent = 'без ограничения';
    $('input').disabled = $('send').disabled = false;
    $('send').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 14-7-4 14-3-6-7-1Z"/></svg>';
    $('send').setAttribute('aria-label', 'Отправить сообщение'); return;
  }
  const left = Math.max(0, (current.last_inbound_at ?? 0) + WINDOW_MS - Date.now());
  const state = left === 0 ? 'closed' : left < SOON_MS ? 'soon' : 'open';
  box.dataset.window = state;
  $('ring').style.setProperty('--p', Math.round(left / WINDOW_MS * 100));
  $('wleft').textContent = state === 'closed' ? 'окно ответа закрыто' : `осталось ${fmtLeft(left)}`;
  $('input').disabled = $('send').disabled = state === 'closed';
  $('send').innerHTML = state === 'closed'
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 14-7-4 14-3-6-7-1Z"/></svg>';
  $('send').setAttribute('aria-label', state === 'closed' ? 'Окно ответа закрыто' : 'Отправить сообщение');
  $('input').placeholder = state === 'closed'
    ? 'Клиент не писал больше суток — Telegram не пропустит ответ'
    : 'Ответ уйдёт от имени аккаунта поддержки';
}

/** Цитата: на что отвечает это сообщение. Без неё «Да» повисает в воздухе. */
function quoteBlock(m) {
  if (!m.reply_excerpt && !m.reply_to_external_id) return null;
  const el = document.createElement('div');
  el.className = 'reply-to';
  el.innerHTML = `<span>${esc(m.reply_excerpt ?? 'сообщение выше')}</span>`;
  if (m.reply_to_external_id) el.onclick = () => jumpTo(m.reply_to_external_id);
  return el;
}

const messageSignature = (m, files = []) => JSON.stringify([
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

function bubble(m, attachments = {}) {
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
  if (canWrite() && m.direction === 'in' && m.external_msg_id && current?.channel?.startsWith('tg_')) {
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
  quoting = { id: m.external_msg_id, excerpt: (m.text ?? `[${m.media_type ?? 'вложение'}]`).slice(0, 160) };
  renderQuoting();
  $('input').focus();
}
function clearQuote() { quoting = null; renderQuoting(); }
function renderQuoting() {
  const box = $('quotingBox');
  if (!box) return;
  if (!quoting) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="quoting"><span>В ответ: ${esc(quoting.excerpt)}</span>
    <button class="btn quiet" id="dropQuote" style="margin-left:auto">Отменить</button></div>`;
  $('dropQuote').onclick = clearQuote;
}

function renderSuggestion() {
  const box = $('suggestBox');
  if (!suggestion) { box.innerHTML = ''; return; }
  const pct = suggestion.confidence == null ? 0 : Math.round(suggestion.confidence * 100);
  let sources = []; try { sources = suggestion.sources ? JSON.parse(suggestion.sources) : []; } catch {}
  box.innerHTML = `<div class="suggest">
    <div class="head"><b>AI-помощник</b><span>уверенность ${pct}%${suggestion.needs_human ? ' · нужен человек' : ''}</span></div>
    <div class="text">${esc(suggestion.text)}</div>
    ${suggestion.reason ? `<div class="src">Модель: ${esc(suggestion.reason)}</div>` : ''}
    ${sources.length ? `<div class="src">Источники: ${esc(sources.join(' · '))}</div>` : ''}
    ${canWrite() ? `<div class="acts"><button class="btn primary" id="sgSend">Отправить</button>
      <button class="btn" id="sgEdit">Править</button><button class="btn danger" id="sgNo">Отклонить</button></div>` : '<div class="hint">Предложка доступна только для просмотра.</div>'}
    <div class="gauge"><i style="width:${pct}%"></i></div></div>`;
  if (!canWrite()) return;
  $('sgSend').onclick = () => sendText(suggestion.text, { suggestionId: suggestion.id, edited: false });
  $('sgEdit').onclick = () => { $('input').value = suggestion.text; $('input').focus(); };
  $('sgNo').onclick = async () => {
    await mutate(`/api/suggestions/${suggestion.id}/decide`,
      { method:'POST', body: JSON.stringify({ status:'rejected' }) }, 'Предложка отклонена');
    suggestion = null; renderSuggestion();
  };
}

function renderCustomer(profile) {
  const card = $('customerCard');
  if (!current) { card.innerHTML = '<div class="item"><span class="hint">Выберите диалог.</span></div>'; return; }
  const rows = [
    ['Telegram ID', profile?.identity?.telegramId ?? current.tg_user_id ?? '—'],
    ['Ник', (profile?.identity?.username ?? current.username) ? '@' + (profile?.identity?.username ?? current.username).replace(/^@/,'') : '—'],
    ['Канал', current.channel === 'tg_dm' ? 'личка' : 'тикет'],
  ];
  const sub = profile?.subscription;
  if (sub?.status) rows.push(['Подписка', sub.status]);
  if (sub?.expiresAt) rows.push(['Действует до', fmtDate(sub.expiresAt)]);
  if (sub?.trafficUsed !== undefined) rows.push(['Трафик', `${gb(sub.trafficUsed)}${sub.trafficLimit ? ` из ${gb(sub.trafficLimit)}` : ''}`]);
  if (sub?.devices !== undefined) rows.push(['Устройств', `${sub.devices}${sub.deviceLimit ? ` из ${sub.deviceLimit}` : ''}`]);
  const act = profile?.activity;
  if (act?.dailyAverageBytes) rows.push(['В среднем в день', gb(act.dailyAverageBytes)]);
  if (act?.firstSeen) rows.push(['Клиент с', fmtDate(act.firstSeen)]);
  if (act?.lastNode) rows.push(['Последний сервер', act.lastNode]);
  if (profile?.balance?.amount !== undefined) rows.push(['Баланс', `${profile.balance.amount} ${profile.balance.currency ?? ''}`]);

  card.innerHTML =
    rows.map(([k,v]) => `<div class="item"><span class="lbl">${esc(k)}</span><span class="val mono">${esc(v)}</span></div>`).join('')
    + (act?.topNodes?.length
        ? `<div class="item col-item"><span class="lbl">Чаще всего использует</span>`
          + act.topNodes.map((n) => `<div class="device"><span class="grow">${esc(n.name)}</span><span class="mono">${gb(n.bytes)}</span></div>`).join('')
          + `</div>` : '')
    + (current.sub_link
        ? `<div class="item col-item"><span class="lbl">Клиент прислал ключ</span>
             <span class="mono" style="overflow-wrap:anywhere">${esc(current.sub_link.slice(0, 120))}</span></div>`
        : '')
    + (canPermission('bedolaga:view') && (current.channel === 'bedolaga' || settings?.channels?.bedolaga)
        ? `<div class="item"><button class="btn primary wide" id="bedolagaCardBtn">Полная карточка Bedolaga</button></div>`
        : '')
    + (canPermission('conversation:profile') ? `<div class="item"><button class="btn wide" id="refreshCust">Обновить карточку</button></div>` : '')
    + (profile?.found
        ? `<div class="item"><span class="hint">Источники: ${esc((profile.sources ?? []).join(', ') || '—')}</span></div>`
        : `<div class="item"><span class="hint">Клиент не найден в Bedolaga, MiniShop или Remnawave.</span></div>`)
    + ((profile?.trace ?? []).length
        ? `<div class="item col-item"><span class="hint">${(profile.trace).map((t) => esc(t)).join('<br>')}</span></div>` : '');

  if ($('bedolagaCardBtn')) $('bedolagaCardBtn').onclick = () => openBedolagaCard();
  if ($('refreshCust')) $('refreshCust').onclick = async () => {
    $('refreshCust').disabled = true;
    const data = await mutate(`/api/conversations/${current.id}/customer/refresh`, { method:'POST' }, 'Карточка обновлена');
    $('refreshCust').disabled = false;
    if (data) renderCustomer(data.customer);
  };
}

const bedMoney = (value) => value !== undefined && value !== null && Number.isFinite(Number(value))
  ? new Intl.NumberFormat('ru-RU', { style:'currency', currency:'RUB', maximumFractionDigits:2 }).format(Number(value))
  : '—';
const bedDate = (value) => value ? fmtDate(value) : '—';
const bedValue = (value, fallback = '—') => value === undefined || value === null || value === '' ? fallback : value;
const bedStatus = (value) => {
  if (value === 'active') return 'Активна';
  if (value === 'disabled') return 'Отключена';
  if (value === 'blocked') return 'Заблокирован';
  if (value === 'open') return 'Открыт';
  if (value === 'answered') return 'Ждём клиента';
  if (value === 'pending') return 'В ожидании';
  if (value === 'closed') return 'Закрыт';
  if (value === 'completed') return 'Завершён';
  return bedValue(value);
};
const bedEvent = (value) => ({
  user_registered:'Регистрация',
  user_updated:'Профиль обновлён',
  user_activity:'Последняя активность',
  subscription_started:'Подписка началась',
  transaction_completed:'Платёж завершён',
  transaction_created:'Платёж создан',
  ticket_opened:'Тикет открыт',
  ticket_updated:'Тикет обновлён',
  ticket_closed:'Тикет закрыт',
}[value] ?? bedValue(value));
let bedolagaCard = null, bedolagaCardTab = 'overview', bedolagaCardConversation = null;
let bedolagaCardRequest = 0;
let bedolagaCapabilities = { canExtendSubscription:false };
const bedolagaExtensionPending = new Set();
const bedolagaExtensionUncertain = new Set();

function bedKpi(label, value) {
  return `<div class="bed-kpi"><span>${esc(label)}</span><b>${esc(bedValue(value))}</b></div>`;
}

function bedTable(headers, rows) {
  if (!rows.length) return '<div class="bed-empty">В этом разделе пока нет данных.</div>';
  return `<div class="bed-table-wrap"><table class="bed-table"><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${esc(bedValue(cell))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function bedTabLabel(label, section) {
  const total = section?.total ?? 0;
  return section?.truncated ? `${label} · ${(section.items ?? []).length} из ${total}` : `${label} · ${total}`;
}

function bedolagaTabBody(card, tab) {
  const user = card.user ?? {};
  if (tab === 'overview') {
    const promo = user.promoGroup;
    return `<section class="bed-section"><h3>Клиент</h3><div class="bed-kpis">
      ${bedKpi('Статус', bedStatus(user.status))}${bedKpi('Язык', user.language)}${bedKpi('Регистрация', bedDate(user.createdAt))}
      ${bedKpi('Последняя активность', bedDate(user.lastActivity))}${bedKpi('Платная подписка', user.hasHadPaidSubscription ? 'Была' : 'Не было')}
      ${bedKpi('Первое пополнение', user.hasMadeFirstTopup ? 'Есть' : 'Нет')}${bedKpi('Реферальный код', user.referralCode)}
      ${bedKpi('Приглашён пользователем', user.referredById ? `#${user.referredById}` : '—')}
    </div></section>
    ${promo ? `<section class="bed-section"><h3>Промо-группа</h3><div class="bed-kpis">
      ${bedKpi('Название', promo.name)}${bedKpi('Скидка сервера', promo.serverDiscountPercent == null ? '—' : `${promo.serverDiscountPercent}%`)}
      ${bedKpi('Скидка трафика', promo.trafficDiscountPercent == null ? '—' : `${promo.trafficDiscountPercent}%`)}
      ${bedKpi('Скидка устройств', promo.deviceDiscountPercent == null ? '—' : `${promo.deviceDiscountPercent}%`)}
    </div></section>` : ''}`;
  }
  if (tab === 'subscriptions') {
    const items = card.subscriptions?.items ?? [];
    if (!items.length) return '<div class="bed-empty">Подписки не найдены.</div>';
    return `<div class="bed-stack">${items.map((sub) => {
      const pending = bedolagaExtensionPending.has(Number(sub.id));
      const uncertain = bedolagaExtensionUncertain.has(Number(sub.id));
      return `<article class="bed-sub">
      <div><b>Подписка #${esc(sub.id)} · ${esc(bedStatus(sub.actualStatus ?? sub.status))}</b>
        <div class="meta"><span>${sub.isTrial ? 'Пробная' : 'Обычная'}</span><span>до ${esc(bedDate(sub.endDate))}</span>
        <span>трафик ${esc(bedValue(sub.trafficUsedGb))} / ${esc(bedValue(sub.trafficLimitGb))} ГБ</span>
        <span>устройств: ${esc(bedValue(sub.deviceLimit))}</span><span>сквадов: ${esc(sub.connectedSquadsCount)}</span>
        <span>${sub.autopayEnabled ? 'автопродление включено' : 'автопродление выключено'}</span>
        <span>${sub.hasAccessLink ? 'ссылка выпущена' : 'ссылки нет'}</span></div></div>
      ${bedolagaCapabilities.canExtendSubscription ? `<div class="bed-extend"><input type="number" min="1" max="36500" value="7" aria-label="Дополнительные дни для подписки ${esc(sub.id)}" data-bed-days="${esc(sub.id)}" ${pending || uncertain ? 'disabled' : ''}><button class="btn primary" data-bed-extend="${esc(sub.id)}" ${pending || uncertain ? 'disabled' : ''}>${pending ? 'Продлеваю…' : (uncertain ? 'Сначала проверьте срок' : 'Добавить дни')}</button></div>` : ''}
    </article>`;
    }).join('')}</div>`;
  }
  if (tab === 'transactions') return bedTable(['ID','Тип','Сумма','Описание','Метод','Статус','Дата'],
    (card.transactions?.items ?? []).map((item) => [item.id, item.type, bedMoney(item.amountRubles), item.description, item.paymentMethod, item.isCompleted ? 'Завершён' : 'Не завершён', bedDate(item.completedAt ?? item.createdAt)]));
  if (tab === 'tickets') return bedTable(['ID','Тема','Статус','Приоритет','Сообщений','Создан','Закрыт'],
    (card.tickets?.items ?? []).map((item) => [item.id, item.title, bedStatus(item.status), item.priority, item.messageCount, bedDate(item.createdAt), bedDate(item.closedAt)]));
  if (tab === 'referrals') return `<div class="bed-kpis">
      ${bedKpi('Приглашено', card.referrals?.invitedCount)}${bedKpi('Активных', card.referrals?.activeReferrals)}
      ${bedKpi('Заработано', bedMoney(card.referrals?.totalEarnedRubles))}${bedKpi('За месяц', bedMoney(card.referrals?.monthEarnedRubles))}
      ${bedKpi('Комиссия', card.referrals?.commissionPercent == null ? '—' : `${card.referrals.commissionPercent}%`)}</div>
    ${bedTable(['ID','Клиент','Username','Статус','Баланс','Заработано','Пополнений','Активность'],
      (card.referrals?.items ?? []).map((item) => [item.id, item.fullName, item.username ? `@${item.username}` : '—', bedStatus(item.status), bedMoney(item.balanceRubles), bedMoney(item.totalEarnedRubles), item.topupsCount, bedDate(item.lastActivity)]))}`;
  if (tab === 'activity') return bedTable(['ID','Событие','Подписка','Транзакция','Тикет','Сумма','Дата'],
    (card.activity?.items ?? []).map((item) => [item.id, bedEvent(item.eventType), item.subscriptionId ? `#${item.subscriptionId}` : '—', item.transactionId ? `#${item.transactionId}` : '—', item.ticketId ? `#${item.ticketId}` : '—', bedMoney(item.amountRubles), bedDate(item.occurredAt ?? item.createdAt)]));
  if (card.gifts?.available === false) {
    return `<div class="bed-empty">${esc(card.gifts.reason ?? 'История подарков недоступна для этой интеграции.')}</div>`;
  }
  return bedTable(['ID','Тип','Подписка','Эффект','Скидка','Бонус','Истекает','Статус'],
    (card.gifts?.items ?? []).map((item) => [item.id, item.notificationType, item.subscriptionId ? `#${item.subscriptionId}` : '—', item.effectType, item.discountPercent == null ? '—' : `${item.discountPercent}%`, bedMoney(item.bonusAmountRubles), bedDate(item.expiresAt), item.isActive ? 'Активен' : (item.claimedAt ? 'Получен' : 'Неактивен')]));
}

function renderBedolagaCard() {
  const box = $('bedCardBody');
  if (!box || !bedolagaCard) return;
  const card = bedolagaCard, user = card.user ?? {};
  const tabs = [
    ['overview','Обзор'], ['subscriptions',bedTabLabel('Подписки', card.subscriptions)],
    ['transactions',bedTabLabel('Платежи', card.transactions)], ['tickets',bedTabLabel('Тикеты', card.tickets)],
    ['referrals',bedTabLabel('Рефералы', card.referrals)], ['activity',`Активность · ${card.activity?.total ?? 0}`],
    ['gifts',`Подарки · ${card.gifts?.total ?? 0}`],
  ];
  const display = user.fullName || (user.username ? `@${user.username}` : `#${user.id}`);
  box.className = '';
  box.innerHTML = `<div class="bed-shell">
    <div class="bed-summary"><span class="avatar">${esc(initials(display))}</span><div class="identity"><b>${esc(display)}</b>
      <span>${user.username ? `@${esc(user.username)} · ` : ''}Telegram ${esc(bedValue(user.telegramId))} · Bedolaga #${esc(user.id)}${user.email ? ` · ${esc(user.email)}` : ''}</span></div>
      <div class="balance"><b>${esc(bedMoney(user.balanceRubles))}</b><span>баланс</span></div></div>
    ${(card.warnings ?? []).map((warning) => `<div class="bed-warning">${esc(warning)}</div>`).join('')}
    <nav class="bed-tabs" aria-label="Разделы карточки">${tabs.map(([id,label]) => `<button data-bed-tab="${id}" aria-pressed="${id === bedolagaCardTab}">${esc(label)}</button>`).join('')}</nav>
    <div id="bedTabBody">${bedolagaTabBody(card, bedolagaCardTab)}</div>
    <span class="hint">Обновлено: ${esc(fmtTime(card.loadedAt))}. Секретная ссылка подписки и служебные идентификаторы платежей скрыты.</span>
  </div>`;
  for (const button of box.querySelectorAll('[data-bed-tab]')) button.onclick = () => {
    bedolagaCardTab = button.dataset.bedTab;
    renderBedolagaCard();
  };
  for (const button of box.querySelectorAll('[data-bed-extend]')) button.onclick = () => {
    const subscriptionId = Number(button.dataset.bedExtend);
    if (bedolagaExtensionPending.has(subscriptionId) || bedolagaExtensionUncertain.has(subscriptionId)) return;
    const input = box.querySelector(`[data-bed-days="${subscriptionId}"]`);
    const days = Number(input?.value);
    if (!Number.isSafeInteger(days) || days < 1 || days > 36500) return toast('Введите целое число дней от 1 до 36500');
    const conversationId = bedolagaCardConversation;
    confirmAction('Начислить дополнительные дни?', `Подписка #${subscriptionId} будет продлена на ${days} дн. Действие сразу уйдёт в Bedolaga.`, async () => {
      if (bedolagaExtensionPending.has(subscriptionId)) return null;
      bedolagaExtensionPending.add(subscriptionId);
      const operationId = crypto.randomUUID();
      let result = null;
      try {
        let response;
        try {
          response = await api(`/api/conversations/${conversationId}/bedolaga/subscriptions/${subscriptionId}/extend`,
            { method:'POST', body:JSON.stringify({ days, operationId }) });
        } catch (err) {
          bedolagaExtensionUncertain.add(subscriptionId);
          renderBedolagaCard();
          toast(`Связь оборвалась после отправки. Проверьте срок подписки перед повтором: ${err.message}`);
          return null;
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) { toast(payload.error ?? `Ошибка ${response.status}`); return null; }
        result = payload;
        if (result.outcome === 'unknown') bedolagaExtensionUncertain.add(subscriptionId);
        toast(result.warning || `Добавлено ${days} дн.`);
        return result;
      } finally {
        bedolagaExtensionPending.delete(subscriptionId);
        // Не открываем старую карточку поверх другого диалога и не создаём
        // впечатление успеха повторным открытием после отказа Bedolaga.
        if (result && current?.id === conversationId) {
          await openBedolagaCard(conversationId, 'subscriptions');
        }
      }
    });
  };
}

async function openBedolagaCard(conversationId = current?.id, tab = bedolagaCardTab) {
  if (!conversationId) return;
  const requestId = ++bedolagaCardRequest;
  bedolagaCardConversation = conversationId;
  bedolagaCardTab = tab;
  bedolagaCard = null;
  bedolagaCapabilities = { canExtendSubscription:false };
  sheet('Карточка клиента Bedolaga', '<div id="bedCardBody" class="bed-empty">Загружаю данные Bedolaga…</div>', '', 'wide');
  let response;
  try { response = await api(`/api/conversations/${conversationId}/bedolaga/customer`); }
  catch (err) {
    if (requestId !== bedolagaCardRequest || bedolagaCardConversation !== conversationId || current?.id !== conversationId) return;
    const box = $('bedCardBody');
    if (box) box.textContent = `Нет связи с сервером: ${err.message}`;
    return;
  }
  const payload = await response.json().catch(() => ({}));
  if (requestId !== bedolagaCardRequest || bedolagaCardConversation !== conversationId || current?.id !== conversationId) return;
  const box = $('bedCardBody');
  if (!box) return;
  if (!response.ok) { box.textContent = payload.error ?? `Ошибка ${response.status}`; return; }
  bedolagaCapabilities = payload.capabilities ?? { canExtendSubscription:false };
  bedolagaCard = payload.customer;
  renderBedolagaCard();
}

function renderCollaboration(value = current?.collaboration) {
  const card = $('collabCard');
  if (!current) { card.innerHTML = '<div class="item"><span class="hint">Выберите диалог.</span></div>'; return; }
  const owner = value?.owner;
  const presence = value?.presences ?? [];
  $('foldOwner').textContent = owner?.name ?? 'свободен';
  card.innerHTML = `<div class="item"><span class="lbl">Ответственный</span><span class="val">${esc(owner?.name ?? 'не назначен')}</span></div>
    ${owner?.until ? `<div class="item"><span class="lbl">Lease до</span><span class="val mono">${esc(fmtTime(owner.until))}</span></div>` : ''}
    ${presence.length ? `<div class="item col-item"><span class="lbl">Сейчас в диалоге</span>${presence.map((p) => `<span class="mini-note">${esc(p.name)} · ${p.state === 'typing' ? 'печатает' : 'смотрит'}</span>`).join('')}</div>` : ''}
    ${canPermission('conversation:status') ? `<div class="item context-action"><button class="btn wide" id="claimBtn">Взять диалог</button></div>
    <div class="item context-action"><button class="btn quiet wide" id="releaseBtn">Освободить</button></div>` : '<div class="item"><span class="hint">Режим просмотра: закрепление недоступно.</span></div>'}`;
  if (!canPermission('conversation:status')) return;
  $('claimBtn').onclick = async () => {
    const result = await mutate(`/api/conversations/${current.id}/engage`, { method:'POST' }, 'Диалог закреплён');
    if (result?.collaboration) { current.collaboration = result.collaboration; renderCollaboration(result.collaboration); }
  };
  $('releaseBtn').onclick = async () => {
    const result = await mutate(`/api/conversations/${current.id}/release`, { method:'POST' }, 'Диалог освобождён');
    if (result) { current.collaboration = { owner:null, presences:[] }; renderCollaboration(current.collaboration); }
  };
}

async function loadUnifiedProfile(conversationId = current?.id) {
  if (!conversationId) return;
  const data = await json(`/api/conversations/${conversationId}/profile`);
  if (!data || current?.id !== conversationId) return;
  renderUnifiedProfile(data.profile);
}

function renderUnifiedProfile(profile) {
  const card = $('profileCard');
  if (!current || !profile) { card.innerHTML = '<div class="item"><span class="hint">Профиль пока пуст.</span></div>'; return; }
  $('foldProfile').textContent = profile.company || profile.display_name || '';
  const tags = profile.tags ?? [];
  const notes = profile.notes ?? [];
  const related = profile.related ?? [];
  const rows = [['Имя', profile.display_name || '—'], ['Компания', profile.company || '—'], ['Email', profile.email || '—'], ['Телефон', profile.phone || '—']];
  card.innerHTML = rows.map(([k,v]) => `<div class="item"><span class="lbl">${esc(k)}</span><span class="val">${esc(v)}</span></div>`).join('')
    + `<div class="item col-item"><span class="lbl">Теги</span><div class="profile-tags">${tags.length ? tags.map((t) => `<span class="badge">${esc(t)}</span>`).join('') : '<span class="hint">нет</span>'}</div></div>`
    + (notes.length ? `<div class="item col-item"><span class="lbl">Последние заметки</span>${notes.slice(0,4).map((n) => `<span class="mini-note">${esc(n.text)}<br><span class="hint">${esc(n.actor_key)} · ${fmtTime(n.created_at)}</span></span>`).join('')}</div>` : '')
    + (related.length > 1 ? `<div class="item col-item"><span class="lbl">Связанные диалоги</span>${related.slice(0,8).map((r) => `<button class="btn quiet" data-related="${r.id}">${esc(channelLabel(r))} · ${esc(conversationStatus(r.status))}</button>`).join('')}</div>` : '')
    + (canPermission('conversation:profile') ? `<div class="item context-action"><button class="btn wide" id="editProfile">Изменить профиль</button></div>` : '')
    + (canPermission('conversation:notes') ? `<div class="item context-action"><button class="btn wide" id="addProfileNote">Добавить заметку</button></div>` : '');
  for (const b of card.querySelectorAll('[data-related]')) b.onclick = () => open(Number(b.dataset.related));
  if ($('editProfile')) $('editProfile').onclick = () => {
    sheet('Единый профиль', `<div class="frow"><label>Имя</label><input id="pfName" value="${esc(profile.display_name || '')}"></div>
      <div class="frow"><label>Компания</label><input id="pfCompany" value="${esc(profile.company || '')}"></div>
      <div class="frow"><label>Email</label><input id="pfEmail" value="${esc(profile.email || '')}"></div>
      <div class="frow"><label>Телефон</label><input id="pfPhone" value="${esc(profile.phone || '')}"></div>
      <div class="frow"><label>Теги через запятую</label><input id="pfTags" value="${esc(tags.join(', '))}"></div>`,
      '<button class="btn" id="pfCancel">Отмена</button><button class="btn primary" id="pfSave">Сохранить</button>');
    $('pfCancel').onclick = closeSheet;
    $('pfSave').onclick = async () => {
      const result = await mutate(`/api/conversations/${current.id}/profile`, { method:'PATCH', body:JSON.stringify({
        display_name:$('pfName').value, company:$('pfCompany').value, email:$('pfEmail').value, phone:$('pfPhone').value,
        tags:$('pfTags').value.split(',').map((x) => x.trim()).filter(Boolean),
      }) }, 'Профиль сохранён');
      if (result?.profile) { closeSheet(); renderUnifiedProfile(result.profile); }
    };
  };
  if ($('addProfileNote')) $('addProfileNote').onclick = () => {
    sheet('Заметка о клиенте', '<textarea id="pfNote" rows="6" placeholder="Контекст для следующего оператора"></textarea>', '<button class="btn" id="pfCancel">Отмена</button><button class="btn primary" id="pfAdd">Добавить</button>');
    $('pfCancel').onclick = closeSheet;
    $('pfAdd').onclick = async () => {
      const result = await mutate(`/api/conversations/${current.id}/profile/notes`, { method:'POST', body:JSON.stringify({ text:$('pfNote').value }) }, 'Заметка добавлена');
      if (result) { closeSheet(); loadUnifiedProfile(); }
    };
  };
}

/** Перезапускает анимацию появления модуля: снимаем класс, форсируем reflow,
 *  возвращаем. Без reflow повторное добавление того же класса анимацию не
 *  перезапускает. */
function reveal(el) {
  el.classList.remove('reveal');
  void el.offsetWidth;
  el.classList.add('reveal');
}

async function renderSubscription() {
  const wrap = $('subWrap');
  if (!current || !settings?.remnawave || !canPermission('bedolaga:view')) { wrap.hidden = true; $('devicesWrap').hidden = true; return; }
  wrap.hidden = false;
  // Диалог, для которого грузим подписку. Запрос в Remnawave небыстрый, и при
  // быстром переключении ответ мог прийти, когда открыт уже другой диалог —
  // тогда он затирал актуальную панель. После каждого await сверяемся: если
  // диалог сменился, тихо выходим и правую колонку не трогаем.
  const cid = current.id;
  // Свёрнутый раздел не грузим: это запрос в Remnawave на каждый диалог.
  if (!wrap.open) {
    $('subBody').innerHTML = '<div class="item"><span class="hint">Разверните, чтобы загрузить.</span></div>';
    $('devicesWrap').hidden = true;
    return;
  }
  $('subBody').innerHTML = '<div class="item"><span class="hint">Загружаю…</span></div>';
  const res = await api(`/api/conversations/${cid}/subscription`);
  if (current?.id !== cid) return;
  if (!res.ok) {
    $('devicesWrap').hidden = true;
    $('subBody').innerHTML = `<div class="item col-item"><span class="hint">${esc((await res.json()).error)}</span>
      <button class="btn" id="explainBtn">Почему не нашёлся</button></div>`;
    reveal($('subBody'));
    $('explainBtn').onclick = async () => {
      $('explainBtn').disabled = true;
      const data = await json(`/api/conversations/${current.id}/subscription/explain`);
      if (!data) return toast('Разбор не удался');
      sheet('Связка с Remnawave',
        `<div class="log">${esc(data.steps.join('\n'))}</div>
         <div class="hint">Записей в индексе: ${data.indexSize}</div>
         ${data.near?.length ? `<div class="cap">Похожие записи</div><div class="log">${esc(data.near.join('\n'))}</div>` : ''}`,
        `<button class="btn" id="closeX">Понятно</button>`);
      $('closeX').onclick = closeSheet;
    };
    return;
  }
  const { profile, devices } = await res.json();
  if (current?.id !== cid) return;
  $('foldSub').textContent = profile?.status ?? '—';
  const rows = profile ? [['Статус', profile.status ?? '—'],
    ['Действует до', profile.expiresAt ? fmtDate(profile.expiresAt) : '—'],
    ['Трафик', `${gb(profile.trafficUsed)} из ${profile.trafficLimit ? gb(profile.trafficLimit) : '∞'}`],
    ['Лимит устройств', profile.deviceLimit ?? '—'], ['Short ID', profile.shortId ?? '—']] : [];
  $('subBody').innerHTML =
    (rows.length ? rows.map(([k,v]) => `<div class="item"><span class="lbl">${esc(k)}</span><span class="val mono">${esc(v)}</span></div>`).join('')
      : '<div class="item"><span class="hint">Профиль не найден.</span></div>')
    + (profile?.subscriptionUrl ? `<div class="item"><button class="btn wide" id="copySub">Скопировать ссылку</button></div>` : '')
    + (canPermission('bedolaga:devices') ? `<div class="item"><button class="btn wide" id="resetDev">Сбросить все устройства</button></div>
       <div class="item"><button class="btn wide danger" id="revoke">Перевыпустить подписку</button></div>` : '<div class="item"><span class="hint">Сброс устройств и перевыпуск доступны только администратору.</span></div>');
  reveal($('subBody'));

  // Устройств бывает полтора десятка — им отдельная прокручиваемая группа,
  // иначе они выдавливают всё остальное из колонки.
  $('devicesWrap').hidden = !devices?.length;
  if (devices?.length) {
    $('devicesCap').textContent = `${devices.length}`;
    $('devicesBody').innerHTML = devices.map((d) => `<div class="device">
      <span class="grow">${esc(d.platform ?? '?')} · ${esc(d.model ?? d.hwid.slice(0,10))}</span>
      ${canPermission('bedolaga:devices') ? `<button class="btn danger" data-hwid="${esc(d.hwid)}">Удалить</button>` : ''}</div>`).join('');
    reveal($('devicesBody'));
  }

  if (profile?.subscriptionUrl) $('copySub').onclick = () => { navigator.clipboard.writeText(profile.subscriptionUrl); toast('Ссылка скопирована'); };
  if (!canPermission('bedolaga:devices')) return;
  for (const b of document.querySelectorAll('#devicesBody [data-hwid]')) {
    b.onclick = () => confirmAction('Удалить устройство?', 'Клиент потеряет доступ с него до повторного подключения.',
      () => subAction('delete-device', b.dataset.hwid));
  }
  $('resetDev').onclick = () => confirmAction('Сбросить все устройства?',
    'Все привязки снимутся. Клиенту придётся подключить приложения заново.', () => subAction('reset-devices'));
  $('revoke').onclick = () => confirmAction('Перевыпустить подписку?',
    'Старая ссылка перестанет работать сразу. Клиенту нужно будет добавить новую.', () => subAction('revoke'));
}

function confirmAction(title, text, run) {
  sheet(title, `<p style="font-size:13px">${esc(text)}</p>`,
    `<button class="btn" id="no">Отмена</button><button class="btn primary danger" id="yes">Подтвердить</button>`);
  $('no').onclick = closeSheet;
  $('yes').onclick = async () => { closeSheet(); await run(); };
}
async function subAction(action, hwid) {
  const done = await mutate(`/api/conversations/${current.id}/subscription/action`,
    { method:'POST', body: JSON.stringify({ action, hwid }) }, 'Готово');
  if (done) { renderSubscription(); open(current.id); }
}

/**
 * Режим диалога сильнее глобального — кроме «Выключен везде».
 * Пишем это прямо в карточке: иначе непонятно, почему auto не сработал.
 */
function renderAiNote() {
  const note = $('aiModeNote');
  if (!note || !current) return;
  const global = settings?.runtime?.aiMode;
  const own = current.ai_mode;
  note.textContent =
    current.handoff_at ? 'Диалог у человека — AI по существу не отвечает'
    : global === 'off' ? 'AI выключен в настройках — режим диалога не действует'
    : own === 'inherit' ? `Сейчас действует режим из настроек: ${global === 'auto' ? 'отвечает сам' : global === 'shadow' ? 'только анализирует' : 'предлагает'}`
    : own === 'auto' ? 'Ответы уходят клиенту без подтверждения'
    : own === 'shadow' ? 'AI анализирует сообщения, но ничего не отправляет клиенту'
    : own === 'off' ? 'В этом диалоге AI молчит'
    : 'AI пишет предложку, отправляете вы';
}

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
async function heartbeatCurrent() {
  if (!current || !canPermission('conversation:read') || document.visibilityState !== 'visible') return;
  const id = current.id;
  try {
    const response = await api(`/api/conversations/${id}/presence`, {
      method:'POST', body:JSON.stringify({ state:'viewing' }),
    });
    const data = await response.json().catch(() => null);
    if (current?.id === id && data?.collaboration) {
      current.collaboration = data.collaboration;
      renderCollaboration(data.collaboration);
    }
  } catch {}
}

/** Реальное намерение ответить: теперь AI должен уступить оператору. */
async function engageCurrent() {
  if (!current || !canWrite() || document.visibilityState !== 'visible') return;
  const id = current.id;
  try {
    const response = await api(`/api/conversations/${id}/engage`, {
      method:'POST', body:JSON.stringify({ state:'typing' }),
    });
    const data = await response.json().catch(() => null);
    if (current?.id === id && data?.collaboration) {
      current.collaboration = data.collaboration;
      renderCollaboration(data.collaboration);
    }
  } catch {}
}
setInterval(heartbeatCurrent, 15_000);
window.addEventListener('focus', heartbeatCurrent);
document.addEventListener('visibilitychange', heartbeatCurrent);

function paintHeader(c) {
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
  $('err').textContent = '';
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
    if (!button.isConnected || current?.id !== conversationId) return;
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

async function open(id) {
  if (current?.id && current.id !== id && pendingFiles.length && !uploadRunning) {
    for (const item of pendingFiles) if (item.preview) URL.revokeObjectURL(item.preview);
    pendingFiles = []; renderPendingFiles();
  }
  const openTicket = ++openToken;
  $('inboxSplit').dataset.pane = 'thread';
  history.replaceState(null, '', `#c${id}`);

  // Мгновенная отрисовка: данные диалога уже есть в списке, ждать сервер
  // ради шапки незачем.
  const known = conversations.find((c) => c.id === id);
  if (known) {
    current = known;
    heartbeatCurrent();
    quoting = null;
    paintHeader(known);
    renderWindow(); renderAiNote(); renderQuoting(); renderCollaboration(known.collaboration);
    markSelected(id);
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

  current = data.conversation;
  heartbeatCurrent();
  suggestion = data.suggestion;
  paintHeader(current);

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
  renderCollaboration(current.collaboration);
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
const refreshSoon = () => { if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 400); };
let refreshPromise = null, refreshAgain = false;
let currentSyncPromise = null, currentSyncId = null;
let readTimer = null;

function markOpenConversationRead(id = current?.id) {
  if (!canPermission('conversation:read') || !id || current?.id !== id) return;
  current = { ...current, unread:0 };
  const index = conversations.findIndex((item) => item.id === id);
  if (index >= 0) conversations[index] = { ...conversations[index], unread:0 };
  renderList();
  clearTimeout(readTimer);
  readTimer = setTimeout(async () => {
    if (current?.id !== id) return;
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
async function syncCurrentMessages(id = current?.id, { full = false } = {}) {
  if (!id) return;
  if (currentSyncPromise) {
    if (currentSyncId === id && !full) return currentSyncPromise;
    await currentSyncPromise;
    return current?.id === id ? syncCurrentMessages(id, { full }) : undefined;
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
    if (!data || current?.id !== id) return;
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
    current = data.conversation;
    suggestion = data.suggestion;
    paintHeader(current); renderWindow(); renderSuggestion(); renderAiNote();
    renderCollaboration(current.collaboration);
    if (appended && data.messages.some((message) => message.direction === 'in')) markOpenConversationRead(id);
    if (appended && nearBottom) requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
    else if (appended) toast('Новые сообщения ниже по переписке');
  })();
  try { await currentSyncPromise; }
  finally { currentSyncPromise = null; currentSyncId = null; }
}

let refreshFullThread = false;
async function refresh({ fullThread = false } = {}) {
  if (fullThread) refreshFullThread = true;
  if (refreshPromise) { refreshAgain = true; return refreshPromise; }
  refreshPromise = (async () => {
    const full = refreshFullThread;
    refreshFullThread = false;
    const data = await json('/api/conversations');
    if (!data) return;
    const openId = current?.id;
    const previousLastMessageAt = Number(current?.last_message_at ?? 0);
    const previousUpdatedAt = Number(current?.updated_at ?? 0);
    conversations = data.conversations;
    if (current) current = conversations.find(c => c.id === current.id) ?? current;
    renderList();
    // Контрольный опрос раньше обновлял только левый список. Если push-кадр
    // потерялся, открытая переписка оставалась старой до повторного входа.
    if (openId && (full || Number(current?.last_message_at ?? 0) > previousLastMessageAt
      || Number(current?.updated_at ?? 0) > previousUpdatedAt)) {
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
function mergeLiveConversation(conversation) {
  if (!conversation?.id) return;
  const index = conversations.findIndex((item) => item.id === conversation.id);
  if (index >= 0) conversations[index] = { ...conversations[index], ...conversation };
  else conversations.push(conversation);
  conversations.sort((a, b) => Number(b.last_message_at ?? b.created_at ?? 0) - Number(a.last_message_at ?? a.created_at ?? 0));
  if (current?.id === conversation.id) current = { ...current, ...conversation };
  renderList();
}

function removeLiveConversation(conversationId) {
  conversations = conversations.filter((item) => item.id !== conversationId);
  if (current?.id === conversationId) {
    current = null; suggestion = null;
    $('thread').removeAttribute('data-conversation-id');
    $('thread').innerHTML = '<p class="empty">Диалог удалён в Telegram.</p>';
    paintHeader(null); renderWindow(); renderSuggestion(); renderAiNote();
  }
  renderList();
}

async function sendText(text, extra = {}) {
  if (!canWrite() || !text.trim() || !current) return;
  $('send').disabled = true;
  const payload = { text, ...extra };
  if (quoting) { payload.replyTo = quoting.id; payload.replyExcerpt = quoting.excerpt; }
  let res;
  try {
    res = await api(`/api/conversations/${current.id}/reply`, { method:'POST', body: JSON.stringify(payload) });
  } catch (err) {
    $('err').textContent = `Нет связи с сервером: ${err.message}`;
    renderWindow(); return false;
  }
  if (res.ok) {
    $('input').value = ''; $('input').style.height = 'auto'; $('err').textContent = '';
    suggestion = null; renderSuggestion(); clearQuote();
    void open(current.id);
  }
  else $('err').textContent = (await res.json().catch(() => ({}))).error ?? `Отправить не удалось (${res.status})`;
  renderWindow();
  return res.ok;
}

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes))) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

const dangerousFile = (file) => /\.(exe|msi|com|scr|bat|cmd|ps1|vbs|js|jar|apk|appimage)$/i.test(file.name);
const editableImage = (file) => (file.type.startsWith('image/') && file.type !== 'image/svg+xml')
  || /\.(png|jpe?g|webp|gif)$/i.test(file.name);

function addFiles(files) {
  if (!canPermission('conversation:attachments') || !current) return;
  const incoming = [...files].filter((file) => file instanceof File);
  if (!incoming.length) return;
  if (pendingFiles.length + incoming.length > 10) return toast('За один раз можно отправить не больше 10 файлов');
  const tooLarge = incoming.find((file) => file.size > 45 * 1024 * 1024);
  if (tooLarge) return toast(`${tooLarge.name}: максимальный размер — 45 МБ`);
  for (const file of incoming) pendingFiles.push({ id:crypto.randomUUID(), file, originalFile:file, progress:0 });
  renderPendingFiles(); engageCurrent();
}

function removePending(id) {
  const item = pendingFiles.find((entry) => entry.id === id);
  if (item?.preview) URL.revokeObjectURL(item.preview);
  pendingFiles = pendingFiles.filter((entry) => entry.id !== id);
  renderPendingFiles();
}

function renderPendingFiles() {
  const box = $('pendingFiles'); box.innerHTML = ''; box.hidden = !pendingFiles.length;
  for (const item of pendingFiles) {
    const card = document.createElement('div'); card.className = 'pending-file'; card.dataset.pending = item.id;
    if (editableImage(item.file)) {
      item.preview ||= URL.createObjectURL(item.file);
      const image = document.createElement('img'); image.src = item.preview; image.alt = '';
      card.append(image);
    }
    const copy = document.createElement('div'); copy.className = 'pending-file-copy';
    const name = document.createElement('b'); name.textContent = item.file.name;
    const size = document.createElement('span'); size.textContent = formatBytes(item.file.size);
    const actions = document.createElement('span'); actions.className = 'pending-file-actions';
    if (editableImage(item.file)) {
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '✎'; edit.title = 'Редактировать';
      edit.onclick = () => openImageEditor(item.file, (edited) => {
        if (item.preview) URL.revokeObjectURL(item.preview);
        item.file = edited; item.preview = ''; renderPendingFiles();
      });
      actions.append(edit);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = 'Убрать';
    remove.onclick = () => removePending(item.id); actions.append(remove);
    copy.append(name, size, actions); card.append(copy);
    const meter = document.createElement('span'); meter.className = 'upload-meter';
    meter.innerHTML = `<i style="--upload:${Math.round(item.progress)}%"></i>`; card.append(meter); box.append(card);
  }
}

function uploadOne(item, batchId, batchSize, index, caption, dangerConfirmed) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/conversations/${current.id}/attachments`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/vnd.ai-support.attachment');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(item.file.name));
    xhr.setRequestHeader('X-File-Type', encodeURIComponent(item.file.type || 'application/octet-stream'));
    xhr.setRequestHeader('X-Upload-Batch', batchId);
    xhr.setRequestHeader('X-Upload-Batch-Size', String(batchSize));
    xhr.setRequestHeader('X-Upload-Index', String(index));
    if (caption) xhr.setRequestHeader('X-Caption', encodeURIComponent(caption));
    if (quoting?.id) xhr.setRequestHeader('X-Reply-To', encodeURIComponent(quoting.id));
    if (dangerConfirmed) xhr.setRequestHeader('X-Dangerous-Confirmed', 'yes');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) { item.progress = event.loaded / event.total * 100; renderPendingFiles(); }
    };
    xhr.onerror = () => reject(new Error('Нет связи с сервером'));
    xhr.onload = () => {
      let body = {}; try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `HTTP ${xhr.status}`));
    };
    xhr.send(item.file);
  });
}

async function sendPending() {
  if (uploadRunning || !pendingFiles.length || !current) return;
  if (!current.channel?.startsWith('tg_')) return toast('Bedolaga принимает только текстовые ответы');
  const risky = pendingFiles.filter((entry) => dangerousFile(entry.file));
  if (risky.length && !confirm(`Отправить потенциально исполняемые файлы (${risky.map(x => x.file.name).join(', ')})? Получатель должен доверять источнику.`)) return;
  uploadRunning = true; $('send').disabled = true; $('err').textContent = '';
  const batch = crypto.randomUUID().replaceAll('-', '_');
  const initial = [...pendingFiles];
  const text = $('input').value.trim();
  try {
    for (let index = 0; index < initial.length; index += 1) {
      const item = initial[index];
      await uploadOne(item, batch, initial.length, index, index === 0 && text.length <= 1024 ? text : '', dangerousFile(item.file));
      removePending(item.id);
    }
    if (text.length > 1024 && !await sendText(text)) throw new Error($('err').textContent || 'Текст не отправлен');
    else { $('input').value = ''; $('input').style.height = 'auto'; clearQuote(); }
    suggestion = null; renderSuggestion(); void open(current.id);
  } catch (err) {
    $('err').textContent = err.message || String(err);
  } finally {
    uploadRunning = false; renderWindow();
  }
}

function openImageEditorFromUrl(url, name) {
  fetch(url).then((response) => {
    if (!response.ok) throw new Error('Изображение недоступно');
    return response.blob();
  }).then((blob) => openImageEditor(new File([blob], name, { type:blob.type }), (edited) => addFiles([edited])))
    .catch((error) => toast(error.message));
}

async function openImageEditor(file, onSave) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return toast('Этот формат изображения нельзя отредактировать в браузере');
  if (bitmap.width * bitmap.height > 40_000_000) { bitmap.close(); return toast('Изображение слишком велико для редактора'); }
  const modal = document.createElement('div'); modal.className = 'image-editor'; modal.setAttribute('role','dialog'); modal.setAttribute('aria-modal','true');
  modal.innerHTML = `<div class="editor-tools"><b class="editor-title"></b>
    <button class="btn" data-tool="draw" title="Карандаш (D)">Карандаш</button><button class="btn" data-tool="line" title="Линия (L)">Линия</button>
    <button class="btn" data-tool="arrow" title="Стрелка (A)">Стрелка</button><button class="btn" data-tool="rect" title="Прямоугольник (R)">Рамка</button>
    <button class="btn" data-tool="ellipse" title="Эллипс (E)">Эллипс</button><button class="btn" data-tool="text" title="Текст (T)">Текст</button>
    <button class="btn" data-tool="pixel" title="Размытие / пикселизация (B)">Размытие</button><button class="btn" data-tool="crop" title="Обрезка (C)">Обрезать</button>
    <input class="editor-text-input" type="text" maxlength="120" placeholder="Текст для надписи" aria-label="Текст надписи">
    <input type="color" value="#ff3b5c" aria-label="Цвет"><input type="range" min="2" max="24" value="5" aria-label="Толщина">
    <button class="btn" data-action="undo" title="Ctrl+Z">↶</button><button class="btn" data-action="redo" title="Ctrl+Y">↷</button>
    <span class="editor-size"><input type="number" data-size="width" min="1" max="10000" aria-label="Ширина"><span>×</span><input type="number" data-size="height" min="1" max="10000" aria-label="Высота"><button class="btn" data-action="resize">Размер</button></span></div>
    <div class="editor-stage"><canvas></canvas></div><div class="editor-foot"><span class="hint">PNG-копия · Enter сохранить · Esc отменить</span><button class="btn" data-action="cancel">Отмена</button><button class="btn primary" data-action="save">Добавить к ответу</button></div>`;
  modal.querySelector('.editor-title').textContent = file.name;
  document.body.append(modal);
  const canvas = modal.querySelector('canvas'), ctx = canvas.getContext('2d', { willReadFrequently:true });
  canvas.width = bitmap.width; canvas.height = bitmap.height; ctx.drawImage(bitmap,0,0); bitmap.close();
  modal.querySelector('[data-size=width]').value=canvas.width; modal.querySelector('[data-size=height]').value=canvas.height;
  let tool = 'draw', drawing = false, start = null, before = null, undo = [], redo = [];
  const snapshot = () => { const c=document.createElement('canvas'); c.width=canvas.width;c.height=canvas.height;c.getContext('2d').drawImage(canvas,0,0);return c; };
  const restore = (snap) => { canvas.width=snap.width;canvas.height=snap.height;ctx.drawImage(snap,0,0); };
  const checkpoint = () => { undo.push(snapshot()); if (undo.length > 15) undo.shift(); redo=[]; };
  const point = (event) => { const r=canvas.getBoundingClientRect();return {x:(event.clientX-r.left)*canvas.width/r.width,y:(event.clientY-r.top)*canvas.height/r.height}; };
  const style = () => { ctx.strokeStyle=modal.querySelector('input[type=color]').value;ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=Number(modal.querySelector('input[type=range]').value);ctx.lineCap='round';ctx.lineJoin='round'; };
  const arrow = (a,b) => { ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();const angle=Math.atan2(b.y-a.y,b.x-a.x),size=Math.max(12,ctx.lineWidth*4);ctx.beginPath();ctx.moveTo(b.x,b.y);ctx.lineTo(b.x-size*Math.cos(angle-.45),b.y-size*Math.sin(angle-.45));ctx.moveTo(b.x,b.y);ctx.lineTo(b.x-size*Math.cos(angle+.45),b.y-size*Math.sin(angle+.45));ctx.stroke(); };
  const shape = (end) => { style(); if(tool==='line'){ctx.beginPath();ctx.moveTo(start.x,start.y);ctx.lineTo(end.x,end.y);ctx.stroke();} else if(tool==='arrow')arrow(start,end); else if(tool==='rect')ctx.strokeRect(start.x,start.y,end.x-start.x,end.y-start.y); else if(tool==='ellipse'){ctx.beginPath();ctx.ellipse((start.x+end.x)/2,(start.y+end.y)/2,Math.abs(end.x-start.x)/2,Math.abs(end.y-start.y)/2,0,0,Math.PI*2);ctx.stroke();} };
  canvas.onpointerdown = (event) => {
    const p=point(event); if(tool==='text'){const value=modal.querySelector('.editor-text-input').value.trim();if(!value)return toast('Введите текст в панели редактора');checkpoint();style();ctx.font=`${Math.max(18,ctx.lineWidth*5)}px sans-serif`;ctx.fillText(value,p.x,p.y);return; }
    drawing=true;start=p;checkpoint();before=ctx.getImageData(0,0,canvas.width,canvas.height);canvas.setPointerCapture(event.pointerId);if(tool==='draw'){style();ctx.beginPath();ctx.moveTo(p.x,p.y);}
  };
  canvas.onpointermove = (event) => { if(!drawing)return;const p=point(event);if(tool==='draw'){ctx.lineTo(p.x,p.y);ctx.stroke();start=p;}else if(['line','arrow','rect','ellipse'].includes(tool)){ctx.putImageData(before,0,0);shape(p);} };
  canvas.onpointerup = (event) => {
    if(!drawing)return;drawing=false;const end=point(event);
    if(tool==='pixel'){ctx.putImageData(before,0,0);const x=Math.floor(Math.min(start.x,end.x)),y=Math.floor(Math.min(start.y,end.y)),w=Math.floor(Math.abs(end.x-start.x)),h=Math.floor(Math.abs(end.y-start.y));if(w&&h){const data=ctx.getImageData(x,y,w,h),block=Math.max(8,Math.round(Math.min(w,h)/18));for(let yy=0;yy<h;yy+=block)for(let xx=0;xx<w;xx+=block){const i=(yy*w+xx)*4;ctx.fillStyle=`rgb(${data.data[i]},${data.data[i+1]},${data.data[i+2]})`;ctx.fillRect(x+xx,y+yy,block,block);}}}
    if(tool==='crop'){ctx.putImageData(before,0,0);const x=Math.floor(Math.min(start.x,end.x)),y=Math.floor(Math.min(start.y,end.y)),w=Math.floor(Math.abs(end.x-start.x)),h=Math.floor(Math.abs(end.y-start.y));if(w>2&&h>2){const data=ctx.getImageData(x,y,w,h);canvas.width=w;canvas.height=h;ctx.putImageData(data,0,0);modal.querySelector('[data-size=width]').value=w;modal.querySelector('[data-size=height]').value=h;}}
  };
  const selectTool = (next) => { tool=next;for(const button of modal.querySelectorAll('[data-tool]'))button.setAttribute('aria-pressed',String(button.dataset.tool===tool)); };
  for(const button of modal.querySelectorAll('[data-tool]')) button.onclick=()=>selectTool(button.dataset.tool); selectTool(tool);
  const close=()=>{document.removeEventListener('keydown',keys);modal.remove();};
  modal.querySelector('[data-action=cancel]').onclick=close;
  modal.querySelector('[data-action=undo]').onclick=()=>{if(!undo.length)return;redo.push(snapshot());restore(undo.pop());};
  modal.querySelector('[data-action=redo]').onclick=()=>{if(!redo.length)return;undo.push(snapshot());restore(redo.pop());};
  modal.querySelector('[data-action=resize]').onclick=()=>{const w=Number(modal.querySelector('[data-size=width]').value),h=Number(modal.querySelector('[data-size=height]').value);if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w*h>40000000)return toast('Недопустимый размер');checkpoint();const old=snapshot();canvas.width=w;canvas.height=h;ctx.drawImage(old,0,0,w,h);};
  const save=()=>canvas.toBlob((blob)=>{if(!blob)return toast('Не удалось создать PNG');const base=file.name.replace(/\.[^.]+$/,'')||'image';onSave(new File([blob],`${base}-edited.png`,{type:'image/png'}));close();},'image/png');
  modal.querySelector('[data-action=save]').onclick=save;
  const shortcuts={d:'draw',l:'line',a:'arrow',r:'rect',e:'ellipse',t:'text',b:'pixel',c:'crop'};
  const keys=(event)=>{if(event.key==='Escape')return close();if(event.target instanceof HTMLInputElement&&!event.ctrlKey&&!event.metaKey)return;else if(event.key==='Enter'&&!event.ctrlKey&&!event.metaKey)save();else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();modal.querySelector(`[data-action=${event.shiftKey?'redo':'undo'}]`).click();}else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y'){event.preventDefault();modal.querySelector('[data-action=redo]').click();}else if(shortcuts[event.key.toLowerCase()])selectTool(shortcuts[event.key.toLowerCase()]);};
  document.addEventListener('keydown',keys);
}

async function captureScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('Браузер не поддерживает снимок экрана');
  try {
    const stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false}),video=document.createElement('video');video.srcObject=stream;await video.play();
    const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);stream.getTracks().forEach(track=>track.stop());
    canvas.toBlob((blob)=>blob&&openImageEditor(new File([blob],`screenshot-${Date.now()}.png`,{type:'image/png'}),(edited)=>addFiles([edited])),'image/png');
  } catch (error) { if(error.name!=='NotAllowedError')toast('Снимок экрана не создан'); }
}

$('send').onclick = () => {
  if (pendingFiles.length) return sendPending();
  const text = $('input').value;
  const edited = suggestion && text.trim() && text.trim() !== suggestion.text.trim();
  sendText(text, edited ? { suggestionId: suggestion.id, edited: true } : {});
};
$('attachBtn').onclick = () => $('filePicker').click();
$('filePicker').onchange = (event) => { addFiles(event.target.files); event.target.value = ''; };
$('captureBtn').onclick = captureScreen;
for (const eventName of ['dragenter','dragover']) $('composer').addEventListener(eventName, (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return; event.preventDefault(); $('composer').classList.add('dragging');
});
for (const eventName of ['dragleave','drop']) $('composer').addEventListener(eventName, (event) => {
  $('composer').classList.remove('dragging'); if(eventName==='drop'&&event.dataTransfer?.files?.length){event.preventDefault();addFiles(event.dataTransfer.files);}
});
$('input').addEventListener('paste', (event) => {
  const files=[...(event.clipboardData?.items ?? [])].filter((item)=>item.kind==='file').map((item)=>item.getAsFile()).filter(Boolean);
  if(files.length){event.preventDefault();addFiles(files);}
});
document.addEventListener('keydown', (event) => {
  if(document.querySelector('.image-editor'))return;
  if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='u'){event.preventDefault();$('filePicker').click();}
  if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='s'){event.preventDefault();captureScreen();}
});
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('send').click(); });
$('input').addEventListener('focus', heartbeatCurrent);
$('input').addEventListener('input', (e) => {
  if (e.target.value.trim()) engageCurrent(); else heartbeatCurrent();
  e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 148) + 'px';
});
$('noteBtn').onclick = async () => {
  if (!canPermission('conversation:notes')) return;
  const text = $('input').value.trim(); if (!text || !current) return;
  if (await mutate(`/api/conversations/${current.id}/note`,
    { method:'POST', body: JSON.stringify({ text }) }, 'Заметка добавлена')) {
    $('input').value = ''; open(current.id);
  }
};

async function setState(patch) {
  if (!current || !canPermission('conversation:status')) return;
  const externalName = current.channel === 'bedolaga' ? 'Bedolaga'
    : current.channel === 'minishop' ? 'MiniShop' : null;
  const externalStatus = externalName && patch.status
    ? patch.status === 'resolved' ? `Тикет закрыт и в ${externalName}`
      : patch.status === 'open' ? `Тикет открыт и в ${externalName}`
      : `Статус тикета синхронизирован с ${externalName}`
    : null;
  const data = await mutate(`/api/conversations/${current.id}/state`,
    { method:'POST', body: JSON.stringify(patch) }, externalStatus);
  if (!data) { paintHeader(current); return; }
  current = data.conversation;
  paintHeader(current);
  renderAiNote(); refresh();
}
$('statusSel').onchange = (e) => setState({ status: e.target.value });
$('contextStatusSel').onchange = (e) => setState({ status: e.target.value });
$('aiSel').onchange = (e) => setState({ aiMode: e.target.value });
$('escBtn').onclick = () => setState({ escalated: !current?.escalated });
$('handoffBtn').onclick = () => setState({ handoff: !current?.handoff_at });
$('hideConversationBtn').onclick = () => {
  if (!current) return;
  const id = current.id;
  confirmAction('Скрыть диалог из входящих?',
    'История сохранится. Если клиент напишет снова, диалог автоматически вернётся.', async () => {
      const data = await mutate(`/api/conversations/${id}/state`, {
        method:'POST', body:JSON.stringify({ hidden:true }),
      }, 'Диалог скрыт');
      if (data) removeLiveConversation(id);
    });
};
$('filters').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const changed = filter !== b.dataset.filter;
  filter = b.dataset.filter;
  for (const o of $('filters').children) o.setAttribute('aria-pressed', String(o === b));
  renderList();
  if (changed) animateContentChange($('list'));
};
$('listSearch').oninput = (e) => {
  listQuery = e.target.value.trim();
  renderList(true);
};
$('backToList').onclick = () => {
  $('inboxSplit').dataset.pane = 'list';
  history.replaceState(null, '', location.pathname + location.search);
  $('list').querySelector(`[data-id="${current?.id ?? ''}"]`)?.focus();
};
$('templates').onchange = (e) => {
  const found = templates.find(t => String(t.id) === e.target.value);
  if (found) { $('input').value = found.body; $('input').focus(); }
  e.target.value = '';
};

/* ═══ база знаний ═══ */
$('kbTabs').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tab === 'learning' && !canReview()) return;
  kbTab = b.dataset.tab;
  for (const o of $('kbTabs').children) o.setAttribute('aria-pressed', String(o === b));
  renderDocs();
  animateContentChange($('docs'));
  if (kbTab === 'interface') loadInterfaceKb().then((data) => { if (data && kbTab === 'interface') renderDocs(); });
};
async function loadDocs() {
  const [data, learning] = await Promise.all([
    json('/api/kb'),
    canReview() ? json('/api/learning/candidates?status=pending') : Promise.resolve(null),
  ]);
  if (data) {
    docs = { ...data, candidates: learning?.candidates ?? [] };
    if (canPermission('knowledge:read')) await loadInterfaceKb();
    renderDocs();
  }
  else if ($('view-kb').dataset.loaded !== 'true') $('docs').innerHTML = '<p class="empty">База знаний сейчас недоступна.</p>';
}
function renderDocs() {
  const reviewer = canReview();
  const editor = canPermission('knowledge:manage');
  if (!reviewer && kbTab === 'learning') kbTab = 'kb';
  const list = kbTab === 'kb' ? docs.kb : kbTab === 'interface' ? docs.interfaceScreens : kbTab === 'draft' ? docs.drafts : docs.candidates;
  $('cntKb').textContent = docs.kb.length;
  $('kbHint').textContent = kbTab === 'learning'
    ? 'AI ничего не публикует без решения lead/admin'
    : kbTab === 'draft'
    ? 'Черновики в ответы не идут, пока не опубликуешь'
    : kbTab === 'interface'
    ? `Проверенные инструкции русского интерфейса · ${docs.interfaceScreens.length} экранов в виде, который видит AI · включаются в настройках AI`
    : 'Правки подхватываются в течение 15 минут';
  const box = $('docs');
  if (kbTab === 'interface') return renderInterface(box);
  if (!list.length) {
    box.innerHTML = `<p class="empty">${kbTab === 'kb' ? 'Статей пока нет.' : kbTab === 'learning' ? 'Новых кандидатов на обучение нет.' : 'Черновиков нет. Соберите их из переписки.'}</p>`;
    return;
  }
  if (kbTab === 'learning') {
    box.innerHTML = list.map((d) => `<article class="doc-row review-row">
      <div class="doc-state"><span class="status-dot warning"></span></div><div class="doc-copy"><b>${esc(d.title)}</b><span>v${d.version} · ${esc(d.source)}${d.confidence == null ? '' : ` · уверенность ${Math.round(d.confidence * 100)}%`} · ${esc(d.file_name)}</span></div><div class="doc-actions">
        <button class="btn primary" data-approve="${d.id}">Проверено — опубликовать</button>
        <button class="btn danger" data-reject="${d.id}">Отклонить</button></div></article>`).join('');
    for (const b of box.querySelectorAll('[data-approve]')) b.onclick = async () => {
      if (await mutate(`/api/learning/candidates/${b.dataset.approve}`, { method:'POST', body:JSON.stringify({ decision:'approved' }) }, 'Материал опубликован')) loadDocs();
    };
    for (const b of box.querySelectorAll('[data-reject]')) b.onclick = async () => {
      if (await mutate(`/api/learning/candidates/${b.dataset.reject}`, { method:'POST', body:JSON.stringify({ decision:'rejected' }) }, 'Кандидат отклонён')) loadDocs();
    };
    return;
  }
  box.innerHTML = list.map((d) => `<article class="doc-row" data-doc="${esc(d.name)}" data-edit="${esc(d.name)}" role="button" tabindex="0" aria-label="Открыть статью: ${esc(d.title)}">
    <div class="doc-state"><span class="status-dot ${kbTab === 'kb' ? 'ok' : ''}"></span></div><div class="doc-copy"><b>${esc(d.title)}</b><span>${esc(d.name)} · ${d.size} симв.</span></div>
    <div class="doc-actions">${editor && kbTab === 'draft' ? `<button class="btn primary" data-pub="${esc(d.name)}">Опубликовать</button>` : ''}
      ${editor ? `<button class="icon-btn row-more danger" data-del="${esc(d.name)}" aria-label="Удалить статью" title="Удалить">×</button>` : ''}<span class="doc-disclosure" aria-hidden="true">›</span></div></article>`).join('');
  for (const row of box.querySelectorAll('.doc-row[data-edit]')) {
    row.onclick = (event) => { if (!event.target.closest('button')) editDoc(row.dataset.edit); };
    row.onkeydown = (event) => { if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('button')) { event.preventDefault(); editDoc(row.dataset.edit); } };
  }
  for (const b of box.querySelectorAll('[data-pub]')) b.onclick = async () => {
    b.disabled = true;
    const done = await mutate(`/api/kb/publish/${encodeURIComponent(b.dataset.pub)}`, { method:'POST' }, 'Опубликовано');
    b.disabled = false;
    if (done) loadDocs();
  };
  for (const b of box.querySelectorAll('[data-del]')) b.onclick = () => confirmAction('Удалить статью?', b.dataset.del, async () => {
    if (await mutate(`/api/kb/${kbTab}/${encodeURIComponent(b.dataset.del)}`, { method:'DELETE' }, 'Удалено')) loadDocs();
  });
}
async function editDoc(name) {
  const data = await json(`/api/kb/${kbTab}/${encodeURIComponent(name)}`);
  if (!data) return;
  sheet(name, `<textarea id="docText" ${canPermission('knowledge:manage') ? '' : 'readonly'}>${esc(data.text)}</textarea>`,
    canPermission('knowledge:manage') ? `<button class="btn" id="cancel">Отмена</button><button class="btn primary" id="save">Сохранить</button>` : '<button class="btn primary" id="cancel">Закрыть</button>');
  $('cancel').onclick = closeSheet;
  if (!canPermission('knowledge:manage')) return;
  $('save').onclick = async () => {
    const saved = await mutate(`/api/kb/${kbTab}/${encodeURIComponent(name)}`,
      { method:'PUT', body: JSON.stringify({ text: $('docText').value }) }, 'Сохранено');
    if (saved) { closeSheet(); loadDocs(); }
  };
}
$('newDoc').onclick = () => {
  if (!canPermission('knowledge:manage')) return;
  sheet('Новая статья',
    `<div class="frow"><label>Заголовок</label><input type="text" id="nTitle" placeholder="Не работает на роутере"></div>
     <div class="frow"><label>Текст</label><textarea id="nText" placeholder="Что отвечать оператору в этом случае"></textarea></div>`,
    `<button class="btn" id="cancel">Отмена</button><button class="btn primary" id="create">Создать</button>`);
  $('cancel').onclick = closeSheet;
  $('create').onclick = async () => {
    const created = await mutate('/api/kb',
      { method:'POST', body: JSON.stringify({ title: $('nTitle').value, text: $('nText').value }) }, 'Статья создана');
    if (created) { closeSheet(); loadDocs(); }
  };
};

/* ═══ справочник интерфейса Бедолаги ═══ */
let ifaceKb = null, ifaceMode = null, ifaceLoading = false;
const IFACE_LABELS = { full:'Полный вид', lite:'Простой вид' };
const IFACE_FIELDS = ['title','routeDescription','keywords','instructions','caption','image'];
const IFACE_MAX_IMAGE = 8 * 1024 * 1024;
const ifaceImageUrl = (image) => '/api/interface-kb/images/' + String(image).split('/').map(encodeURIComponent).join('/');
const ifaceNorm = (field, value) => (field === 'keywords' || field === 'instructions')
  ? (Array.isArray(value) ? value : [])
  : String(value ?? '').trim();
const ifaceSame = (field, a, b) => JSON.stringify(ifaceNorm(field, a)) === JSON.stringify(ifaceNorm(field, b));
const ifaceText = (field, value) => (field === 'keywords' ? ifaceNorm(field, value).join(', ')
  : field === 'instructions' ? ifaceNorm(field, value).join('\n') : ifaceNorm(field, value));

async function loadInterfaceKb() {
  const data = await json('/api/interface-kb');
  if (data) {
    ifaceKb = data;
    if (!ifaceMode || !data.modes.includes(ifaceMode)) ifaceMode = data.effectiveMode;
    const count = (data.resolved?.[data.effectiveMode] ?? []).length;
    $('ifaceTabNote').textContent = count ? `${count} проверенных инструкций` : 'Проверенные инструкции';
  }
  return data;
}

/** Значение экрана «по умолчанию» в выбранном виде: поставка плюс её же отличия вида. */
function ifaceShippedScreen(id, mode) {
  const base = (ifaceKb.shipped?.screens ?? []).find((item) => item?.id === id);
  if (!base || ((base.only === 'full' || base.only === 'lite') && base.only !== mode)) return null;
  return { ...base, ...(base.modes?.[mode] ?? {}) };
}

function ifaceRows(mode) {
  const overrides = ifaceKb.overrides;
  const resolved = new Map(ifaceKb.resolved[mode].map((screen) => [screen.id, screen]));
  const rows = new Map();
  for (const base of ifaceKb.shipped?.screens ?? []) {
    const std = ifaceShippedScreen(base.id, mode);
    if (!std) continue;
    const own = overrides.screens[base.id];
    rows.set(base.id, { id: base.id, custom: false, hidden: Boolean(own?.hidden), std,
      screen: resolved.get(base.id) ?? std, edited: Boolean(own && (own.all || own[mode])) });
  }
  for (const item of overrides.added) {
    if (item.only && item.only !== mode) continue;
    const screen = resolved.get(item.id);
    if (screen) rows.set(item.id, { id: item.id, custom: true, hidden: false, std: null, screen, edited: false });
  }
  return [...rows.values()];
}

function ifaceBadge() {
  const label = IFACE_LABELS[ifaceKb.effectiveMode];
  if (ifaceKb.setting !== 'auto') return `У магазина сейчас: ${label} (задан вручную в настройках)`;
  if (ifaceKb.detected) return `У магазина сейчас: ${IFACE_LABELS[ifaceKb.detected.mode]} (определён автоматически)`;
  return `Вид кабинета не определён — AI использует ${label}`;
}

function renderInterface(box) {
  if (!ifaceKb) {
    box.innerHTML = '<p class="empty">Загрузка справочника…</p>';
    if (!ifaceLoading) {
      ifaceLoading = true;
      loadInterfaceKb().then((data) => {
        ifaceLoading = false;
        if (kbTab !== 'interface') return;
        if (data) renderDocs(); else box.innerHTML = '<p class="empty">Справочник интерфейса сейчас недоступен.</p>';
      });
    }
    return;
  }
  const editor = canPermission('knowledge:manage');
  const rows = ifaceRows(ifaceMode);
  box.innerHTML = `<div class="iface-bar">
      <div class="seg" role="group" aria-label="Вид кабинета">${ifaceKb.modes.map((mode) =>
        `<button type="button" data-iface-mode="${mode}" aria-pressed="${mode === ifaceMode}">${IFACE_LABELS[mode]}</button>`).join('')}</div>
      <span class="iface-live" id="ifaceLive">${esc(ifaceBadge())}</span>
      ${editor ? '<button class="btn" type="button" data-iface-add>Добавить свой экран</button>' : ''}
    </div>
    ${ifaceKb.enabled ? '' : '<p class="iface-note">AI пока не использует справочник: включите его в настройках («Включить базу знаний интерфейса Бедолаги»).</p>'}
    ${ifaceKb.shipped ? '' : '<p class="iface-note">Поставляемый справочник не найден — доступны только свои экраны.</p>'}
    ${rows.length ? rows.map((row) => `<article class="doc-row iface-row${row.hidden ? ' is-hidden' : ''}" data-iface-id="${esc(row.id)}"
        ${row.hidden ? '' : `role="button" tabindex="0" aria-label="Открыть экран: ${esc(row.screen.title)}"`}>
      <div class="doc-state"><span class="status-dot ${row.hidden ? '' : 'ok'}"></span></div>
      <div class="doc-copy"><b>${esc(row.screen.title)}</b><span>${esc(row.screen.routeDescription)}</span></div>
      <div class="doc-actions">
        ${row.custom ? '<span class="iface-tag">свой экран</span>' : ''}
        ${row.edited ? '<span class="iface-tag changed">изменён</span>' : ''}
        ${row.hidden ? '<span class="iface-tag muted">скрыт</span>' : ''}
        ${row.hidden && editor ? '<button class="btn" type="button" data-iface-unhide>Вернуть</button>' : '<span class="doc-disclosure" aria-hidden="true">›</span>'}
      </div></article>`).join('') : '<p class="empty">В этом виде экранов пока нет.</p>'}`;
  for (const button of box.querySelectorAll('[data-iface-mode]')) button.onclick = () => {
    ifaceMode = button.dataset.ifaceMode; renderDocs(); animateContentChange($('docs'));
  };
  const add = box.querySelector('[data-iface-add]');
  if (add) add.onclick = () => openInterfaceEditor(null);
  for (const row of box.querySelectorAll('.iface-row:not(.is-hidden)')) {
    row.onclick = () => openInterfaceEditor(row.dataset.ifaceId);
    row.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openInterfaceEditor(row.dataset.ifaceId); } };
  }
  for (const button of box.querySelectorAll('[data-iface-unhide]')) button.onclick = (event) => {
    event.stopPropagation();
    const id = button.closest('.iface-row').dataset.ifaceId;
    saveInterfaceOverrides((next) => {
      delete next.screens[id].hidden;
      if (!Object.keys(next.screens[id]).length) delete next.screens[id];
    }, 'Экран возвращён');
  };
}

/** Применяет правку к копии оверрайдов, сохраняет на сервере и перерисовывает вкладку. */
async function saveInterfaceOverrides(change, okText) {
  const next = JSON.parse(JSON.stringify(ifaceKb.overrides));
  change(next);
  const saved = await mutate('/api/interface-kb/overrides', { method:'PUT', body: JSON.stringify(next) }, okText);
  if (!saved) return false;
  closeSheet();
  await loadDocs();
  return true;
}

function openInterfaceEditor(id) {
  const mode = ifaceMode;
  const editor = canPermission('knowledge:manage');
  const row = id ? ifaceRows(mode).find((item) => item.id === id) : null;
  if (id && !row) return;
  const custom = !row || row.custom;
  const cur = row ? row.screen : {};
  const std = row?.std ?? null;
  const own = row && !custom ? ifaceKb.overrides.screens[id] : null;
  const dis = editor ? '' : ' disabled';
  const textFields = [
    ['title', 'Название экрана', 'input', 160],
    ['routeDescription', 'Где находится', 'input', 500],
    ['keywords', 'Ключевые слова (через запятую)', 'input', 2000],
    ['instructions', 'Инструкция (один шаг на строку)', 'textarea', 0],
    ['caption', 'Подпись к картинке', 'input', 500],
  ];
  const fieldHtml = textFields.map(([field, label, kind, max]) => `<div class="frow">
      <label for="iface-${field}">${label}${std ? `<span class="iface-changed" data-changed="${field}" hidden> · изменено</span>` : ''}</label>
      ${kind === 'input'
        ? `<input type="text" id="iface-${field}" data-f="${field}" value="${esc(ifaceText(field, cur[field]))}"${max ? ` maxlength="${max}"` : ''}${dis}>`
        : `<textarea id="iface-${field}" data-f="${field}" rows="9"${dis}>${esc(ifaceText(field, cur[field]))}</textarea>`}
      ${std ? `<div class="iface-default" data-default="${field}" hidden><span>Стандартно:</span>
        <q>${esc(ifaceText(field, std[field]) || '— пусто —')}</q>${editor ? `<button class="btn quiet" type="button" data-restore="${field}">Вернуть стандартное</button>` : ''}</div>` : ''}
    </div>`).join('');
  const scope = custom
    ? `<div class="frow"><label for="iface-scope">Показывать</label><select id="iface-scope" data-scope${dis}>
         <option value="">В обоих видах</option><option value="full">Только в полном виде</option><option value="lite">Только в простом виде</option></select></div>`
    : `<div class="frow"><label for="iface-scope">К чему применить правку</label><select id="iface-scope" data-scope${dis}>
         <option value="all">Оба вида</option><option value="${mode}">Только ${IFACE_LABELS[mode].toLowerCase()}</option></select>
         <span class="hint">Если экран в видах устроен по-разному, безопаснее править только текущий вид.</span></div>`;
  sheet(row ? row.screen.title : 'Новый экран',
    `<div class="iface-form">${scope}${fieldHtml}
      <div class="frow"><label>Картинка${std ? '<span class="iface-changed" data-changed="image" hidden> · изменено</span>' : ''}</label>
        <div class="iface-image"><img data-preview alt="Превью картинки" hidden><span class="hint" data-noimage>Без картинки</span></div>
        ${editor ? `<div class="iface-image-actions"><button class="btn" type="button" data-pick>Загрузить картинку</button>
          <button class="btn" type="button" data-remove-image>Убрать</button>
          <input type="file" data-file accept="image/png,image/jpeg,image/webp" hidden></div>
          <span class="hint">PNG, JPEG или WebP до 8 МБ. Файл хранится в данных этой установки.</span>` : ''}
        ${std ? '<div class="iface-default" data-default="image" hidden><span>Стандартно:</span> <q data-default-image></q>' + (editor ? '<button class="btn quiet" type="button" data-restore="image">Вернуть стандартное</button>' : '') + '</div>' : ''}
      </div></div>`,
    editor
      ? `${own ? '<button class="btn" type="button" data-reset>Сбросить к стандартному</button>' : ''}
         ${row ? `<button class="btn danger" type="button" data-hide>${custom ? 'Удалить экран' : 'Скрыть экран'}</button>` : ''}
         <button class="btn" type="button" id="cancel">Отмена</button><button class="btn primary" type="button" data-save>Сохранить</button>`
      : '<button class="btn primary" type="button" id="cancel">Закрыть</button>', 'wide');
  const root = $('sheet');
  const q = (selector) => root.querySelector(selector);
  $('cancel').onclick = closeSheet;

  let image = cur.image ?? null;
  const preview = q('[data-preview]');
  const setImage = (value) => {
    image = value || null;
    preview.hidden = !image;
    q('[data-noimage]').hidden = Boolean(image);
    const remove = q('[data-remove-image]'); if (remove) remove.disabled = !image;
    if (image) { delete preview.dataset.retry; preview.src = ifaceImageUrl(image); } else preview.removeAttribute('src');
    refreshDefaults();
  };
  preview.onerror = async () => {
    // Cookie-билет мог истечь: обновляем его и пробуем один раз.
    if (preview.dataset.retry) return;
    preview.dataset.retry = '1';
    await refreshTicket();
    reloadMedia(preview);
  };
  const form = () => ({
    title: q('[data-f="title"]').value.trim(),
    routeDescription: q('[data-f="routeDescription"]').value.trim(),
    keywords: q('[data-f="keywords"]').value.split(/[,;\n]/).map((word) => word.trim()).filter(Boolean),
    instructions: q('[data-f="instructions"]').value.split('\n').map((step) => step.trim()).filter(Boolean),
    caption: q('[data-f="caption"]').value.trim(),
    image,
  });
  function refreshDefaults() {
    if (!std) return;
    const value = form();
    for (const field of IFACE_FIELDS) {
      const differs = !ifaceSame(field, value[field], std[field]);
      const hint = q(`[data-default="${field}"]`), mark = q(`[data-changed="${field}"]`);
      if (hint) hint.hidden = !differs;
      if (mark) mark.hidden = !differs;
    }
  }
  for (const input of root.querySelectorAll('[data-f]')) input.oninput = refreshDefaults;
  for (const button of root.querySelectorAll('[data-restore]')) button.onclick = () => {
    const field = button.dataset.restore;
    if (field === 'image') setImage(std.image ?? null);
    else { q(`[data-f="${field}"]`).value = ifaceText(field, std[field]); refreshDefaults(); }
  };
  if (std) {
    const defaultImage = q('[data-default-image]');
    if (defaultImage) defaultImage.textContent = std.image ? 'картинка из поставки' : '— без картинки —';
  }
  setImage(image);
  if (!editor) return;

  const file = q('[data-file]');
  q('[data-pick]').onclick = () => file.click();
  q('[data-remove-image]').onclick = () => setImage(null);
  file.onchange = async () => {
    const picked = file.files?.[0]; file.value = '';
    if (!picked) return;
    if (picked.size > IFACE_MAX_IMAGE) return toast('Картинка больше 8 МБ');
    q('[data-pick]').disabled = true;
    try {
      const res = await api('/api/interface-kb/images', { method:'POST', headers:{ 'content-type':'application/vnd.ai-support.attachment' }, body: picked });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.image) setImage(body.image); else toast(body.error ?? `Не удалось загрузить картинку (${res.status})`);
    } catch (err) { toast(`Нет связи с сервером: ${err.message}`); }
    q('[data-pick]').disabled = false;
  };
  const scopeSelect = q('[data-scope]');
  if (custom && row) scopeSelect.value = ifaceKb.overrides.added.find((item) => item.id === id)?.only ?? '';
  else if (own && own[mode] && !own.all) scopeSelect.value = mode;

  const reset = q('[data-reset]');
  if (reset) reset.onclick = () => confirmAction('Сбросить экран к стандартному?', `«${row.screen.title}»: все правки этой установки для обоих видов будут удалены.`,
    () => saveInterfaceOverrides((next) => { const entry = next.screens[id]; if (entry) { delete entry.all; delete entry.full; delete entry.lite; if (!entry.hidden) delete next.screens[id]; } }, 'Сброшено'));
  const hide = q('[data-hide]');
  if (hide) hide.onclick = () => custom
    ? confirmAction('Удалить свой экран?', `«${row.screen.title}» будет удалён безвозвратно.`,
      () => saveInterfaceOverrides((next) => { next.added = next.added.filter((item) => item.id !== id); }, 'Экран удалён'))
    : saveInterfaceOverrides((next) => { (next.screens[id] ??= {}).hidden = true; }, 'Экран скрыт — AI его не использует');

  q('[data-save]').onclick = () => {
    const value = form();
    if (!value.title || !value.routeDescription) return toast('Заполните название и «Где находится»');
    if (!value.instructions.length) return toast('Нужен хотя бы один шаг инструкции');
    if (value.instructions.length > 30 || value.instructions.some((step) => step.length > 600)) return toast('Не больше 30 шагов, каждый до 600 символов');
    if (value.keywords.length > 30 || value.keywords.some((word) => word.length > 80)) return toast('Не больше 30 ключевых слов, каждое до 80 символов');
    if (custom) {
      const item = { id: id ?? `own-${Date.now().toString(36)}`, title: value.title, routeDescription: value.routeDescription,
        keywords: value.keywords, instructions: value.instructions };
      if (value.caption) item.caption = value.caption;
      if (value.image) item.image = value.image;
      if (scopeSelect.value) item.only = scopeSelect.value;
      return saveInterfaceOverrides((next) => {
        const at = next.added.findIndex((entry) => entry.id === item.id);
        if (at >= 0) next.added[at] = item; else next.added.push(item);
      }, 'Экран сохранён');
    }
    const target = scopeSelect.value;
    return saveInterfaceOverrides((next) => {
      const entry = (next.screens[id] ??= {});
      const patch = (entry[target] ??= {});
      for (const field of IFACE_FIELDS) {
        if (ifaceSame(field, value[field], cur[field])) continue;
        // null снимает значение: так убираются подпись и картинка из поставки.
        patch[field] = (field === 'caption' || field === 'image') ? (value[field] || null) : value[field];
      }
      if (!Object.keys(patch).length) delete entry[target];
      if (!Object.keys(entry).length) delete next.screens[id];
    }, 'Сохранено');
  };
}

function mineStarted() {
  $('mineLog').innerHTML = '<div class="cap" style="margin-top:var(--sp-6)">Сбор идёт</div><div class="log" id="logBox">Запускаю…</div>';
}
$('mineBtn').onclick = () => {
  if (!canPermission('knowledge:mine')) return;
  sheet('Собрать базу знаний из переписки',
    `<p class="hint">Модель прочитает реальные обращения и напишет статьи. Они лягут в черновики — клиентам ничего не уйдёт, пока их не опубликуешь.</p>
     <div class="frow"><label>Источник</label><select id="mSource">
       <option value="archive">Закрытые тикеты бедолаги</option>
       <option value="panel">Диалоги, где предложку отклонили</option>
       <option value="export">Выгрузка Telegram Desktop</option></select></div>
     <div class="frow" id="mLimitRow"><label>Сколько взять</label><input type="number" id="mLimit" value="200" min="10" max="1000"></div>
     <div class="frow" id="mFileRow" hidden>
       <label>Файл result.json</label>
       <input type="file" id="mFile" accept=".json,application/json" style="height:auto;padding:var(--sp-2) var(--sp-3)">
       <span class="hint">Telegram Desktop → Настройки → Экспорт данных → формат JSON.</span>
     </div>
     <div class="frow" id="mMeRow" hidden><label>Чьи сообщения — ваши</label><select id="mMe"></select></div>`,
    `<button class="btn" id="cancel">Отмена</button><button class="btn primary" id="run">Запустить</button>`);
  $('cancel').onclick = closeSheet;
  $('mSource').onchange = () => {
    const isExport = $('mSource').value === 'export';
    $('mLimitRow').hidden = isExport;
    $('mFileRow').hidden = !isExport;
    $('mMeRow').hidden = true;
  };
  $('run').onclick = async () => {
    if ($('mSource').value === 'export') return runExport();
    const body = { source: $('mSource').value, limit: Number($('mLimit').value) };
    const started = await mutate('/api/kb/mine', { method:'POST', body: JSON.stringify(body) });
    if (started) { closeSheet(); mineStarted(); }
  };
};

/**
 * Выгрузка идёт сырым телом: экспорт бывает в десятки мегабайт, и оборачивать
 * его в JSON-конверт незачем. Первый заход возвращает список участников —
 * какие сообщения наши, из файла не видно.
 */
async function runExport() {
  const file = $('mFile').files?.[0];
  if (!file) return toast('Выберите файл');
  const me = $('mMeRow').hidden ? '' : $('mMe').value;
  $('run').disabled = true;
  const res = await fetch(`/api/kb/mine/export${me ? `?me=${encodeURIComponent(me)}` : ''}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body: file,
  });
  $('run').disabled = false;
  if (!res.ok) return toast((await res.json()).error ?? 'Не разобралось');
  const data = await res.json();
  if (data.needsMe) {
    $('mMeRow').hidden = false;
    $('mMe').innerHTML = data.participants.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    toast('Выберите, чьи сообщения ваши, и запустите снова');
    return;
  }
  closeSheet(); mineStarted();
  toast(`Из «${data.chatName}»: ${data.pairs} пар`);
}

/* ═══ песочница ═══ */
$('pingBtn').onclick = async () => {
  $('pingBtn').disabled = true;
  const res = await api('/api/ai/ping', { method:'POST' });
  const body = await res.json().catch(() => ({}));
  $('pingBtn').disabled = false;
  toast(res.ok
    ? `Связь есть: ${body.model}, ${body.ms} мс, ключей ${body.keys?.total ?? 1}`
    : `Нет связи: ${body.error ?? res.status}`);
};

$('labRun').onclick = async () => {
  const text = $('labInput').value.trim();
  if (!text) return toast('Введите вопрос');
  $('labRun').disabled = true;
  $('labNote').textContent = 'Спрашиваю модель…';
  const res = await api('/api/ai/try', { method:'POST', body: JSON.stringify({ text }) });
  const body = await res.json().catch(() => ({}));
  $('labRun').disabled = false;
  $('labNote').textContent = '';

  if (!res.ok) { $('labOut').innerHTML = `<div class="group"><div class="item"><span class="hint">${esc(body.error ?? 'Не получилось')}</span></div></div>`; return; }

  const d = body.draft;
  const pct = d.confidence == null ? 0 : Math.round(d.confidence * 100);
  const verdict = body.verdict?.action === 'auto'
    ? 'ушёл бы клиенту сам'
    : body.verdict?.action === 'skip' ? 'не ушёл бы: окно закрыто' : 'лёг бы предложкой оператору';
  $('labOut').innerHTML = `
    <div class="cap">Ответ модели</div>
    <div class="group">
      <div class="item col-item"><div style="white-space:pre-wrap; font-size:13px">${esc(d.reply || '(пусто)')}</div></div>
      <div class="item"><span class="lbl">Уверенность</span><span class="val mono">${pct}%</span></div>
      <div class="item"><span class="lbl">Просит человека</span><span class="val mono">${d.needsHuman ? 'да' : 'нет'}</span></div>
      <div class="item"><span class="lbl">Обращения нет</span><span class="val mono">${d.noRequest ? 'да' : 'нет'}</span></div>
      <div class="item"><span class="lbl">В боевом режиме</span><span class="val">${esc(verdict)}${body.verdict?.reason ? ` · ${esc(body.verdict.reason)}` : ''}</span></div>
      <div class="item"><span class="lbl">Модель · время</span><span class="val mono">${esc(body.model)} · ${body.ms} мс</span></div>
      ${d.reason ? `<div class="item"><span class="lbl">Пояснение модели</span><span class="val">${esc(d.reason)}</span></div>` : ''}
    </div>
    <div class="cap" style="margin-top:var(--sp-5)">Что нашлось в базе знаний</div>
    <div class="group">${body.sources?.length
      ? body.sources.map((x) => `<div class="item"><span class="lbl">${esc(x)}</span>${body.usedSources?.includes(x) ? '<span class="badge ok">использовано</span>' : ''}</div>`).join('')
      : '<div class="item"><span class="hint">Ничего — значит ответ построен вслепую.</span></div>'}</div>`;
};

/* ═══ серверы ═══
   Тот же слепок, который видит модель: если здесь пусто, она тоже ничего
   не знает и обязана так и сказать. */
function countryFlag(raw) {
  const aliases = { DEU:'DE', GER:'DE', USA:'US', GBR:'GB', UK:'GB', NLD:'NL', FRA:'FR',
    FIN:'FI', SWE:'SE', NOR:'NO', POL:'PL', AUT:'AT', CHE:'CH', ESP:'ES', ITA:'IT',
    CAN:'CA', JPN:'JP', SGP:'SG', TUR:'TR', KAZ:'KZ', RUS:'RU', UKR:'UA' };
  const code = aliases[raw] ?? raw;
  return /^[A-Z]{2}$/.test(code) ? code : '—';
}

async function loadNodes() {
  const nodesWritable = canPermission('settings:nodes');
  $('nodesRefresh').disabled = !nodesWritable;
  $('nodesRefresh').title = nodesWritable ? '' : 'Обновление серверов доступно только администратору';
  const box = $('nodesBody');
  box.setAttribute('aria-busy', 'true');
  if ($('view-nodes').dataset.loaded !== 'true') {
    box.innerHTML = `<div class="nodes-loading" aria-label="Загружаю состояние серверов">
      <div class="nodes-summary">${Array.from({ length:4 }, () => '<span class="node-kpi skeleton-card"></span>').join('')}</div>
      <div class="nodes-panel skeleton-panel"><i></i><i></i><i></i></div>
    </div>`;
  }
  let res;
  try { res = await api('/api/nodes'); }
  catch (err) {
    box.removeAttribute('aria-busy');
    box.innerHTML = `<div class="nodes-state error-state"><span class="state-icon">!</span><h2>Не удалось связаться с мониторингом</h2><p>${esc(err.message)}</p><button class="btn" data-node-retry>Попробовать снова</button></div>`;
    box.querySelector('[data-node-retry]').onclick = loadNodes;
    $('nodesNote').textContent = 'нет связи';
    return;
  }
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))).error ?? `Ошибка ${res.status}`;
    const disabled = res.status === 501;
    box.removeAttribute('aria-busy');
    box.innerHTML = `<div class="nodes-state ${disabled ? 'disabled-state' : 'error-state'}"><span class="state-icon">${disabled ? '—' : '!'}</span>
      <h2>${disabled ? 'Мониторинг серверов выключен' : 'Данные серверов недоступны'}</h2><p>${esc(error)}</p>
      ${disabled ? '' : '<button class="btn" data-node-retry>Попробовать снова</button>'}</div>`;
    box.querySelector('[data-node-retry]')?.addEventListener('click', loadNodes);
    $('nodesNote').textContent = '';
    return;
  }
  const data = await res.json();
  box.removeAttribute('aria-busy');
  const online = data.nodes.filter((n) => n.online && !n.disabled).length;
  const disabled = data.nodes.filter((n) => n.disabled).length;
  const offline = data.nodes.filter((n) => !n.online && !n.disabled).length;
  const users = data.nodes.reduce((sum, n) => sum + (n.usersOnline ?? 0), 0);
  $('cntNodes').textContent = offline ? String(offline) : '';
  $('nodesNote').textContent = data.at
    ? `обновлено ${fmtTime(data.at)}`
    : 'данных нет';

  if (!data.nodes.length) {
    box.innerHTML = '<div class="nodes-state"><span class="state-icon">0</span><h2>Список узлов пуст</h2><p>Модель тоже не получает сведений о состоянии серверов.</p></div>';
    return;
  }
  box.innerHTML = `
    <div class="nodes-shell">
      ${data.error ? `<div class="nodes-alert" role="status"><span class="nodes-alert-icon">!</span><div><b>Не удалось обновить данные</b><span>Показан последний успешный слепок${data.at ? ` от ${fmtTime(data.at)}` : ''} · ${esc(data.error)}</span></div></div>` : ''}
      <div class="nodes-summary" aria-label="Сводка по серверам">
        <article class="node-kpi online"><span>Работают</span><strong>${online}</strong><small>из ${data.nodes.length} узлов</small></article>
        <article class="node-kpi ${offline ? 'danger' : 'quiet'}"><span>Требуют внимания</span><strong>${offline}</strong><small>${offline ? 'недоступны сейчас' : 'всё спокойно'}</small></article>
        <article class="node-kpi quiet"><span>Отключены</span><strong>${disabled}</strong><small>администратором</small></article>
        <article class="node-kpi accent"><span>Подключения сейчас</span><strong>${users}</strong><small>активных клиентов</small></article>
      </div>
      <section class="nodes-panel">
        <header class="nodes-panel-head"><div><h2>Состояние узлов</h2><p>Псевдоним — имя, которое увидят AI и клиент.</p></div><span>${data.at ? `Слепок ${fmtTime(data.at)}` : 'Время неизвестно'}</span></header>
        <div class="node-table" role="table" aria-label="Список серверов">
          <div class="node-table-head" role="row"><span role="columnheader">Сервер и имя для AI</span><span role="columnheader">Состояние</span><span role="columnheader">Пользователи</span><span role="columnheader">Трафик</span></div>
          ${data.nodes.map((n) => {
            const state = n.disabled ? 'disabled' : n.online ? 'online' : 'offline';
            const stateLabel = n.disabled ? 'Отключён' : n.online ? 'В сети' : 'Недоступен';
            const countryCode = (n.country ?? '').trim().toUpperCase().slice(0, 3);
            const country = countryFlag(countryCode);
            const alias = n.alias ?? '';
            const aliasKey = n.aliasKey ?? n.rawName;
            return `<div class="node-row ${state}" role="row">
              <div class="node-cell node-identity" role="cell">
                <span class="node-country" title="Страна: ${esc(n.country ?? 'не указана')}">${country}</span>
                <div class="node-name">
                  <label class="node-alias-field"><span>Имя для AI</span><input class="node-alias" data-raw="${esc(aliasKey)}" data-original="${esc(alias)}" value="${esc(alias)}" placeholder="${esc(n.name)}" maxlength="40" title="Как этот сервер называет AI"></label>
                  <span class="node-raw mono" title="${esc(n.rawName)}">Внутреннее: ${esc(n.rawName)}${n.sourceName ? ` · Панель: ${esc(n.sourceName)}` : ''}</span><span class="node-alias-feedback" aria-live="polite"></span>
                </div>
              </div>
              <div class="node-cell node-state-cell" role="cell" data-label="Состояние"><span class="node-status ${state}"><i></i>${stateLabel}</span></div>
              <div class="node-cell node-metric" role="cell" data-label="Пользователи"><strong>${n.usersOnline ?? '—'}</strong><span>онлайн</span></div>
              <div class="node-cell node-metric" role="cell" data-label="Трафик"><strong>${gb(n.trafficUsedBytes)}</strong><span>использовано</span></div>
            </div>`;
          }).join('')}
        </div>
      </section>
    </div>`;

  for (const input of box.querySelectorAll('.node-alias')) {
    const feedback = input.closest('.node-name').querySelector('.node-alias-feedback');
    if (!nodesWritable) {
      input.disabled = true;
      input.title = 'Изменение псевдонимов доступно только администратору';
      continue;
    }
    input.oninput = () => input.classList.toggle('is-dirty', input.value !== input.dataset.original);
    input.onchange = async () => {
      input.classList.add('is-saving'); feedback.textContent = 'Сохраняю…';
      const saved = await mutate('/api/nodes/alias', { method:'POST', body: JSON.stringify({ name: input.dataset.raw, alias: input.value }) });
      input.classList.remove('is-saving');
      if (saved) {
        input.dataset.original = input.value; input.classList.remove('is-dirty'); input.classList.add('is-saved'); feedback.textContent = 'Сохранено';
        setTimeout(() => { input.classList.remove('is-saved'); feedback.textContent = ''; }, 1600);
      } else { input.classList.add('is-error'); feedback.textContent = 'Не сохранено'; }
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = input.dataset.original; input.classList.remove('is-dirty','is-error'); feedback.textContent = ''; input.blur(); }
    };
  }
}
$('nodesRefresh').onclick = async () => {
  if (!canPermission('settings:nodes')) return toast('Нет права обновлять серверы');
  $('nodesRefresh').disabled = true;
  $('nodesRefresh').classList.add('is-loading');
  try { await mutate('/api/nodes/refresh', { method:'POST' }, 'Обновлено'); await loadNodes(); }
  finally { $('nodesRefresh').disabled = false; $('nodesRefresh').classList.remove('is-loading'); }
};

/* ═══ статистика ═══ */
let statsDays = 14;
$('statsRange').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  statsDays = Number(b.dataset.days);
  for (const o of $('statsRange').children) o.setAttribute('aria-pressed', String(o === b));
  void (async () => {
    const pending = viewLoadTasks.get('stats');
    if (pending) await pending.catch(() => undefined);
    await show('stats');
  })();
};

const fmtDur = (ms) => {
  if (ms == null) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ч ${m % 60} мин`;
  return `${Math.floor(h / 24)} д ${h % 24} ч`;
};

/** График входящих и исходящих по дням, нарисованный без внешней библиотеки. */
function barChart(rows) {
  if (!rows.length) return '<p class="empty">Пока нет данных.</p>';
  const peak = Math.max(1, ...rows.map((r) => Math.max(r.incoming, r.outgoing)));
  const width = 960, height = 260, left = 42, right = 18, top = 18, bottom = 34;
  const plotW = width - left - right, plotH = height - top - bottom;
  const x = (index) => left + (rows.length === 1 ? plotW / 2 : index * plotW / (rows.length - 1));
  const y = (value) => top + plotH - value / peak * plotH;
  const points = (key) => rows.map((row,index) => `${x(index).toFixed(1)},${y(row[key]).toFixed(1)}`).join(' ');
  const every = Math.max(1, Math.ceil(rows.length / 7));
  const grid = [0,.25,.5,.75,1].map((ratio) => {
    const gy = top + plotH - ratio * plotH;
    return `<line x1="${left}" y1="${gy}" x2="${width-right}" y2="${gy}"/><text x="${left-9}" y="${gy+4}" text-anchor="end">${Math.round(peak*ratio)}</text>`;
  }).join('');
  const labels = rows.map((row,index) => index % every === 0 || index === rows.length - 1
    ? `<text x="${x(index)}" y="${height-9}" text-anchor="middle">${esc(row.day.slice(5))}</text>` : '').join('');
  const dots = (key, klass) => rows.map((row,index) => `<circle class="${klass}" cx="${x(index)}" cy="${y(row[key])}" r="3"><title>${esc(row.day)} · ${key === 'incoming' ? 'входящие' : 'исходящие'}: ${row[key]}</title></circle>`).join('');
  return `<div class="chart-wrap"><svg class="volume-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Входящие и исходящие сообщения по дням">
    <g class="chart-grid">${grid}${labels}</g>
    <polyline class="series secondary" points="${points('outgoing')}"/>
    <polyline class="series primary" points="${points('incoming')}"/>
    <g class="chart-dots">${dots('outgoing','secondary')}${dots('incoming','primary')}</g>
  </svg></div>`;
}

/** Ряд «подпись — полоса — число»: нагляднее таблицы из двух колонок. */
function meters(rows, unit = '') {
  if (!rows.length) return '<div class="item"><span class="hint">Пока пусто.</span></div>';
  const peak = Math.max(1, ...rows.map(([, n]) => n));
  return rows.map(([label, n]) => `<div class="meter"><span>${esc(label)}</span>
    <span class="track"><i style="width:${Math.round(n / peak * 100)}%"></i></span>
    <b>${n}${unit}</b></div>`).join('');
}

async function loadStats() {
  if ($('view-stats').dataset.loaded !== 'true') $('stats').innerHTML = '<p class="empty">Считаю…</p>';
  const s = await json(`/api/stats?days=${statsDays}`);
  if (!s) {
    if ($('view-stats').dataset.loaded !== 'true') $('stats').innerHTML = '<p class="empty">Аналитика сейчас недоступна.</p>';
    return;
  }

  const acc = s.acceptanceRate == null ? '—' : Math.round(s.acceptanceRate * 100) + '%';
  const share = s.automationRate == null ? '—' : Math.round(s.automationRate * 100) + '%';
  const incoming = s.volume.reduce((a, v) => a + v.incoming, 0);
  const outgoing = s.volume.reduce((a, v) => a + v.outgoing, 0);
  const perDay = s.volume.length ? (incoming / s.volume.length).toFixed(1) : '0';

  const hourRows = Array.from({ length: 24 }, (_, h) => {
    const found = s.hours.find((x) => Number(x.hour) === h);
    return [`${String(h).padStart(2,'0')}:00`, found ? found.n : 0];
  }).filter(([, n]) => n > 0);

  $('stats').innerHTML = `
    <div class="stats-tools"><div><b>Честный период</b><p class="hint">Импортированная история не входит в метрики.${s.resetAt ? ` Новый отсчёт начат ${fmtDate(s.resetAt)}.` : ' Можно начать новый отсчёт без удаления диалогов.'}</p></div>
      ${canPermission('stats:reset') ? '<button class="btn danger" data-reset-stats>Начать отсчёт заново</button>' : ''}</div>
    <section class="stats-overview" aria-label="Ключевые показатели">
      <div class="metric-lead"><span>Медиана первого ответа</span><strong>${fmtDur(s.medianFirstResponseMs)}</strong><small>p90 ${fmtDur(s.p90FirstResponseMs)} · ${s.answered} диалогов с ответом</small></div>
      <div class="metric-list">
        <div><span>Ждут ответа</span><b>${s.totals.waiting ?? 0}</b><small>${s.totals.open ?? 0} открыто</small></div>
        <div><span>Сообщения клиентов</span><b>${incoming}</b><small>${perDay} в день · ${outgoing} ответов</small></div>
        <div><span>Автоматизация</span><b>${share}</b><small>AI ${s.aiReplies ?? 0} · оператор ${s.humanReplies ?? 0}</small></div>
        <div><span>Решено</span><b>${s.period.resolved ?? 0}</b><small>из ${s.period.conversations ?? 0} новых диалогов</small></div>
      </div>
    </section>

    <section class="chart-section">
      <header><div><h2>Поток сообщений</h2><p>Входящие и ответы за ${s.days} дней</p></div><div class="legend"><span><i class="primary"></i>Входящие</span><span><i class="secondary"></i>Ответы</span></div></header>
      ${barChart(s.volume)}
      <div class="chart-foot"><span>Медиана решения <b>${fmtDur(s.medianResolutionMs)}</b></span><span>Среднее <b>${fmtDur(s.avgResolutionMs)}</b></span><span>Принято предложок <b>${acc}</b></span><span>База знаний <b>${s.kb ?? 0}</b></span></div>
    </section>

    <div class="split2">
      <div>
        <div class="cap">Когда пишут</div>
        <div class="group">${meters(hourRows)}</div>
      </div>
      <div>
        <div class="cap">Предложки AI</div>
        <div class="group">${meters(s.suggestions.map((x) => [({
          sent:'Отправлены как есть', edited:'Отправлены с правкой',
          rejected:'Отклонены', pending:'Ждут решения', superseded:'Устарели',
        })[x.status] ?? x.status, x.n]))}</div>
      </div>
      <div>
        <div class="cap">Требуют внимания</div>
        <div class="group">${meters([
          ['Эскалированы', s.totals.escalated ?? 0],
          ['Нет в базах', s.totals.suspicious ?? 0],
          ['Ждут человека', s.totals.handoff ?? 0],
        ])}</div>
      </div>
      <div>
        <div class="cap">Откуда приходят</div>
        <div class="group">${meters(s.byChannel.map((c) => [channelLabel({ channel:c.channel }), c.n]))}</div>
      </div>
      <div>
        <div class="cap">Статьи, которые работают</div>
        <div class="group">${meters(s.topSources.map((x) => [x.title, x.n]))}</div>
      </div>
      <div>
        <div class="cap">События</div>
        <div class="group">${meters(s.events.map((x) => [({
          ai_draft:'Черновики AI', ai_error:'Сбои AI', ai_no_request:'Без обращения',
          sla_breach:'Просрочки', sub_link:'Прислали ключ', business_connection:'Подключение',
        })[x.kind] ?? x.kind, x.n]))}</div>
      </div>
    </div>`;
  $('stats').querySelector('[data-reset-stats]')?.addEventListener('click', () => confirmAction(
    'Начать статистику заново?',
    'Диалоги и сообщения сохранятся. Графики и временные метрики будут считать только новые обращения после этого момента.',
    async () => {
      const result = await mutate('/api/stats/reset', { method:'POST' }, 'Новый статистический период начат');
      if (result) await loadStats();
    },
  ));
}

/* ═══ очередь, SLA и сохранённые фильтры ═══ */
let queueRows = [], queuePolicies = [], savedQueueFilters = [];
let queueMode = 'all', queuePriority = 'all';
const PRIORITY_LABELS = { urgent:'Срочный', high:'Высокий', normal:'Обычный', low:'Низкий' };

function parseFilter(value) {
  try { return typeof value === 'string' ? JSON.parse(value) : (value ?? {}); }
  catch { return {}; }
}

function renderSavedFilters() {
  const select = $('queueSavedFilter');
  if (!select) return;
  select.innerHTML = `<option value="">Представления</option>${savedQueueFilters.map((filter) => `<option value="${Number(filter.id)}">${esc(filter.name)}</option>`).join('')}`;
  select.hidden = savedQueueFilters.length === 0;
  select.onchange = () => {
    const row = savedQueueFilters.find((item) => Number(item.id) === Number(select.value));
    const query = parseFilter(row?.query);
    queueMode = ['all','overdue','unassigned'].includes(query.mode) ? query.mode : 'all';
    queuePriority = ['all','urgent','high','normal','low'].includes(query.priority) ? query.priority : 'all';
    renderQueue();
  };
}

function renderSlaPolicies() {
  const editable = canPermission('queue:manage');
  sheet('Сроки обслуживания', `<p class="sheet-intro">Внутренние цели команды. Настройки не меняют статусы обращений в подключённых каналах.</p>
    <div class="sla-policy-list">${queuePolicies.map((p) => `<div class="sla-policy-row">
      <div class="sla-priority"><span class="status-dot ${p.priority === 'urgent' ? 'danger' : ''}"></span><b>${esc(PRIORITY_LABELS[p.priority] ?? p.priority)}</b></div>
      <div class="frow"><label for="sla-first-${p.priority}">Первый ответ, мин</label><input id="sla-first-${p.priority}" type="number" min="1" max="10080" value="${Number(p.first_response_minutes)}" ${editable ? '' : 'disabled'}></div>
      <div class="frow"><label for="sla-resolution-${p.priority}">Решение, мин</label><input id="sla-resolution-${p.priority}" type="number" min="1" max="10080" value="${Number(p.resolution_minutes)}" ${editable ? '' : 'disabled'}></div>
      ${editable ? `<button class="btn" data-sla-save="${esc(p.priority)}">Сохранить</button>` : '<span class="hint">Только lead и admin</span>'}
    </div>`).join('')}</div>`, '<button class="btn primary" id="slaDone">Готово</button>', 'wide');
  $('slaDone').onclick = closeSheet;
  for (const button of $('sheet').querySelectorAll('[data-sla-save]')) button.onclick = async () => {
    const priority = button.dataset.slaSave;
    const result = await mutate(`/api/sla/${priority}`, { method:'PUT', body:JSON.stringify({
      firstResponseMinutes:Number($(`sla-first-${priority}`).value), resolutionMinutes:Number($(`sla-resolution-${priority}`).value),
    }) }, 'SLA сохранён');
    if (result?.policies) queuePolicies = result.policies;
  };
}

function renderQueue() {
  const box = $('queueBody');
  if (!box) return;
  const filtered = queueRows.filter((row) => (queueMode === 'overdue' ? row.overdue : queueMode === 'unassigned' ? !row.assignee : true)
    && (queuePriority === 'all' || row.priority === queuePriority));
  const overdue = queueRows.filter((row) => row.overdue).length;
  const unassigned = queueRows.filter((row) => !row.assignee && !row.owner_name).length;
  const urgent = queueRows.filter((row) => row.priority === 'urgent').length;
  $('cntOverdue').textContent = String(overdue);
  box.innerHTML = `<section class="queue-summary" aria-label="Сводка очереди"><div><span>В очереди</span><b>${queueRows.length}</b></div><div class="${overdue ? 'danger-text' : ''}"><span>Просрочено</span><b>${overdue}</b></div><div><span>Без ответственного</span><b>${unassigned}</b></div><div><span>Срочные</span><b>${urgent}</b></div></section>
    <div class="table-toolbar"><div><b>Рабочая очередь</b><span>${filtered.length} обращений в текущем представлении</span></div>
    <div class="ops-actions"><select class="ctl" id="queueSavedFilter" aria-label="Сохранённое представление"></select><select class="ctl" id="queueMode" aria-label="Состояние очереди"><option value="all">Все</option><option value="overdue">Просроченные</option><option value="unassigned">Без ответственного</option></select>
    <select class="ctl" id="queuePriority"><option value="all">Любой приоритет</option>${Object.entries(PRIORITY_LABELS).map(([value,label]) => `<option value="${value}">${label}</option>`).join('')}</select></div></div>
    ${filtered.length ? `<div class="table-scroll"><table class="ops-table queue-table"><thead><tr><th>Диалог</th><th>Канал</th><th>Приоритет</th><th>Ответственный</th><th>SLA</th><th><span class="sr-only">Открыть</span></th></tr></thead><tbody>${filtered.map((row) => {
      const left = Number(row.due_at) - Date.now();
      return `<tr tabindex="0" data-queue-open="${Number(row.id)}"><td><b>${esc(row.display_name || (row.username ? '@'+row.username : '#'+row.id))}</b><div class="hint">${esc(conversationStatus(row.status))}</div></td>
        <td>${esc(channelLabel(row))}</td><td><span class="status-text ${row.priority === 'urgent' ? 'danger' : ''}"><i></i>${esc(PRIORITY_LABELS[row.priority] ?? row.priority)}</span></td>
        <td>${esc(row.owner_name || 'Не назначен')}</td><td><span class="status-text ${row.overdue ? 'danger' : 'ok'}"><i></i>${row.overdue ? `Просрочено на ${fmtLeft(Math.abs(left))}` : `Осталось ${fmtLeft(Math.max(0,left))}`}</span></td>
        <td class="row-disclosure" aria-hidden="true">›</td></tr>`;
    }).join('')}</tbody></table></div>` : '<p class="empty">В этом представлении диалогов нет.</p>'}`;
  $('queueMode').value = queueMode;
  $('queuePriority').value = queuePriority;
  $('queueMode').onchange = (event) => { queueMode = event.target.value; renderQueue(); };
  $('queuePriority').onchange = (event) => { queuePriority = event.target.value; renderQueue(); };
  renderSavedFilters();
  for (const row of box.querySelectorAll('[data-queue-open]')) {
    row.onclick = async () => { show('inbox'); await open(Number(row.dataset.queueOpen)); };
    row.onkeydown = async (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show('inbox'); await open(Number(row.dataset.queueOpen)); } };
  }
}

async function loadQueue() {
  if ($('view-queue').dataset.loaded !== 'true') $('queueBody').innerHTML = '<p class="empty">Загружаю очередь…</p>';
  const [queue, filtersData] = await Promise.all([json('/api/queue'), json('/api/filters')]);
  if (!queue) { $('queueBody').innerHTML = '<p class="empty">Очередь недоступна.</p>'; return; }
  queueRows = queue.conversations ?? [];
  queuePolicies = queue.policies ?? [];
  savedQueueFilters = filtersData?.filters ?? [];
  renderQueue();
}

/** Счётчики навигации загружаются при старте, а не после первого клика. */
async function loadNavigationCounts() {
  const [queue, knowledge] = await Promise.all([
    canPermission('queue:read') ? json('/api/queue') : Promise.resolve(null),
    canPermission('knowledge:read') ? json('/api/kb') : Promise.resolve(null),
  ]);
  if (queue) {
    const overdue = (queue.conversations ?? []).filter((row) => row.overdue).length;
    $('cntOverdue').textContent = String(overdue);
  }
  if (knowledge) $('cntKb').textContent = String((knowledge.kb ?? []).length);
}
$('queueRefresh').onclick = loadQueue;
$('slaPoliciesBtn').onclick = renderSlaPolicies;
$('closeAllTickets').onclick = () => {
  const count = queueRows.length;
  document.querySelector('.queue-actions-menu')?.removeAttribute('open');
  if (!count) { toast('В очереди нет открытых тикетов'); return; }
  confirmAction('Закрыть все тикеты?', `Будут закрыты все открытые тикеты в очереди: ${count}. Действие затронет и подключённые каналы.`, async () => {
    let closed = 0;
    const errors = [];
    for (const row of [...queueRows]) {
      try {
        const response = await api(`/api/conversations/${row.id}/state`, { method:'POST', body:JSON.stringify({ status:'resolved' }) });
        if (response.ok) closed += 1;
        else {
          const body = await response.json().catch(() => ({}));
          errors.push(body.error ?? `Тикет #${row.id}`);
        }
      } catch {
        errors.push(`Тикет #${row.id}: нет связи`);
      }
    }
    await loadQueue();
    await refresh();
    toast(errors.length ? `Закрыто ${closed} из ${count}. Ошибок: ${errors.length}` : `Закрыты все тикеты: ${closed}`);
  });
};

/* ═══ команда, роли и аудит ═══ */
const ROLE_LABELS = { admin:'Администратор', lead:'Руководитель', agent:'Оператор', viewer:'Наблюдатель' };
function showOperatorToken(name, value) {
  sheet(`Токен: ${name}`, `<p class="hint">Показывается один раз. Передайте его оператору защищённым каналом.</p>
    <input id="operatorToken" class="mono" readonly value="${esc(value)}">`,
    '<button class="btn" id="copyOperatorToken">Скопировать</button><button class="btn primary" id="tokenDone">Готово</button>');
  $('copyOperatorToken').onclick = async () => { await navigator.clipboard.writeText($('operatorToken').value); toast('Токен скопирован'); };
  $('tokenDone').onclick = closeSheet;
}

let teamOperators = [], teamRoles = null, operatorStatsDays = 30;

function closeOperatorMenu() { document.getElementById('operatorActionMenu')?.remove(); }
function editOperator(row) {
  sheet('Изменить оператора', `<div class="frow"><label for="editOperatorName">Имя</label><input id="editOperatorName" maxlength="80" value="${esc(row.name)}"></div>
    <div class="frow"><label for="editOperatorRole">Роль</label><select id="editOperatorRole">${Object.entries(ROLE_LABELS).map(([value,label]) => `<option value="${value}" ${row.role === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>`,
    '<button class="btn" id="editOperatorCancel">Отмена</button><button class="btn primary" id="editOperatorSave">Сохранить</button>');
  $('editOperatorCancel').onclick = closeSheet;
  $('editOperatorSave').onclick = async () => {
    const result = await mutate(`/api/operators/${row.id}`, { method:'POST', body:JSON.stringify({ name:$('editOperatorName').value, role:$('editOperatorRole').value }) }, 'Оператор обновлён');
    if (result) { closeSheet(); await loadTeam(); }
  };
}

function openOperatorMenu(trigger, row) {
  closeOperatorMenu();
  const menu = document.createElement('div');
  menu.id = 'operatorActionMenu'; menu.className = 'operator-popover'; menu.setAttribute('role','menu');
  menu.innerHTML = `<button data-action="edit">Изменить имя и роль</button><button data-action="rotate">Выпустить новый токен</button>
    <button data-action="active" class="${row.active ? 'danger-text' : ''}">${row.active ? 'Отключить доступ' : 'Включить доступ'}</button>`;
  document.body.append(menu);
  const anchor = trigger.getBoundingClientRect(), size = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(12, Math.min(innerWidth - size.width - 12, anchor.right - size.width))}px`;
  menu.style.top = `${Math.max(12, anchor.bottom + size.height + 8 < innerHeight ? anchor.bottom + 6 : anchor.top - size.height - 6)}px`;
  menu.onclick = (event) => {
    const action = event.target.closest('button')?.dataset.action; if (!action) return;
    closeOperatorMenu();
    if (action === 'edit') editOperator(row);
    if (action === 'rotate') confirmAction('Перевыпустить токен?', 'Старый токен сразу перестанет работать.', async () => {
      const result = await mutate(`/api/operators/${row.id}`, { method:'POST', body:JSON.stringify({ rotate:true }) });
      if (result?.token) showOperatorToken(row.name, result.token);
    });
    if (action === 'active') confirmAction(row.active ? 'Отключить оператора?' : 'Включить оператора?',
      row.active ? 'Его текущий доступ будет закрыт.' : 'Оператор снова сможет войти со своим токеном.', async () => {
        const result = await mutate(`/api/operators/${row.id}`, { method:'POST', body:JSON.stringify({ active:!row.active }) }, 'Доступ изменён');
        if (result) loadTeam();
      });
  };
  setTimeout(() => document.addEventListener('pointerdown', (event) => {
    if (!menu.contains(event.target) && event.target !== trigger) closeOperatorMenu();
  }, { once:true }), 0);
}

function renderOperators(rows) {
  const box = $('operatorsBody');
  if (!canPermission('team:read')) {
    box.innerHTML = `<article class="ops-card"><header><b>${esc(currentActor?.name || 'Оператор')}</b><span class="badge">${esc(ROLE_LABELS[currentActor?.role] ?? currentActor?.role ?? '')}</span></header>
      <p class="hint">Нет права просматривать состав команды.</p></article>`;
    return;
  }
  const manageable = canPermission('operators:manage');
  box.innerHTML = `<div class="team-note">У каждого сотрудника собственная учётная запись. Новый токен показывается один раз.</div>
    <div class="table-toolbar"><div><b>Сотрудники</b><span>Роли и доступ к рабочей панели</span></div></div>
    ${rows.length ? `<div class="team-table-wrap"><table class="ops-table"><thead><tr><th>Имя</th><th>Роль</th><th>Состояние</th><th>Создан</th>${manageable ? '<th></th>' : ''}</tr></thead><tbody>${rows.map((row) => `<tr>
      <td><b>${esc(row.name)}</b></td><td>${esc(ROLE_LABELS[row.role] ?? row.role)}</td><td><span class="status-text ${row.active ? 'ok' : 'danger'}"><i></i>${row.active ? 'Активен' : 'Отключён'}</span></td>
      <td>${fmtTime(Number(row.created_at))}</td>${manageable ? `<td><button class="row-actions-trigger" data-operator-menu="${Number(row.id)}" aria-label="Действия с оператором ${esc(row.name)}">•••</button></td>` : ''}</tr>`).join('')}</tbody></table></div>` : '<p class="empty">Отдельных операторов пока нет — используется токен владельца.</p>'}`;
  for (const button of box.querySelectorAll('[data-operator-menu]')) button.onclick = (event) => {
    event.stopPropagation();
    const row = rows.find((item) => Number(item.id) === Number(button.dataset.operatorMenu));
    if (row) openOperatorMenu(button, row);
  };
}

function renderOperatorStats(data) {
  const box = $('performanceBody');
  if (!canPermission('operator_stats:read')) { box.innerHTML = ''; return; }
  const rows = data?.operators ?? [];
  const totalResolved = rows.reduce((sum,row) => sum + Number(row.resolved || 0), 0);
  const totalReplies = rows.reduce((sum,row) => sum + Number(row.replies || 0), 0);
  box.innerHTML = `<div class="team-stats-head"><div><b>Эффективность команды</b><span>Учитываются действия из панели начиная с версии 2.4.7</span></div><div class="seg" id="operatorStatsRange">${[7,30,90].map((days) => `<button data-days="${days}" aria-pressed="${operatorStatsDays === days}">${days} дней</button>`).join('')}</div></div>
    <div class="team-kpis"><article><span>Закрыто тикетов</span><b>${totalResolved}</b></article><article><span>Ответов операторов</span><b>${totalReplies}</b></article><article><span>Активных назначений</span><b>${rows.reduce((sum,row) => sum + Number(row.active_assigned || 0), 0)}</b></article></div>
    <div class="team-table-wrap"><table class="ops-table performance-table"><thead><tr><th>Сотрудник</th><th>Тикетов в работе</th><th>Обработано</th><th>Закрыто</th><th>Ответов</th><th>Средний ответ</th><th>Медиана</th><th>Последняя активность</th></tr></thead><tbody>${rows.map((row) => `<tr><td><b>${esc(row.name)}</b><span class="hint">${esc(ROLE_LABELS[row.role] ?? row.role)}</span></td><td>${Number(row.active_assigned || 0)}</td><td>${Number(row.handled || 0)}</td><td>${Number(row.resolved || 0)}</td><td>${Number(row.replies || 0)}</td><td>${fmtDur(row.average_response_ms)}</td><td>${fmtDur(row.median_response_ms)}</td><td>${row.last_activity_at ? fmtTime(Number(row.last_activity_at)) : '—'}</td></tr>`).join('')}</tbody></table></div>`;
  $('operatorStatsRange').onclick = async (event) => {
    const button = event.target.closest('button'); if (!button) return;
    operatorStatsDays = Number(button.dataset.days);
    renderOperatorStats(await json(`/api/operator-stats?days=${operatorStatsDays}`));
  };
}

function renderRoles(data, selectedRole = 'agent') {
  const box = $('rolesBody');
  if (!canPermission('roles:manage') || !data) { box.innerHTML = ''; return; }
  const selected = new Set(data.roles?.[selectedRole] ?? []);
  const groups = (data.catalog ?? []).reduce((result,item) => {
    (result[item.group] ??= []).push(item); return result;
  }, {});
  box.innerHTML = `<div class="role-toolbar"><div><b>Права роли</b><span>Каждый флаг проверяется сервером, включая отдельные параметры AI</span></div><select id="permissionRole">${Object.entries(ROLE_LABELS).map(([role,label]) => `<option value="${role}" ${role === selectedRole ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
    <div class="permission-groups">${Object.entries(groups).map(([group,items]) => `<section class="permission-group"><header><b>${esc(group)}</b><span>${items.length} прав</span></header>${items.map((item) => `<label class="permission-row"><span>${esc(item.label)}</span><input type="checkbox" data-permission="${esc(item.id)}" ${selected.has(item.id) ? 'checked' : ''}></label>`).join('')}</section>`).join('')}</div>
    <div class="role-actions"><button class="btn" id="resetRolePermissions">Вернуть стандартные</button><button class="btn primary" id="saveRolePermissions">Сохранить права роли</button></div>`;
  $('permissionRole').onchange = (event) => renderRoles(data, event.target.value);
  $('resetRolePermissions').onclick = () => {
    const defaults = new Set(data.defaults?.[selectedRole] ?? []);
    for (const input of box.querySelectorAll('[data-permission]')) input.checked = defaults.has(input.dataset.permission);
  };
  $('saveRolePermissions').onclick = async () => {
    const permissions = [...box.querySelectorAll('[data-permission]:checked')].map((input) => input.dataset.permission);
    const result = await mutate(`/api/roles/${selectedRole}`, { method:'PUT', body:JSON.stringify({ permissions }) }, 'Права роли сохранены');
    if (result) {
      data.roles[selectedRole] = result.permissions;
      const identity = await json('/api/me');
      currentActor = identity?.actor ?? currentActor; applyRoleUi();
      if (canPermission('roles:manage')) renderRoles(data, selectedRole);
      else box.innerHTML = '<p class="empty">Новые права уже применены. Доступ к настройке ролей для вашей роли отключён.</p>';
    }
  };
}

function renderAudit(events) {
  const box = $('auditBody');
  if (!box) return;
  if (!canPermission('audit:read')) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="table-toolbar"><div><b>Журнал действий</b><span>Последние ${events.length} событий без секретов</span></div></div>
    ${events.length ? `<div style="overflow:auto"><table class="ops-table"><thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Объект</th><th>Детали</th></tr></thead><tbody>${events.map((event) => `<tr>
      <td>${fmtTime(Number(event.created_at))}</td><td>${esc(event.actor_name)}<div class="hint">${esc(ROLE_LABELS[event.actor_role] ?? event.actor_role)}</div></td>
      <td><span class="mono">${esc(event.action)}</span></td><td>${esc(event.resource)} ${event.resource_id ? '#'+esc(event.resource_id) : ''}</td>
      <td><span class="hint">${esc(event.payload ? String(event.payload).slice(0,180) : '—')}</span></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Действий пока нет.</p>'}`;
}

async function loadTeam() {
  const me = await json('/api/me');
  currentActor = me?.actor ?? currentActor;
  $('meLabel').textContent = currentActor ? `${currentActor.name} · ${ROLE_LABELS[currentActor.role] ?? currentActor.role}` : '';
  applyRoleUi();
  $('newOperator').hidden = !canPermission('operators:manage');
  const visibility = { operators:'team:read', performance:'operator_stats:read', roles:'roles:manage', audit:'audit:read' };
  for (const [tab,permission] of Object.entries(visibility)) $('teamTabs').querySelector(`[data-team-tab="${tab}"]`).hidden = !canPermission(permission);
  let activeTab = $('teamTabs').querySelector('[aria-pressed="true"]:not([hidden])')?.dataset.teamTab;
  if (!activeTab) activeTab = $('teamTabs').querySelector('button:not([hidden])')?.dataset.teamTab;
  for (const button of $('teamTabs').children) button.setAttribute('aria-pressed', String(button.dataset.teamTab === activeTab));
  for (const name of ['operators','performance','roles','audit']) $(`${name}Body`).hidden = activeTab !== name;
  document.querySelector('.team-workspace').dataset.teamView = activeTab ?? '';
  const [operatorsData, statsData, rolesData, auditData] = await Promise.all([
    canPermission('team:read') ? json('/api/operators') : Promise.resolve(null),
    canPermission('operator_stats:read') ? json(`/api/operator-stats?days=${operatorStatsDays}`) : Promise.resolve(null),
    canPermission('roles:manage') ? json('/api/roles') : Promise.resolve(null),
    canPermission('audit:read') ? json('/api/audit?limit=200') : Promise.resolve(null),
  ]);
  teamOperators = operatorsData?.operators ?? []; teamRoles = rolesData;
  renderOperators(teamOperators); renderOperatorStats(statsData); renderRoles(teamRoles);
  renderAudit(auditData?.events ?? []);
}
function openOperatorSheet() {
  sheet('Новый оператор', `<div class="frow"><label for="operatorName">Имя</label><input id="operatorName" maxlength="80" placeholder="Имя в журнале и интерфейсе"></div>
    <div class="frow"><label for="operatorRole">Роль</label><select id="operatorRole"><option value="agent">Оператор</option><option value="lead">Руководитель</option><option value="viewer">Наблюдатель</option><option value="admin">Администратор</option></select></div>`,
    '<button class="btn" id="operatorCancel">Отмена</button><button class="btn primary" id="operatorCreate">Создать</button>');
  $('operatorCancel').onclick = closeSheet;
  $('operatorCreate').onclick = async () => {
    const result = await mutate('/api/operators', { method:'POST', body:JSON.stringify({ name:$('operatorName').value, role:$('operatorRole').value }) }, 'Оператор создан');
    if (result?.token) { closeSheet(); showOperatorToken(result.operator.name, result.token); loadTeam(); }
  };
}
$('newOperator').onclick = openOperatorSheet;
$('teamTabs').onclick = (event) => {
  const button = event.target.closest('[data-team-tab]');
  if (!button) return;
  const tab = button.dataset.teamTab;
  for (const item of $('teamTabs').children) item.setAttribute('aria-pressed', String(item === button));
  for (const name of ['operators','performance','roles','audit']) $(`${name}Body`).hidden = tab !== name;
  document.querySelector('.team-workspace').dataset.teamView = tab;
  animateContentChange($(`${tab}Body`));
};

/* ═══ диагностика ═══ */
const mb = (bytes) => `${(Number(bytes ?? 0) / 1048576).toFixed(1)} МБ`;
async function loadDiagnostics() {
  const box = $('diagnosticsBody');
  if ($('view-diagnostics').dataset.loaded !== 'true') box.innerHTML = '<p class="empty">Проверяю компоненты…</p>';
  const data = await json('/api/diagnostics');
  if (!data) { box.innerHTML = '<p class="empty">Диагностика недоступна.</p>'; return; }
  const channelRows = Object.entries(data.channels).map(([key,on]) => `<div class="item"><span>${esc(channelLabel({channel:key}))}</span><span class="status-text ${on ? 'ok' : ''}"><i></i>${on ? 'Подключён' : 'Не подключён'}</span></div>`).join('');
  const integrationRows = Object.entries(data.integrations).map(([key,on]) => `<div class="item"><span>${esc(key)}</span><span class="status-text ${on ? 'ok' : ''}"><i></i>${on ? 'Готов' : 'Не настроен'}</span></div>`).join('');
  const jobs = data.database.jobs ?? [];
  box.innerHTML = `<div class="diagnostic-sections">
    <section class="diagnostic-section"><header><div><b>Приложение <span class="mono">v${esc(data.application.version)}</span></b><span>Процесс и память</span></div><span class="status-text ok"><i></i>Работает</span></header><div class="diagnostic-facts"><span>Аптайм <b>${fmtLeft(data.application.uptime*1000)}</b></span><span>RSS <b>${mb(data.application.memory.rss)}</b></span><span>Heap <b>${mb(data.application.memory.heapUsed)}</b></span></div></section>
    <section class="diagnostic-section"><header><div><b>База данных</b><span>Целостность и схема</span></div><span class="status-text ${data.database.integrity === 'ok' ? 'ok' : 'danger'}"><i></i>${esc(data.database.integrity)}</span></header><div class="diagnostic-facts"><span>Схема <b>${Number(data.database.schema)}</b></span>${Object.entries(data.database.counts).map(([key,n]) => `<span>${esc(key)} <b>${Number(n)}</b></span>`).join('')}</div></section>
    <section class="diagnostic-section"><header><div><b>Каналы</b><span>Голый режим допустим</span></div></header><div class="group">${channelRows}</div></section>
    <section class="diagnostic-section"><header><div><b>Интеграции</b><span>Необязательные подключения</span></div></header><div class="group">${integrationRows}</div></section>
    <section class="diagnostic-section"><header><div><b>Настройки панели поверх .env</b><span>Действует значение панели</span></div></header><div class="group">${(data.settingOverrides ?? []).length ? data.settingOverrides.map((item) => `<div class="item"><span class="mono">${esc(item.key)}</span><span>${esc(JSON.stringify(item.value))} <span class="hint">вместо ${esc(JSON.stringify(item.env))} из .env</span></span></div>`).join('') : '<div class="item"><span>Всё как в .env</span></div>'}</div></section>
  </div>
  <div class="ops-head"><div><b>Фоновые задания</b><span class="hint">Последние ${jobs.length}; ошибки видны явно</span></div></div>
  ${jobs.length ? `<div style="overflow:auto"><table class="ops-table"><thead><tr><th>Тип</th><th>Статус</th><th>Прогресс</th><th>Завершено</th></tr></thead><tbody>${jobs.map((job) => `<tr><td>${esc(job.kind)}</td><td><span class="status-text ${job.status === 'failed' ? 'danger' : job.status === 'done' ? 'ok' : ''}"><i></i>${esc(job.status)}</span></td><td>${esc(job.error || job.progress || '—')}</td><td>${job.ended_at ? fmtTime(Number(job.ended_at)) : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Фоновых заданий пока не было.</p>'}`;
}
$('diagRefresh').onclick = loadDiagnostics;

/* ═══ настройки ═══ */
/**
 * Настройки с пояснениями. Без описания половина параметров выглядит
 * шумом: оператор менял значение, ничего не происходило, и настройка
 * считалась сломанной — хотя просто не действовала в текущем режиме.
 *
 * active(runtime) отвечает, работает ли параметр сейчас. Неактивные не
 * прячем — показываем с пометкой, иначе непонятно, куда они делись.
 */
const CONFIDENCE_LEVELS = [
  [0.40, 'Очень низкий — отвечает почти всегда'],
  [0.55, 'Низкий — отвечает, если ответ похож на верный'],
  [0.70, 'Средний — нужна заметная опора на базу'],
  [0.80, 'Высокий — ответ должен прямо следовать из статьи'],
  [0.90, 'Очень высокий — только дословно из базы'],
];

const FIELDS = [
  { key:'aiMode', label:'Режим AI по умолчанию', kind:'select',
    options:[['off','Выключен везде'],['shadow','Тень: анализирует, но не пишет'],['suggest','Предлагает'],['auto','Отвечает сам']],
    hint:'«Тень» запускает тот же анализ и сохраняет причины решения, но ничего не отправляет клиенту. Это безопасный режим для проверки новой базы знаний и промпта.' },

  { key:'requireKb', label:'Отвечать только по базе знаний', kind:'select',
    options:[['true','Да, иначе зовём человека'],['false','Разрешить отвечать без опоры']],
    hint:'Главная защита от выдумок. Если поиск по базе знаний не нашёл ничего, ответ клиенту сам не уйдёт ни при какой уверенности — диалог передаётся человеку.' },

  { key:'autoLearn', label:'Учиться на закрытых диалогах', kind:'select',
    options:[['false','Выключено'],['true','Создавать черновики статей']],
    hint:'После закрытия диалога AI выделяет повторно полезные решения и кладёт их в черновики базы знаний. Самостоятельной публикации нет: оператор проверяет и публикует статью вручную.' },

  { key:'bedolagaInterfaceKb', label:'Включить базу знаний интерфейса Бедолаги', kind:'select',
    options:[['false','Выключено'],['true','Включено']],
    hint:'Разрешает AI использовать только проверенные инструкции и локальные скриншоты интерфейса. До загрузки проверенного комплекта оставьте выключенным.' },

  { key:'bedolagaInterfaceMode', label:'Вид кабинета Бедолаги', kind:'select',
    options:[['auto','Авто — как у магазина'],['full','Полный вид'],['lite','Простой вид']],
    hint:'У кабинета два вида: полный и «Простой вид». Инструкции для них отличаются — кнопки и пункты меню называются по-разному. В авто-режиме панель раз в 10 минут спрашивает кабинет, какой вид включён у магазина; пока ответа нет, используется полный вид. Выберите вид вручную, если автоопределение не подходит.' },

  { key:'minConfidence', label:'Порог уверенности', kind:'level',
    options: CONFIDENCE_LEVELS.map(([v, t]) => [String(v), t]),
    hint:'Модель сама оценивает от 0 до 1, насколько её ответ подтверждается выдержками из базы знаний, и возвращает эту оценку вместе с ответом. Ниже порога — ответ становится предложкой оператору. Оценка приблизительная, поэтому порог стоит поднимать, если видите неточные автоответы.',
    active:(r) => r.aiMode === 'auto' },

  { key:'autoPerHour', label:'Предел автоответов в диалоге за час', kind:'number',
    attrs:{min:0,max:100,step:1},
    hint:'Предохранитель от зацикливания в одном диалоге, а не общий лимит запросов. Если сработал, следующий ответ уходит оператору предложкой, а клиент получает «передал специалисту» — молча его не игнорируют. 0 — без предела.',
    active:(r) => r.aiMode === 'auto' },

  { key:'humanHoldMinutes', label:'Молчать после ответа оператора, мин', kind:'number',
    attrs:{min:0,max:1440,step:5},
    hint:'После того как в диалоге ответил живой человек, AI не вмешивается указанное время: разговор уже ведёт оператор. 0 — выключено. Действует только когда AI отвечает сам.',
    active:(r) => r.aiMode === 'auto' },

  { key:'maxAgeMinutes', label:'Не отвечать на сообщения старше, мин', kind:'number',
    attrs:{min:1,max:10080,step:10},
    hint:'Защита при перезапуске и разборе завала: если сообщение пролежало дольше этого срока, AI на него не отвечает. Иначе после простоя модель начинает отвечать на вчерашние вопросы, на которые уже ответили или которые потеряли смысл.' },

  { key:'slaFirstResponseMinutes', label:'Срок первого ответа, мин', kind:'number',
    attrs:{min:1,max:10080,step:5},
    hint:'Через сколько минут ожидания прислать уведомление, что клиенту до сих пор никто не ответил. На сам ответ не влияет — это только напоминание вам. Тот же срок применяется к диалогам, переданным человеку.' },

  { key:'handoffRepeatMinutes', label:'Повторять «ожидайте» не чаще, мин', kind:'number',
    attrs:{min:0,max:10080,step:10},
    hint:'Когда диалог передан человеку, а клиент продолжает писать, AI повторяет «вопрос у специалиста» не чаще этого срока. Срабатывает на новое сообщение клиента, а не по таймеру. 0 — не повторять вовсе.' },

  { key:'notifyLevel', label:'Подробность уведомлений', kind:'select',
    options:[['all','Каждое сообщение и действие AI'],['important','Только требующее вмешательства'],['minimal','Только передачи и просрочки']],
    hint:'Что присылать в Telegram. Передача человеку приходит на любом уровне: клиенту в этот момент обещан специалист.' },

  { key:'model', label:'Модель', kind:'text',
    hint:'Имя модели у провайдера. Кнопка «Выбрать» подтянет список от него самого.' },

  { key:'fallbackModel', label:'Запасная модель', kind:'text',
    hint:'Запрос без фото уходит сюда при лимите, временном сбое или снятии основной модели. Фото никогда не передаётся модели без vision: при недоступности основной диалог безопасно останется оператору.' },

  { key:'brand', label:'Название сервиса для AI', kind:'text',
    hint:'Как модель называет ваш сервис в ответах клиентам.' },
];

/** Ближайший уровень: в базе может лежать значение, набранное руками. */
function nearestLevel(value) {
  let best = CONFIDENCE_LEVELS[0][0];
  for (const [level] of CONFIDENCE_LEVELS) {
    if (Math.abs(level - Number(value)) < Math.abs(best - Number(value))) best = level;
  }
  return String(best);
}

const SETTINGS_GROUPS = [
  { id:'safety', title:'Режим и безопасность', note:'Когда AI может отвечать и на что он должен опираться',
    fields:['aiMode','requireKb','autoLearn','bedolagaInterfaceKb','bedolagaInterfaceMode','minConfidence','maxAgeMinutes'] },
  { id:'limits', title:'Лимиты и внимание оператора', note:'Паузы, SLA и защита от зацикливания',
    fields:['autoPerHour','humanHoldMinutes','handoffRepeatMinutes','notifyLevel'] },
  { id:'models', title:'Модели и сервис', note:'Основная, запасная модель и имя бренда',
    fields:['model','fallbackModel','brand'] },
];
let settingsSaveTimer = null;
function showSettingsSaveState(state, text) {
  const wrap = $('setHint').closest('.save-state');
  wrap.dataset.state = state;
  $('setHint').textContent = text;
  clearTimeout(settingsSaveTimer);
  if (state === 'saved') settingsSaveTimer = setTimeout(() => { wrap.dataset.state = 'idle'; $('setHint').textContent = ''; }, 1800);
}

let updatePoll = null;
const UPDATE_STATUS = {
  queued:'В очереди', backing_up:'Резервная копия', installing:'Установка', checking:'Проверка',
  completed:'Установлено', rolled_back:'Откат выполнен', failed:'Ошибка',
};

function paintUpdate(state) {
  const panel = $('updatePanel');
  if (!panel || !state) return;
  const published = state.publishedAt ? ` · ${fmtTime(new Date(state.publishedAt).getTime())}` : '';
  const progress = state.progress;
  const history = state.history ?? [];
  const historyHtml = history.length ? `<details><summary>История операций · ${history.length}</summary><div class="group">${history.slice(0,20).map((row) => `<div class="item">
    <span><b>${row.action === 'rollback' ? 'Откат' : 'Обновление'}${row.version ? ` · ${esc(row.version)}` : ''}</b><span class="hint">${fmtTime(Number(row.created_at))} · ${esc(row.actor_key)}</span></span>
    <span class="badge ${row.status === 'failed' ? 'danger' : row.status === 'completed' || row.status === 'rolled_back' ? 'ok' : ''}">${esc(UPDATE_STATUS[row.status] ?? row.status)}</span></div>`).join('')}</div></details>` : '';
  const progressHtml = progress ? `<div class="ops-card"><header><b>${esc(UPDATE_STATUS[progress.status] ?? progress.status)}</b><span class="badge ${progress.status === 'failed' ? 'danger' : progress.status === 'completed' || progress.status === 'rolled_back' ? 'ok' : ''}">${Number(progress.percent ?? 0)}%</span></header>
    <div class="progress"><i style="width:${Math.max(0,Math.min(100,Number(progress.percent ?? 0)))}%"></i></div>
    <div class="meta"><span>${esc(progress.stage || progress.detail || 'Ожидает ограниченный host-updater')}</span>${progress.backupPath ? '<span>Резервная копия подтверждена</span>' : ''}</div></div>` : '';
  const safety = `<div class="update-safety"><span>Кнопка запускает полную установку.</span><span>Изолированный host-updater скачивает и проверяет релиз.</span><span>Перед заменой создаётся резервная копия; затем выполняются health-check и автоматический откат при ошибке.</span></div>`;
  const changelog = state.changelog ? `<details><summary>Что изменилось в ${esc(state.tag ?? state.latest ?? '')}</summary><pre class="log" style="white-space:pre-wrap;max-height:260px">${esc(state.changelog)}</pre></details>` : '';
  const rollback = state.compatibility?.rollbackAvailable ? '<button class="btn danger" id="updateRollback">Откатить</button>' : '';

  if (!state.enabled) {
    panel.innerHTML = `<div><b>Обновления отключены</b><span class="hint">Включаются через UPDATE_ENABLED на сервере. Текущая версия v${esc(state.current)}.</span></div>${progressHtml}${historyHtml}`;
    return;
  }
  const title = progress && ['queued','backing_up','installing','checking'].includes(progress.status)
    ? `Обновление выполняется: ${UPDATE_STATUS[progress.status]}`
    : state.available ? `Доступна версия ${esc(state.latest)}`
    : `Установлена актуальная версия v${esc(state.current)}`;
  const error = state.error ? `<div class="badge danger">Проверка релиза: ${esc(state.error)}</div>` : '';
  const install = state.tag && !state.queued && state.available
    ? `<button class="btn primary" id="updateApply">Установить v${esc(state.latest)}</button>` : '';
  const reinstall = state.tag && !state.queued && !state.available && state.reinstallable
    ? `<details><summary>Восстановление</summary><button class="btn" id="updateReinstall">Переустановить v${esc(state.current)}</button></details>` : '';
  panel.innerHTML = `<div class="ops-head"><div><b>${title}</b><span class="hint">Канал: ${state.prerelease ? 'предрелизы' : 'стабильные релизы'}${published}</span></div>
    <div class="ops-actions">${install}${rollback}<button class="btn" id="updateRetry">Проверить</button></div></div>
    ${error}${safety}${progressHtml}${reinstall}${changelog}${historyHtml}`;
  $('updateRetry').onclick = () => loadUpdateState(true);
  if ($('updateApply')) $('updateApply').onclick = () => confirmAction('Установить обновление?',
    'Система скачает подписанный релиз, проверит контрольную сумму, создаст резервную копию, установит его и автоматически откатится при неуспешной проверке.', () => requestUpdate('update'));
  if ($('updateReinstall')) $('updateReinstall').onclick = () => confirmAction('Переустановить текущую версию?',
    'Это аварийное восстановление: текущий подписанный релиз будет скачан и установлен заново с резервной копией и автоматическим откатом.', () => requestUpdate('update', true));
  if ($('updateRollback')) $('updateRollback').onclick = () => confirmAction('Откатить обновление?',
    'Будет использована только резервная копия, которую ранее подтвердил host-updater.', () => requestUpdate('rollback'));
  clearInterval(updatePoll);
  if (state.queued || progress && ['queued','backing_up','installing','checking'].includes(progress.status)) {
    updatePoll = setInterval(loadUpdateState, 2000);
  }
}

async function requestUpdate(action, force = false) {
  const result = await mutate('/api/update/request', { method:'POST', body:JSON.stringify({ action, force }) });
  if (result?.update) { paintUpdate(result.update); toast(action === 'rollback' ? 'Откат поставлен в очередь' : 'Обновление поставлено в очередь'); }
}

async function loadUpdateState(force = false) {
  const panel = $('updatePanel');
  if (!canPermission('settings:update')) {
    panel.innerHTML = '<div><b>Центр обновлений</b><span class="hint">У вашей роли нет права управлять обновлениями.</span></div>';
    return;
  }
  if (panel && !panel.querySelector('.ops-head, .ops-card')) panel.innerHTML = '<span class="hint">Проверяю обновления…</span>';
  const retry = $('updateRetry');
  if (retry) retry.disabled = true;
  try {
    const response = await api(`/api/update${force === true ? '?force=1' : ''}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    const state = await response.json();
    paintUpdate(state);
    if (force === true) toast(state.error ? `Проверка завершилась с ошибкой: ${state.error}` : 'Проверка обновлений завершена');
  } catch (err) {
    panel.innerHTML = `<div><b>Центр обновлений недоступен</b><span class="hint">${esc(err instanceof Error ? err.message : String(err))}</span></div><button class="btn" id="updateRetry">Повторить проверку</button>`;
    $('updateRetry').onclick = () => loadUpdateState(true);
  } finally {
    const currentRetry = $('updateRetry');
    if (currentRetry) currentRetry.disabled = false;
  }
}

const SOURCE_APPLY_STATUS = {
  queued:'Ожидает безопасного исполнителя', backing_up:'Создаётся резервная копия',
  applying:'Применяется конфигурация', checking:'Проверяется здоровье приложения',
  completed:'Источник подключён', rolled_back:'Изменения отменены', failed:'Подключить не удалось',
};
let sourceApplyPoll = null;

function sourceProgressMarkup(state = settings?.sourceManagement) {
  const progress = state?.progress;
  if (!state?.queued && !progress) return '';
  const status = progress?.status ?? 'queued';
  const tone = status === 'completed' ? 'ok' : ['failed','rolled_back'].includes(status) ? 'danger' : 'warn';
  return `<div class="source-progress ${tone}"><div><b>${esc(SOURCE_APPLY_STATUS[status] ?? 'Добавление источника')}</b>
    <span>${esc(progress?.name || progress?.id || 'Запрос принят')}${progress?.stage ? ` · ${esc(progress.stage)}` : ''}</span></div>
    ${progress?.detail ? `<p>${esc(progress.detail)}</p>` : ''}</div>`;
}

function watchSourceApply() {
  clearInterval(sourceApplyPoll);
  const active = settings?.sourceManagement?.queued
    || ['queued','backing_up','applying','checking'].includes(settings?.sourceManagement?.progress?.status);
  if (!active) return;
  sourceApplyPoll = setInterval(async () => {
    let response;
    try { response = await api('/api/sources/status'); } catch { return; }
    if (!response.ok) return;
    const state = await response.json();
    if (!settings) return;
    settings.sourceManagement = state;
    renderSourceFoldersPanel();
    const finished = ['completed','failed','rolled_back'].includes(state?.progress?.status);
    if (finished) {
      clearInterval(sourceApplyPoll);
      sourceApplyPoll = null;
      toast(state.progress.status === 'completed' ? 'Источник подключён' : (state.progress.detail || 'Источник не подключён'));
      if (state.progress.status === 'completed') setTimeout(loadSettings, 1200);
    }
  }, 2200);
}

function openSourceWizard() {
  if (!canPermission('settings:sources')) return;
  const botSources = inboxSources.filter((source) => source.kind === 'telegram_bot');
  sheet('Добавить источник',
    `<div class="source-wizard-intro"><b>Новый канал в едином инбоксе</b><span>Секреты передаются только ограниченному host-исполнителю и не возвращаются в браузер.</span></div>
     <div class="frow"><label for="sourceType">Что подключаем</label><select id="sourceType">
       <option value="telegram_bot">Telegram-бот</option><option value="telegram_business">Telegram Business-аккаунт</option><option value="remnawave">Панель Remnawave</option><option value="minishop">MiniShop</option>
     </select></div><div id="sourceWizardFields"></div>`,
    '<button class="btn" id="sourceCancel">Отмена</button><button class="btn primary" id="sourceContinue">Подключить</button>');
  $('sourceCancel').onclick = closeSheet;

  const renderFields = () => {
    const kind = $('sourceType').value;
    const box = $('sourceWizardFields');
    if (kind === 'telegram_bot') {
      box.innerHTML = `<div class="frow"><label for="sourceName">Название бота</label><input id="sourceName" maxlength="120" placeholder="Например, VPN Support"></div>
        <div class="frow"><label for="sourceToken">Токен из @BotFather</label><input id="sourceToken" type="password" autocomplete="new-password" placeholder="123456789:AA…"><span class="hint">После применения токен исчезнет из запроса и не будет показан снова.</span></div>
        <div class="frow"><label for="sourceId">Технический ID · необязательно</label><input id="sourceId" maxlength="80" placeholder="support-bot-eu"><span class="hint">Если оставить пустым, будет создан безопасный уникальный ID.</span></div>`;
      $('sourceContinue').textContent = 'Подключить бота';
    } else if (kind === 'remnawave') {
      box.innerHTML = `<div class="frow"><label for="sourceName">Название панели</label><input id="sourceName" maxlength="120" placeholder="Например, Remnawave Europe"></div>
        <div class="frow"><label for="sourceUrl">URL панели</label><input id="sourceUrl" type="url" maxlength="1000" placeholder="https://panel.example.com"></div>
        <div class="frow"><label for="sourceToken">API-токен</label><input id="sourceToken" type="password" autocomplete="new-password" placeholder="Токен Remnawave"></div>
        <div class="frow"><label for="sourceId">Технический ID · необязательно</label><input id="sourceId" maxlength="80" placeholder="remnawave-eu"></div>
        <label class="source-readonly"><input id="sourceReadOnly" type="checkbox" checked><span><b>Только чтение</b><small>Не разрешать сброс устройств и перевыпуск подписок из этой панели.</small></span></label>`;
      $('sourceContinue').textContent = 'Подключить панель';
    } else if (kind === 'minishop') {
      box.innerHTML = `<div class="frow"><label for="sourceName">Название магазина</label><input id="sourceName" maxlength="120" value="MiniShop"></div>
        <div class="frow"><label for="sourceUrl">URL MiniShop</label><input id="sourceUrl" type="url" maxlength="1000" placeholder="https://shop.example.com"></div>
        <div class="frow"><label for="sourceToken">Service token</label><input id="sourceToken" type="password" autocomplete="new-password" placeholder="MINISHOP_AI_SUPPORT_TOKEN"><span class="hint">Рекомендуется постоянный токен плагина ai-support.</span></div>
        <div class="frow"><label for="sourceMode">Режим API</label><select id="sourceMode"><option value="plugin">Плагин ai-support</option><option value="admin">Временный AdminBearer</option></select></div>`;
      $('sourceContinue').textContent = 'Подключить MiniShop';
    } else {
      const choices = botSources.length
        ? botSources.map((source) => `<li><b>${esc(source.name)}</b><span>${esc(source.id)}</span></li>`).join('')
        : '<li><b>Сначала добавьте Telegram-бота</b><span>Именно ему Telegram передаёт события Business.</span></li>';
      box.innerHTML = `<div class="business-guide"><b>Подключение выполняется в самом Telegram</b>
        <ol><li>Откройте нужный аккаунт Telegram: Настройки → Telegram Business → Чат-боты.</li>
        <li>Выберите одного из ботов ниже и выдайте права читать сообщения и отвечать.</li>
        <li>Вернитесь сюда: аккаунт появится отдельным источником автоматически. Повторите для остальных аккаунтов.</li></ol>
        <ul>${choices}</ul><p>Один бот может обслуживать несколько Business-аккаунтов; папки и профиль сервиса настраиваются отдельно после подключения.</p></div>`;
      $('sourceContinue').textContent = botSources.length ? 'Понятно' : 'Добавить бота';
    }
  };
  $('sourceType').onchange = renderFields;
  renderFields();
  $('sourceContinue').onclick = async () => {
    const kind = $('sourceType').value;
    if (kind === 'telegram_business') {
      if (!botSources.length) { $('sourceType').value = 'telegram_bot'; renderFields(); $('sourceName').focus(); }
      else closeSheet();
      return;
    }
    const payload = { kind, name:$('sourceName').value.trim(), token:$('sourceToken').value.trim(), id:$('sourceId')?.value.trim() ?? '' };
    if (kind === 'remnawave') Object.assign(payload, { url:$('sourceUrl').value.trim(), readOnly:$('sourceReadOnly').checked });
    if (kind === 'minishop') Object.assign(payload, { url:$('sourceUrl').value.trim(), mode:$('sourceMode').value });
    if (!payload.name || !payload.token || (['remnawave','minishop'].includes(kind) && !payload.url)) return toast('Заполните обязательные поля');
    $('sourceContinue').disabled = true;
    const result = await mutate('/api/sources/request', { method:'POST', body:JSON.stringify(payload) });
    if (!result) { $('sourceContinue').disabled = false; return; }
    // Секрет сразу убираем из DOM ещё до закрытия окна.
    $('sourceToken').value = '';
    settings.sourceManagement = result.sourceManagement;
    closeSheet();
    renderSourceFoldersPanel();
    watchSourceApply();
    toast('Источник поставлен в очередь');
  };
}

function renderSourceFoldersPanel() {
  const box = $('sourceFolders');
  if (!box) return;
  const sourceWritable = canPermission('settings:sources');
  const serviceWritable = canPermission('settings:services');
  const profiles = settings?.serviceProfiles ?? {};
  const sourceRows = inboxSources.length ? inboxSources.map((source) => `<div class="source-row">
    <span class="source-kind">${esc(sourceKind(source.kind).slice(0, 3).toUpperCase())}</span>
    <div><b>${esc(profiles[source.id]?.serviceName || source.name)}</b><span>${esc(sourceKind(source.kind))} · ${esc(source.name)} · ${esc(source.id)}</span></div>
    <div class="source-actions"><span class="badge ok">${profiles[source.id] ? 'свой профиль' : 'общий профиль'}</span>
      ${serviceWritable ? `<button class="btn" data-edit-service="${esc(source.id)}">Настроить</button>` : ''}</div>
  </div>`).join('') : '<div class="source-row"><div><b>Входящие источники не подключены</b><span>Панель продолжает работать в голом режиме.</span></div></div>';
  const folderRows = inboxFolders.length ? inboxFolders.map((folder) => {
    const names = folder.source_ids.map((id) => inboxSources.find((source) => source.id === id)?.name ?? id);
    return `<div class="folder-row">
      <span class="folder-dot" style="--folder-color:${safeColor(folder.color)}"></span>
      <div><b>${esc(folder.name)}</b><span>${esc(names.join(' · ') || 'Источники пока не выбраны')}</span></div>
      ${sourceWritable ? `<button class="btn" data-edit-folder="${folder.id}">Изменить</button>` : ''}
    </div>`;
  }).join('') : '<div class="folder-row"><div><b>Своих папок пока нет</b><span>Один источник можно включить в несколько папок.</span></div></div>';
  box.innerHTML = `${sourceProgressMarkup()}<div class="source-folders-head"><div><b>Подключённые источники</b><span>${inboxSources.length} активных подключений</span></div>${sourceWritable ? '<button class="btn primary" id="newSource">Добавить источник</button>' : ''}</div>
    <div class="source-list">${sourceRows}</div>
    <div class="source-folders-head"><div><b>Папки инбокса</b><span>Состав может пересекаться</span></div>${sourceWritable ? '<button class="btn primary" id="newInboxFolder">Новая папка</button>' : ''}</div>
    <div class="folder-list">${folderRows}</div>`;
  if (sourceWritable) {
    $('newSource').onclick = openSourceWizard;
    $('newInboxFolder').onclick = () => openFolderEditor();
  }
  for (const button of box.querySelectorAll('[data-edit-service]')) {
    button.onclick = () => openServiceEditor(inboxSources.find((source) => source.id === button.dataset.editService));
  }
  for (const button of box.querySelectorAll('[data-edit-folder]')) {
    button.onclick = () => openFolderEditor(inboxFolders.find((folder) => folder.id === Number(button.dataset.editFolder)) ?? null);
  }
}

function openServiceEditor(source) {
  if (!canPermission('settings:services') || !source) return;
  const profile = settings?.serviceProfiles?.[source.id] ?? {};
  const serviceName = profile.serviceName || (source.kind === 'remnawave' ? source.name : settings.runtime.brand);
  const greetingMessage = profile.greetingMessage || '';
  const handoffMessage = profile.handoffMessage || settings.runtime.handoffMessage || '';
  sheet('Профиль сервиса',
    `<div class="service-profile-copy"><b>${esc(source.name)}</b><span>${esc(sourceKind(source.kind))} · ${esc(source.id)}</span></div>
     <div class="frow"><label for="serviceName">Название для клиента и AI</label><input id="serviceName" type="text" maxlength="80" value="${esc(serviceName)}" placeholder="Название сервиса"></div>
     <div class="frow"><label for="serviceGreeting">Приветствие первого ответа</label><textarea id="serviceGreeting" rows="3" maxlength="600" placeholder="Можно оставить пустым">${esc(greetingMessage)}</textarea><span class="hint">Добавляется один раз — перед первым содержательным ответом.</span></div>
     <div class="frow"><label for="serviceHandoff">Фраза передачи человеку</label><textarea id="serviceHandoff" rows="3" maxlength="600">${esc(handoffMessage)}</textarea><span class="hint">Используется и для напоминания, пока диалог ждёт оператора.</span></div>
     <p class="hint">Связанная панель Remnawave имеет приоритет над общим ботом или Telegram Business. Управление остаётся в одном инбоксе.</p>`,
    '<button class="btn" id="cancel">Отмена</button><button class="btn primary" id="saveService">Сохранить профиль</button>');
  $('cancel').onclick = closeSheet;
  $('saveService').onclick = async () => {
    const payload = {
      serviceName: $('serviceName').value.trim(),
      greetingMessage: $('serviceGreeting').value.trim(),
      handoffMessage: $('serviceHandoff').value.trim(),
    };
    if (!payload.serviceName) return toast('Введите название сервиса');
    $('saveService').disabled = true;
    const result = await mutate(`/api/settings/services/${encodeURIComponent(source.id)}`, {
      method:'POST', body:JSON.stringify(payload),
    }, 'Профиль сервиса сохранён');
    if (!result) { $('saveService').disabled = false; return; }
    settings.serviceProfiles = result.serviceProfiles ?? settings.serviceProfiles;
    closeSheet();
    renderSourceFoldersPanel();
  };
}

function openFolderEditor(folder = null) {
  if (!canPermission('settings:sources')) return;
  const selected = new Set(folder?.source_ids ?? []);
  const checks = inboxSources.length ? inboxSources.map((source) => `<label class="folder-check">
    <input type="checkbox" value="${esc(source.id)}"${selected.has(source.id) ? ' checked' : ''}>
    <span><b>${esc(source.name)}</b><small>${esc(sourceKind(source.kind))}</small></span>
  </label>`).join('') : '<span class="hint">Сначала подключите источник на сервере. Пустую папку всё равно можно создать.</span>';
  sheet(folder ? 'Изменить папку' : 'Новая папка',
    `<div class="frow"><label for="folderName">Название</label><input id="folderName" type="text" maxlength="80" value="${esc(folder?.name ?? '')}" placeholder="Например, VPN техподдержка"></div>
     <div class="frow"><label for="folderColor">Цвет метки</label><input id="folderColor" type="color" value="${safeColor(folder?.color)}"></div>
     <div class="frow"><label>Источники · можно повторять в других папках</label><div class="folder-checks">${checks}</div></div>`,
    `${folder ? '<button class="btn danger" id="deleteFolder">Удалить</button>' : ''}<button class="btn" id="cancel">Отмена</button><button class="btn primary" id="saveFolder">Сохранить</button>`);
  $('cancel').onclick = closeSheet;
  $('saveFolder').onclick = async () => {
    const name = $('folderName').value.trim();
    if (!name) return toast('Введите название папки');
    const sourceIds = [...$('sheet').querySelectorAll('.folder-check input:checked')].map((input) => input.value);
    $('saveFolder').disabled = true;
    const result = await mutate('/api/inbox/folders', { method:'POST', body:JSON.stringify({ id:folder?.id, name, color:$('folderColor').value, sourceIds }) }, 'Папка сохранена');
    if (!result) { $('saveFolder').disabled = false; return; }
    inboxFolders = result.folders ?? inboxFolders;
    closeSheet(); renderInboxTabs(); renderSourceFoldersPanel(); renderList(true);
  };
  if ($('deleteFolder')) $('deleteFolder').onclick = () => confirmAction('Удалить папку?',
    'Диалоги и источники останутся на месте — исчезнет только эта группировка.', async () => {
      const result = await mutate(`/api/inbox/folders/${folder.id}`, { method:'DELETE' }, 'Папка удалена');
      if (!result) return;
      inboxFolders = result.folders ?? inboxFolders;
      if (filter === `folder:${folder.id}`) filter = 'all';
      closeSheet(); renderInboxTabs(); renderSourceFoldersPanel(); renderList(true);
    });
}

$('manageFolders').onclick = () => openFolderEditor();

async function loadSettings() {
  settings = await json('/api/settings'); if (!settings) return;
  inboxSources = settings.sources ?? inboxSources;
  inboxFolders = settings.folders ?? inboxFolders;
  renderInboxTabs();
  renderSourceFoldersPanel();
  watchSourceApply();
  $('ver').textContent = 'v' + settings.version;
  const settingRows = new Map(FIELDS.map((f) => {
    const value = settings.runtime[f.key];
    const inactive = f.active && !f.active(settings.runtime);
    const fieldWritable = canPermission(`setting:${f.key}`);
    // Сравниваем строками: в runtime булево true, в option — строка 'true',
    // и строгое равенство ничего не подсвечивало.
    const selected = f.kind === 'level' ? nearestLevel(value) : String(value);
    const control = (f.kind === 'select' || f.kind === 'level')
      ? `<select class="ctl" id="setting-${f.key}" data-key="${f.key}" aria-describedby="setting-hint-${f.key}" ${fieldWritable ? '' : 'disabled'}>${f.options.map(([v,t]) =>
          `<option value="${v}"${String(v)===selected?' selected':''}>${esc(t)}</option>`).join('')}</select>`
      : `<input class="ctl" id="setting-${f.key}" type="${f.kind}" data-key="${f.key}" value="${esc(value)}" aria-describedby="setting-hint-${f.key}"${f.attrs
          ? ` min="${f.attrs.min}" max="${f.attrs.max}" step="${f.attrs.step}"` : ''} ${fieldWritable ? '' : 'disabled'}>`;
    return [f.key, `<div class="setting-row${inactive ? ' is-inactive' : ''}" data-setting="${f.key}">
      <div class="setting-main"><label class="setting-label" for="setting-${f.key}">${esc(f.label)}</label><span class="setting-control">${control}</span></div>
      <div class="setting-meta"><button class="why" data-why="${f.key}" aria-expanded="false">Зачем это?</button>${inactive ? '<span class="setting-badge">Только в авто</span>' : ''}</div>
      <span class="hint why-text" id="setting-hint-${f.key}" data-whytext="${f.key}">${esc(f.hint)}${
        inactive ? '<br><b>Сейчас не действует: включается в режиме «отвечает сам».</b>' : ''}</span>
    </div>`];
  }));
  $('aiSettings').innerHTML = SETTINGS_GROUPS.map((group) => `<section class="settings-cluster" data-cluster="${group.id}">
    <header class="settings-cluster-head"><span class="cluster-mark" aria-hidden="true"></span><div><h3>${esc(group.title)}</h3><p>${esc(group.note)}</p></div></header>
    <div class="settings-panel">${group.fields.map((field) => settingRows.get(field)).join('')}</div>
  </section>`).join('').replace(/&lt;b&gt;/g,'<b>').replace(/&lt;\/b&gt;/g,'</b>').replace(/&lt;br&gt;/g,'<br>') + `
    <section class="settings-cluster" data-cluster="voice">
      <header class="settings-cluster-head"><span class="cluster-mark" aria-hidden="true"></span><div><h3>Тон и передача</h3><p>Как звучит помощник и что видит клиент при передаче оператору</p></div></header>
      <div class="settings-panel copy-settings">
        <div class="copy-setting">
          <div class="copy-setting-head"><label for="styleBox">Манера ответа</label><span>до 1200 символов</span></div>
          <textarea id="styleBox" rows="4" maxlength="1200" placeholder="Как AI должен формулировать ответы">${esc(settings.runtime.replyStyle ?? '')}</textarea>
          <span class="hint">Например: «пиши коротко», «обращайся на ты», «не используй нумерованные списки».</span>
          <button class="btn" id="styleSave">Сохранить манеру</button>
        </div>
        <div class="copy-setting">
          <div class="copy-setting-head"><label for="handoffBox">Сообщение при передаче человеку</label><span>до 600 символов</span></div>
          <textarea id="handoffBox" rows="3" minlength="5" maxlength="600">${esc(settings.runtime.handoffMessage ?? '')}</textarea>
          <span class="hint">После этого AI молчит по существу, пока оператор не ответит.</span>
          <button class="btn" id="handoffSave">Сохранить текст</button>
        </div>
      </div>
    </section>`;
  if (!FIELDS.some((field) => canPermission(`setting:${field.key}`))) {
    $('aiSettings').insertAdjacentHTML('afterbegin', '<div class="ops-note"><b>Режим просмотра</b><span class="hint">У роли нет прав на изменение этих параметров.</span></div>');
  }
  for (const el of $('aiSettings').querySelectorAll('[data-key]')) {
    if (!canPermission(`setting:${el.dataset.key}`)) {
      el.title = 'Это поле запрещено настройками роли';
      continue;
    }
    el.onchange = async () => {
      const row = el.closest('.setting-row');
      row.classList.add('is-saving'); el.disabled = true; showSettingsSaveState('saving', 'Сохраняю…');
      const saved = await mutate('/api/settings', { method:'POST', body: JSON.stringify({ [el.dataset.key]: el.value }) });
      row.classList.remove('is-saving'); el.disabled = false;
      if (saved?.runtime) {
        settings.runtime = saved.runtime;
        for (const f of FIELDS) {
          const target = $('aiSettings').querySelector(`[data-setting="${f.key}"]`); if (!target) continue;
          const inactive = f.active && !f.active(settings.runtime);
          target.classList.toggle('is-inactive', Boolean(inactive));
          let badge = target.querySelector('.setting-badge');
          if (inactive && !badge) { badge = Object.assign(document.createElement('span'), { className:'setting-badge', textContent:'Только в авто' }); target.querySelector('.setting-meta').append(badge); }
          if (!inactive) badge?.remove();
          const hint = target.querySelector('.why-text');
          hint.innerHTML = `${esc(f.hint)}${inactive ? '<br><b>Сейчас не действует: включается в режиме «отвечает сам».</b>' : ''}`;
        }
        showSettingsSaveState('saved', 'Сохранено');
      } else showSettingsSaveState('error', 'Не сохранено');
    };
  }
  for (const b of $('aiSettings').querySelectorAll('.why')) {
    b.onclick = () => {
      const text = $('aiSettings').querySelector(`[data-whytext="${b.dataset.why}"]`);
      const open = text.classList.toggle('open');
      b.setAttribute('aria-expanded', String(open));
      b.textContent = open ? 'Скрыть описание' : 'Зачем это?';
    };
  }

  // Список моделей провайдера: набирать вручную — верный способ опечататься.
  // Выбор модели и ключа — для основной и запасной одинаково. Ключ важен:
  // у провайдеров лимит бывает и на модель, и на аккаунт, и если запасная
  // ходит тем же ключом, при аккаунтном лимите она не спасает.
  for (const [field, keyField, title] of [
    ['model', 'modelKey', 'Основная модель'],
    ['fallbackModel', 'fallbackKey', 'Запасная модель'],
  ]) {
    const input = $('aiSettings').querySelector(`[data-key="${field}"]`);
    if (!input || !canPermission(`setting:${field}`) || !canPermission(`setting:${keyField}`) || !canPermission('settings:ai_tools')) continue;
    const pick = document.createElement('button');
    pick.className = 'btn model-pick';
    pick.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M4 10h8M4 14h10"/></svg><span>Выбрать</span>';
    pick.onclick = async () => {
      pick.disabled = true;
      const [models, keys] = await Promise.all([json('/api/ai/models'), json('/api/ai/keys')]);
      pick.disabled = false;
      if (!models) return toast('Провайдер не отдал список моделей');
      const current = settings.runtime[field];
      const boundKey = settings.runtime[keyField] ?? -1;
      sheet(title,
        `<div class="frow"><label>Модель · найдено ${models.models.length}</label>
           <select id="modelPick" size="10" style="height:auto">${
             (field === 'fallbackModel' ? ['', ...models.models] : models.models).map((m) =>
               `<option value="${esc(m)}"${m === current ? ' selected' : ''}>${m ? esc(m) : '— без запасной —'}</option>`).join('')}</select></div>
         <div class="frow"><label>Каким ключом ходит</label>
           <select id="keyPick">
             <option value="-1"${boundKey === -1 ? ' selected' : ''}>Любой доступный</option>
             ${(keys?.keys ?? []).map((k, i) =>
               `<option value="${i}"${boundKey === i ? ' selected' : ''}>Ключ #${i + 1} · ${esc(k)}</option>`).join('')}
           </select>
           <span class="hint">Если у провайдера лимит считается на аккаунт, запасной модели нужен свой ключ — иначе она упрётся в тот же потолок.</span>
         </div>`,
        `<button class="btn" id="cancel">Отмена</button><button class="btn primary" id="useModel">Применить</button>`);
      $('cancel').onclick = closeSheet;
      $('useModel').onclick = async () => {
        const patch = { [field]: $('modelPick').value, [keyField]: Number($('keyPick').value) };
        if (await mutate('/api/settings', { method:'POST', body: JSON.stringify(patch) }, 'Сохранено')) {
          closeSheet(); loadSettings();
        }
      };
    };
    input.after(pick);
  }

  if (canPermission('setting:replyStyle')) {
    $('styleSave').onclick = async () => {
      showSettingsSaveState('saving', 'Сохраняю…'); $('styleSave').disabled = true;
      const saved = await mutate('/api/settings', { method:'POST', body: JSON.stringify({ replyStyle: $('styleBox').value }) }, 'Манера сохранена');
      $('styleSave').disabled = false; showSettingsSaveState(saved ? 'saved' : 'error', saved ? 'Сохранено' : 'Не сохранено');
    };
  } else { $('styleBox').disabled = true; $('styleSave').disabled = true; }
  if (canPermission('setting:handoffMessage')) {
    $('handoffSave').onclick = async () => {
      showSettingsSaveState('saving', 'Сохраняю…'); $('handoffSave').disabled = true;
      const saved = await mutate('/api/settings', { method:'POST', body: JSON.stringify({ handoffMessage: $('handoffBox').value }) }, 'Текст сохранён');
      $('handoffSave').disabled = false; showSettingsSaveState(saved ? 'saved' : 'error', saved ? 'Сохранено' : 'Не сохранено');
    };
  } else { $('handoffBox').disabled = true; $('handoffSave').disabled = true; }

  const caps = settings.remnawave;
  const business = settings.businessConnectionLive;
  const healthCards = [
    { label:'Telegram Business', value:settings.channels.tg_dm ? 'Подключён' : 'Не подключён', tone:settings.channels.tg_dm ? 'ok' : 'off' },
    { label:'Telegram-бот', value:settings.channels.tg_bot ? 'Принимает личные сообщения' : 'Не подключён', tone:settings.channels.tg_bot ? 'ok' : 'off' },
    { label:'Bedolaga', value:settings.channels.bedolaga ? 'Тикеты подключены' : 'Не подключена', tone:settings.channels.bedolaga ? 'ok' : 'off' },
    { label:'MiniShop', value:settings.channels.minishop ? 'Тикеты подключены' : 'Не подключён', tone:settings.channels.minishop ? 'ok' : 'off' },
    { label:'Business Connection', value:business?.enabled ? (business.canReply ? 'Можно отвечать' : 'Нет права отвечать') : business ? 'Отключено в аккаунте' : 'Нет подключения', tone:business?.enabled && business.canReply ? 'ok' : business ? 'warn' : 'off' },
    { label:'Remnawave', value:caps ? (caps.index?.size ? `${caps.index.size} клиентов в индексе` : 'Подключён') : 'Не подключён', tone:caps ? 'ok' : 'off' },
    { label:'Уведомления', value:settings.alerts?.configured ? (settings.alerts.lastError ? `Ошибка: ${settings.alerts.lastError}` : `Работают · отправлено ${settings.alerts.sent}`) : 'ALERT_CHAT_ID не задан', tone:settings.alerts?.lastError ? 'error' : settings.alerts?.configured ? 'ok' : 'off' },
    { label:'AI-модели', value:settings.ai ? `${settings.ai.model}${settings.ai.fallback ? ` → ${settings.ai.fallback}` : ''} · ключей ${settings.ai.keys}` : 'Не настроены', tone:settings.ai?.keys ? 'accent' : 'warn' },
    { label:'Мониторинг узлов', value:settings.nodes ? `${settings.nodes.known} узлов${settings.nodes.at ? ` · ${fmtTime(settings.nodes.at)}` : ''}` : 'Выключен', tone:settings.nodes ? 'ok' : 'off' },
    { label:'База знаний', value:`${settings.kb} статей`, tone:settings.kb ? 'accent' : 'warn' },
    { label:'Доступ Remnawave', value:settings.readOnly ? 'Только чтение' : 'Действия разрешены', tone:settings.readOnly ? 'neutral' : 'warn' },
    { label:'Последний опрос Bedolaga', value:settings.lastBedolagaPoll ? fmtTime(Number(settings.lastBedolagaPoll)) : 'Данных нет', tone:settings.lastBedolagaPoll ? 'ok' : 'off' },
    { label:'Последний опрос MiniShop', value:settings.lastMinishopPoll ? fmtTime(Number(settings.lastMinishopPoll)) : 'Данных нет', tone:settings.lastMinishopPoll ? 'ok' : 'off' },
  ];
  $('health').innerHTML = healthCards.map((card) => `<article class="health-card ${card.tone}"><span class="health-status"><i></i></span><div><b>${esc(card.label)}</b><span>${esc(card.value)}</span></div></article>`).join('')
    + `<div class="health-action"><div><b>Проверка уведомлений</b><span>Отправим тестовое сообщение в служебный чат.</span></div><button class="btn" id="testAlert">Отправить тест</button></div>`;
  if (canPermission('settings:alerts')) {
    $('testAlert').onclick = async () => {
      $('testAlert').disabled = true;
      await mutate('/api/settings/test-alert', { method:'POST' }, 'Отправлено — проверьте чат');
      $('testAlert').disabled = false;
      loadSettings();
    };
  } else {
    $('testAlert').disabled = true;
    $('testAlert').title = 'Проверка запрещена настройками роли';
  }
  requestAnimationFrame(() => scrollToSettingsCategory(requestedSettingsSection, false));
  void loadUpdateState();
}

/* ═══ живое обновление ═══ */
// Сервер закрывает сокет, когда истекает его билет. Поэтому при каждом
// обновлении билета заранее открываем новый сокет и только после его
// открытия закрываем старый: окна без событий нет. Пока сокет не OPEN,
// работает HTTP-опрос; после восстановления связи — одна полная сверка.
let liveSocket = null, pendingSocket = null, liveRetryTimer = null, liveFailures = 0, liveNeedsResync = false;
const liveOpen = () => liveSocket?.readyState === WebSocket.OPEN;

function connect() {
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
  if (document.visibilityState !== 'visible' || !currentActor) return;
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
async function rotateTicket() {
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
  if (frame.type === 'message' && current?.id === frame.conversation.id) {
    const nearBottom = $('thread').scrollHeight - $('thread').scrollTop - $('thread').clientHeight < 140;
    current = frame.conversation;
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
    if (frame.message.direction === 'in') {
      suggestion = null; renderSuggestion(); markOpenConversationRead(frame.conversation.id);
    }
    renderWindow(); renderAiNote();
  }
  if (frame.type === 'message_updated' && current?.id === frame.conversation.id) {
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
  if (frame.type === 'message_deleted' && current?.id === frame.conversation.id) {
    const inner = $('thread').dataset.conversationId === String(frame.conversation.id)
      ? $('thread').querySelector('.thread-inner') : null;
    inner?.querySelector(`.msg[data-message-id="${frame.message.id}"]`)?.remove();
    if (inner && !inner.querySelector('.msg[data-message-id]')) {
      inner.innerHTML = '<p class="empty">Сообщений пока нет.</p>';
    }
  }
  if (frame.type === 'suggestion' && current?.id === frame.conversation.id) { suggestion = frame.suggestion; renderSuggestion(); }
  // Кадр с карточкой уже применён локально: перезапрашивать весь список
  // незачем. Сверка нужна только для кадров без данных.
  if (!frame.conversation) refreshSoon();
}

/** Ссылка из уведомления вида /#c12 открывает нужный диалог сразу. */
async function openFromHash() {
  const match = /^#c(\d+)$/.exec(location.hash);
  if (!match) return;
  show('inbox');
  await open(Number(match[1]));
}
window.addEventListener('hashchange', openFromHash);

async function boot() {
  const identity = await json('/api/me');
  currentActor = identity?.actor ?? null;
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
  templates = canPermission('templates:read') ? (await json('/api/templates'))?.templates ?? [] : [];
  $('templates').innerHTML = '<option value="">Шаблон…</option>';
  $('templates').append(...templates.map(t => Object.assign(document.createElement('option'), { value:String(t.id), textContent:t.title })));
  settings = canPermission('settings:read') ? await json('/api/settings') : null;
  if (settings) $('ver').textContent = 'v' + settings.version;
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
if (token) {
  try { savedTokenCheck = await checkToken(token); }
  catch { openGate('Сервер сейчас недоступен. Проверьте соединение и попробуйте снова.'); }
}
if (savedTokenCheck?.ok) {
  $('app').hidden = false;
  await boot();
} else if (!token) {
  openGate('');
} else if (savedTokenCheck) {
  openGate(savedTokenCheck.status === 429 ? 'Слишком много попыток. Подождите минуту.' : 'Сохранённый токен больше не подходит');
}
