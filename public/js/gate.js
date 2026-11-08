// Панель: вход.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './theme.js';
import { state } from './state.js';
import { $ } from './dom.js';
import { boot } from './boot.js';

/* ═══ вход ═══
   Раньше здесь стоял prompt() — он не показывает ошибку, не даёт
   стереть неверный токен и выглядит как сбой браузера. */
export async function checkToken(candidate) {
  return fetch('/api/settings', { headers: { authorization: `Bearer ${candidate}` } });
}
export function openGate(message) {
  $('app').hidden = true;
  $('gate').hidden = false;
  $('gateErr').textContent = message ?? '';
  $('gateToken').focus();
}
$('gateForm').onsubmit = async (e) => {
  e.preventDefault();
  const candidate = $('gateToken').value.trim();
  if (!candidate) return;
  $('gateGo').disabled = true;
  $('gateErr').textContent = '';
  try {
    const res = await checkToken(candidate);
    if (res.ok) {
      state.token = candidate;
      localStorage.setItem('panelToken', candidate);
      $('gate').hidden = true;
      $('app').hidden = false;
      await boot();
    } else if (res.status === 429) {
      // Не «неверный токен», а временная блокировка за частые попытки: иначе
      // человек с верным токеном решает, что тот перестал работать.
      const wait = Number(res.headers.get('retry-after')) || 60;
      $('gateErr').textContent = `Слишком много попыток. Подождите ${wait} с и попробуйте снова.`;
    } else {
      $('gateErr').textContent = 'Токен не подошёл';
      $('gateToken').select();
    }
  } catch (err) {
    $('gateErr').textContent = `Сервер недоступен: ${err.message}`;
  }
  $('gateGo').disabled = false;
};
