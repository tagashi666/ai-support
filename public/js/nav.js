// Панель: навигация, листы и глобальный поиск.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './layout.js';
import { $, esc } from './dom.js';
import { json } from './api.js';
import { settingsScroller, setSettingsCategory } from './theme.js';
import { channelLabel, conversationStatus } from './inbox-list.js';
import { clearQuote } from './thread.js';
import { open } from './conversation.js';
import { loadDocs } from './kb.js';
import { loadNodes } from './nodes.js';
import { loadStats } from './stats.js';
import { loadQueue } from './queue.js';
import { loadTeam } from './team.js';
import { loadDiagnostics } from './diag.js';
import { loadSettings } from './settings.js';

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
export const viewLoadTasks = new Map();
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

export async function show(view) {
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

export function animateContentChange(element) {
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

export function toast(text) {
  const el = $('toast'); el.textContent = text; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 2600);
}
let sheetReturn = null;
export function sheet(title, body, foot, variant = '') {
  sheetReturn = document.activeElement;
  $('sheet').className = variant ? `sheet ${variant}` : 'sheet';
  $('sheet').innerHTML = `<header><b>${esc(title)}</b><button class="btn quiet sheet-close" id="sheetX">Закрыть</button></header>
    <div class="body">${body}</div><div class="foot">${foot ?? ''}</div>`;
  $('backdrop').hidden = false;
  $('sheetX').onclick = closeSheet;
  requestAnimationFrame(() => $('sheetX').focus());
}
export const closeSheet = () => {
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
