// Панель: диагностика.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './team.js';
import { $, esc } from './dom.js';
import { json } from './api.js';
import { fmtLeft, fmtTime, channelLabel } from './inbox-list.js';

/* ═══ диагностика ═══ */
const mb = (bytes) => `${(Number(bytes ?? 0) / 1048576).toFixed(1)} МБ`;
export async function loadDiagnostics() {
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
