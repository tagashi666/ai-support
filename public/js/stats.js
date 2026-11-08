// Панель: статистика.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './nodes.js';
import { $, esc } from './dom.js';
import { json, mutate } from './api.js';
import { canPermission } from './access.js';
import { viewLoadTasks, show } from './nav.js';
import { fmtDate, channelLabel } from './inbox-list.js';
import { confirmAction } from './inspector.js';

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

export const fmtDur = (ms) => {
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

export async function loadStats() {
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
