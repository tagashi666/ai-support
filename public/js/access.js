// Панель: права оператора и роль в интерфейсе.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './api.js';
import { state } from './state.js';
import { $ } from './dom.js';
import { show } from './nav.js';

export const canPermission = (permission) => Boolean(state.currentActor?.root || state.currentActor?.permissions?.includes(permission));
export const canWrite = () => canPermission('conversation:reply');
export const canCompose = () => ['conversation:reply','conversation:attachments','conversation:notes'].some(canPermission);
export const canReview = () => canPermission('knowledge:review');

const ROLE_NAMES = { admin:'Администратор', lead:'Руководитель', agent:'Оператор', viewer:'Наблюдатель' };

export function applyRoleUi() {
  const reviewer = canReview();
  // Подпись внизу боковой панели — тот, кто вошёл, а не всегда «Владелец».
  const actor = state.currentActor;
  const actorName = $('actorName');
  if (actorName) {
    actorName.textContent = actor?.root ? 'Владелец' : (actor?.name || 'Оператор');
    actorName.title = actor?.root ? 'Вход по токену владельца' : (ROLE_NAMES[actor?.role] ?? '');
  }
  $('templates').disabled = !canPermission('templates:read');
  $('noteBtn').disabled = !canPermission('conversation:notes');
  $('attachBtn').disabled = !canPermission('conversation:attachments');
  $('captureBtn').disabled = !canPermission('conversation:attachments');
  $('statusSel').disabled = !canPermission('conversation:status');
  $('aiSel').disabled = !canPermission('conversation:status');
  $('escBtn').disabled = !canPermission('conversation:status');
  $('closeAllTickets').hidden = !canPermission('conversation:status');
  $('newDoc').hidden = !canPermission('knowledge:manage');
  $('mineBtn').hidden = !canPermission('knowledge:mine');
  $('manageFolders').hidden = !canPermission('settings:sources');
  $('slaPoliciesBtn').hidden = !canPermission('queue:manage');
  const learningTab = $('kbTabs').querySelector('[data-tab="learning"]');
  if (learningTab) learningTab.hidden = !reviewer;
  if (!reviewer && state.kbTab === 'learning') state.kbTab = 'kb';
  const viewPermissions = {
    inbox:'conversation:read', queue:'queue:read', kb:'knowledge:read', lab:'settings:ai_tools',
    nodes:'settings:nodes', stats:'stats:read', diagnostics:'diagnostics:read', settings:'settings:read',
  };
  for (const [view, permission] of Object.entries(viewPermissions)) {
    const button = document.querySelector(`.nav[data-view="${view}"]`);
    if (button) button.hidden = !canPermission(permission);
  }
  const teamVisible = ['team:read','operator_stats:read','roles:manage','audit:read'].some(canPermission);
  const teamButton = document.querySelector('.nav[data-view="team"]');
  if (teamButton) teamButton.hidden = !teamVisible;
  $('globalSearch').hidden = !canPermission('conversation:read');
  const activeNav = document.querySelector('.nav[data-view][aria-current="true"]');
  if (activeNav?.hidden) {
    const firstAllowed = document.querySelector('.nav[data-view]:not([hidden])');
    if (firstAllowed) show(firstAllowed.dataset.view);
  }
}
