// Панель: команда, роли и аудит.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './queue.js';
import { state } from './state.js';
import { $, esc } from './dom.js';
import { json, mutate } from './api.js';
import { canPermission, applyRoleUi } from './access.js';
import { animateContentChange, toast, sheet, closeSheet } from './nav.js';
import { fmtTime } from './inbox-list.js';
import { confirmAction } from './inspector.js';
import { fmtDur } from './stats.js';

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
    box.innerHTML = `<article class="ops-card"><header><b>${esc(state.currentActor?.name || 'Оператор')}</b><span class="badge">${esc(ROLE_LABELS[state.currentActor?.role] ?? state.currentActor?.role ?? '')}</span></header>
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
      state.currentActor = identity?.actor ?? state.currentActor; applyRoleUi();
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

export async function loadTeam() {
  const me = await json('/api/me');
  state.currentActor = me?.actor ?? state.currentActor;
  $('meLabel').textContent = state.currentActor ? `${state.currentActor.name} · ${ROLE_LABELS[state.currentActor.role] ?? state.currentActor.role}` : '';
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
