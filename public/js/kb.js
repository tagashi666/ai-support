// Панель: база знаний.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './inbox-actions.js';
import { state } from './state.js';
import { $, esc } from './dom.js';
import { json, mutate } from './api.js';
import { canPermission, canReview } from './access.js';
import { animateContentChange, sheet, closeSheet, toast } from './nav.js';
import { confirmAction } from './inspector.js';
import { loadInterfaceKb, renderInterface } from './iface.js';

/* ═══ база знаний ═══ */
$('kbTabs').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tab === 'learning' && !canReview()) return;
  state.kbTab = b.dataset.tab;
  for (const o of $('kbTabs').children) o.setAttribute('aria-pressed', String(o === b));
  renderDocs();
  animateContentChange($('docs'));
  if (state.kbTab === 'interface') loadInterfaceKb().then((data) => { if (data && state.kbTab === 'interface') renderDocs(); });
};
export async function loadDocs() {
  const [data, learning] = await Promise.all([
    json('/api/kb'),
    canReview() ? json('/api/learning/candidates?status=pending') : Promise.resolve(null),
  ]);
  if (data) {
    state.docs = { ...data, candidates: learning?.candidates ?? [] };
    if (canPermission('knowledge:read')) await loadInterfaceKb();
    renderDocs();
  }
  else if ($('view-kb').dataset.loaded !== 'true') $('docs').innerHTML = '<p class="empty">База знаний сейчас недоступна.</p>';
}
export function renderDocs() {
  const reviewer = canReview();
  const editor = canPermission('knowledge:manage');
  if (!reviewer && state.kbTab === 'learning') state.kbTab = 'kb';
  const list = state.kbTab === 'kb' ? state.docs.kb : state.kbTab === 'interface' ? state.docs.interfaceScreens : state.kbTab === 'draft' ? state.docs.drafts : state.docs.candidates;
  $('cntKb').textContent = state.docs.kb.length;
  $('kbHint').textContent = state.kbTab === 'learning'
    ? 'AI ничего не публикует без решения lead/admin'
    : state.kbTab === 'draft'
    ? 'Черновики в ответы не идут, пока не опубликуешь'
    : state.kbTab === 'interface'
    ? `Проверенные инструкции русского интерфейса · ${state.docs.interfaceScreens.length} экранов в виде, который видит AI · включаются в настройках AI`
    : 'Правки подхватываются в течение 15 минут';
  const box = $('docs');
  if (state.kbTab === 'interface') return renderInterface(box);
  if (!list.length) {
    box.innerHTML = `<p class="empty">${state.kbTab === 'kb' ? 'Статей пока нет.' : state.kbTab === 'learning' ? 'Новых кандидатов на обучение нет.' : 'Черновиков нет. Соберите их из переписки.'}</p>`;
    return;
  }
  if (state.kbTab === 'learning') {
    // Кандидат — файл в черновиках: прежде чем принять, его надо прочитать
    // (и при праве на правку — поправить). Раньше открыть было нельзя.
    box.innerHTML = list.map((d) => `<article class="doc-row review-row" data-edit="${esc(d.file_name)}" role="button" tabindex="0" aria-label="Открыть материал: ${esc(d.title)}">
      <div class="doc-state"><span class="status-dot warning"></span></div><div class="doc-copy"><b>${esc(d.title)}</b><span>v${d.version} · ${esc(d.source)}${d.confidence == null ? '' : ` · уверенность ${Math.round(d.confidence * 100)}%`} · ${esc(d.file_name)}</span></div><div class="doc-actions">
        <button class="btn primary" data-approve="${d.id}">Проверено — опубликовать</button>
        <button class="btn danger" data-reject="${d.id}">Отклонить</button><span class="doc-disclosure" aria-hidden="true">›</span></div></article>`).join('');
    for (const row of box.querySelectorAll('.review-row[data-edit]')) {
      row.onclick = (event) => { if (!event.target.closest('button')) editDoc(row.dataset.edit, 'draft'); };
      row.onkeydown = (event) => { if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('button')) { event.preventDefault(); editDoc(row.dataset.edit, 'draft'); } };
    }
    for (const b of box.querySelectorAll('[data-approve]')) b.onclick = async () => {
      if (await mutate(`/api/learning/candidates/${b.dataset.approve}`, { method:'POST', body:JSON.stringify({ decision:'approved' }) }, 'Материал опубликован')) loadDocs();
    };
    for (const b of box.querySelectorAll('[data-reject]')) b.onclick = async () => {
      if (await mutate(`/api/learning/candidates/${b.dataset.reject}`, { method:'POST', body:JSON.stringify({ decision:'rejected' }) }, 'Кандидат отклонён')) loadDocs();
    };
    return;
  }
  box.innerHTML = list.map((d) => `<article class="doc-row" data-doc="${esc(d.name)}" data-edit="${esc(d.name)}" role="button" tabindex="0" aria-label="Открыть статью: ${esc(d.title)}">
    <div class="doc-state"><span class="status-dot ${state.kbTab === 'kb' ? 'ok' : ''}"></span></div><div class="doc-copy"><b>${esc(d.title)}</b><span>${esc(d.name)} · ${d.size} симв.</span></div>
    <div class="doc-actions">${editor && state.kbTab === 'draft' ? `<button class="btn primary" data-pub="${esc(d.name)}">Опубликовать</button>` : ''}
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
    if (await mutate(`/api/kb/${state.kbTab}/${encodeURIComponent(b.dataset.del)}`, { method:'DELETE' }, 'Удалено')) loadDocs();
  });
}
async function editDoc(name, tab = state.kbTab) {
  const data = await json(`/api/kb/${tab}/${encodeURIComponent(name)}`);
  if (!data) { toast('Файл материала не найден — возможно, его уже удалили'); return; }
  sheet(name, `<textarea id="docText" ${canPermission('knowledge:manage') ? '' : 'readonly'}>${esc(data.text)}</textarea>`,
    canPermission('knowledge:manage') ? `<button class="btn" id="cancel">Отмена</button><button class="btn primary" id="save">Сохранить</button>` : '<button class="btn primary" id="cancel">Закрыть</button>');
  $('cancel').onclick = closeSheet;
  if (!canPermission('knowledge:manage')) return;
  $('save').onclick = async () => {
    const saved = await mutate(`/api/kb/${tab}/${encodeURIComponent(name)}`,
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
