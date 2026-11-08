// Панель: размеры колонок.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './gate.js';
import { $ } from './dom.js';

/* ═══ размеры колонок ═══
   Ширины двигаются мышью и запоминаются: на разных мониторах удобны
   разные пропорции, а угадать за пользователя нельзя. */
const LAYOUT = [
  { grip:'gripSide', target:() => $('app'), probe:'.sidebar', varName:'--w-side', min:170, max:340, sign:1 },
  { grip:'gripList', target:() => document.querySelector('.split'), probe:'.col.left', varName:'--w-list', min:240, max:620, sign:1 },
  { grip:'gripCtx',  target:() => $('app'), probe:'.context', varName:'--w-ctx', min:240, max:560, sign:-1 },
];
function applyLayout() {
  for (const item of LAYOUT) {
    // Сохранённую ширину зажимаем в те же границы, что и при перетаскивании:
    // значение, запомненное на узком мониторе, не должно применяться дословно
    // на 2К и превращать колонку в неуместно тонкую полосу.
    const saved = Number(localStorage.getItem(`layout:${item.varName}`));
    if (Number.isFinite(saved) && saved > 0) {
      const clamped = Math.min(item.max, Math.max(item.min, saved));
      item.target()?.style.setProperty(item.varName, `${clamped}px`);
    }
  }
}
for (const item of LAYOUT) {
  const grip = $(item.grip);
  if (!grip) continue;
  grip.onpointerdown = (e) => {
    const el = item.target();
    if (!el) return;
    const startX = e.clientX;
    // Значение по умолчанию задано через clamp() и как число не читается,
    // поэтому берём фактическую ширину колонки на экране.
    const probe = document.querySelector(item.probe);
    const startW = probe ? probe.getBoundingClientRect().width : 240;
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('dragging');
    document.body.classList.add('resizing');
    // Перерасчёт grid-раскладки всего приложения на каждый pointermove
    // (а их десятки за кадр) и есть источник рывков при ресайзе. Коалесцируем
    // в одну запись переменной на кадр через requestAnimationFrame.
    let raf = 0;
    let pendingX = startX;
    const move = (ev) => {
      pendingX = ev.clientX;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const next = Math.round(Math.min(item.max, Math.max(item.min, startW + (pendingX - startX) * item.sign)));
        el.style.setProperty(item.varName, `${next}px`);
      });
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      grip.releasePointerCapture(e.pointerId);
      grip.classList.remove('dragging');
      document.body.classList.remove('resizing');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      const finalWidth = document.querySelector(item.probe)?.getBoundingClientRect().width;
      if (finalWidth) localStorage.setItem(`layout:${item.varName}`, String(Math.round(finalWidth)));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  };
  // Двойной щелчок возвращает ширину по умолчанию.
  grip.ondblclick = () => {
    item.target()?.style.removeProperty(item.varName);
    localStorage.removeItem(`layout:${item.varName}`);
  };
}
applyLayout();
