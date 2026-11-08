// Панель: очередь, SLA и сохранённые фильтры.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './stats.js';
import { $, esc } from './dom.js';
import { api, json, mutate } from './api.js';
import { canPermission } from './access.js';
import { show, toast, sheet, closeSheet } from './nav.js';
import { fmtLeft, channelLabel, conversationStatus } from './inbox-list.js';
import { confirmAction } from './inspector.js';
import { open, refresh } from './conversation.js';

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

export async function loadQueue() {
  if ($('view-queue').dataset.loaded !== 'true') $('queueBody').innerHTML = '<p class="empty">Загружаю очередь…</p>';
  const [queue, filtersData] = await Promise.all([json('/api/queue'), json('/api/filters')]);
  if (!queue) { $('queueBody').innerHTML = '<p class="empty">Очередь недоступна.</p>'; return; }
  queueRows = queue.conversations ?? [];
  queuePolicies = queue.policies ?? [];
  savedQueueFilters = filtersData?.filters ?? [];
  renderQueue();
}

/** Счётчики навигации загружаются при старте, а не после первого клика. */
export async function loadNavigationCounts() {
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
