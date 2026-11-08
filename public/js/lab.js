// Панель: песочница.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './iface.js';
import { $, esc } from './dom.js';
import { api } from './api.js';
import { toast } from './nav.js';

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
      ${d.operatorNote ? `<div class="item"><span class="lbl">Оператору</span><span class="val">${esc(d.operatorNote)}</span></div>` : ''}
      ${d.reason ? `<div class="item"><span class="lbl">Пояснение модели</span><span class="val">${esc(d.reason)}</span></div>` : ''}
    </div>
    <div class="cap" style="margin-top:var(--sp-5)">Что нашлось в базе знаний</div>
    <div class="group">${body.sources?.length
      ? body.sources.map((x) => `<div class="item"><span class="lbl">${esc(x)}</span>${body.usedSources?.includes(x) ? '<span class="badge ok">использовано</span>' : ''}</div>`).join('')
      : '<div class="item"><span class="hint">Ничего — значит ответ построен вслепую.</span></div>'}</div>`;
};
