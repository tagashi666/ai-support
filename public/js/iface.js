// Панель: справочник интерфейса.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './kb.js';
import { state } from './state.js';
import { $, esc } from './dom.js';
import { api, json, mutate, refreshTicket, reloadMedia } from './api.js';
import { canPermission } from './access.js';
import { animateContentChange, toast, sheet, closeSheet } from './nav.js';
import { confirmAction } from './inspector.js';
import { loadDocs, renderDocs } from './kb.js';

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

export async function loadInterfaceKb() {
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

export function renderInterface(box) {
  if (!ifaceKb) {
    box.innerHTML = '<p class="empty">Загрузка справочника…</p>';
    if (!ifaceLoading) {
      ifaceLoading = true;
      loadInterfaceKb().then((data) => {
        ifaceLoading = false;
        if (state.kbTab !== 'interface') return;
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
    headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/octet-stream' },
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
