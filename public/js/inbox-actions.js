// Панель: инбокс: статус диалога, фильтры, поиск.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './composer.js';
import { state } from './state.js';
import { $ } from './dom.js';
import { mutate } from './api.js';
import { canPermission } from './access.js';
import { animateContentChange } from './nav.js';
import { renderList } from './inbox-list.js';
import { confirmAction, renderAiNote } from './inspector.js';
import { paintHeader, refresh, removeLiveConversation } from './conversation.js';

async function setState(patch) {
  if (!state.current || !canPermission('conversation:status')) return;
  const externalName = state.current.channel === 'bedolaga' ? 'Bedolaga'
    : state.current.channel === 'minishop' ? 'MiniShop' : null;
  const externalStatus = externalName && patch.status
    ? patch.status === 'resolved' ? `Тикет закрыт и в ${externalName}`
      : patch.status === 'open' ? `Тикет открыт и в ${externalName}`
      : `Статус тикета синхронизирован с ${externalName}`
    : null;
  const data = await mutate(`/api/conversations/${state.current.id}/state`,
    { method:'POST', body: JSON.stringify(patch) }, externalStatus);
  if (!data) { paintHeader(state.current); return; }
  state.current = data.conversation;
  paintHeader(state.current);
  renderAiNote(); refresh();
}
$('statusSel').onchange = (e) => setState({ status: e.target.value });
$('contextStatusSel').onchange = (e) => setState({ status: e.target.value });
$('aiSel').onchange = (e) => setState({ aiMode: e.target.value });
$('escBtn').onclick = () => setState({ escalated: !state.current?.escalated });
$('handoffBtn').onclick = () => setState({ handoff: !state.current?.handoff_at });
$('hideConversationBtn').onclick = () => {
  if (!state.current) return;
  const id = state.current.id;
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
  const changed = state.filter !== b.dataset.filter;
  state.filter = b.dataset.filter;
  for (const o of $('filters').children) o.setAttribute('aria-pressed', String(o === b));
  renderList();
  if (changed) animateContentChange($('list'));
};
$('listSearch').oninput = (e) => {
  state.listQuery = e.target.value.trim();
  renderList(true);
};
$('backToList').onclick = () => {
  $('inboxSplit').dataset.pane = 'list';
  history.replaceState(null, '', location.pathname + location.search);
  $('list').querySelector(`[data-id="${state.current?.id ?? ''}"]`)?.focus();
};
$('templates').onchange = (e) => {
  const found = state.templates.find(t => String(t.id) === e.target.value);
  if (found) { $('input').value = found.body; $('input').focus(); }
  e.target.value = '';
};
