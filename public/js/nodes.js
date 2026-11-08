// Панель: серверы.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './lab.js';
import { $, esc } from './dom.js';
import { api, mutate } from './api.js';
import { canPermission } from './access.js';
import { toast } from './nav.js';
import { fmtTime, gb } from './inbox-list.js';

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

export async function loadNodes() {
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
