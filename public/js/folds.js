// Панель: свёрнутые разделы.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './nav.js';
import { renderSubscription } from './inspector.js';

/* ═══ свёрнутые разделы ═══
   Что открыто — запоминаем: у каждого оператора свой порядок работы. */
for (const fold of document.querySelectorAll('.fold')) {
  const key = `fold:${fold.dataset.fold}`;
  const saved = localStorage.getItem(key);
  if (saved !== null) fold.open = saved === '1';
  fold.addEventListener('toggle', () => {
    localStorage.setItem(key, fold.open ? '1' : '0');
    // Подписку тянем в тот момент, когда её решили посмотреть.
    if (fold.dataset.fold === 'sub' && fold.open) void renderSubscription();
  });
}
