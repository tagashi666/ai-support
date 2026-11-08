// Панель: оформление.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './access.js';
import { $ } from './dom.js';

/* ═══ оформление ═══ */
const THEMES = [
  ['system','Автоматически','Как в системе'],
  ['light','Светлая','Для яркого окружения'],
  ['dark','Тёмная','Для слабого освещения'],
];
const ACCENTS = [['system-blue','#0A84FF','Системный синий']];

$('themePick').innerHTML = THEMES.map(([id, name, description]) =>
  `<button type="button" class="theme-card" data-theme="${id}" title="${name}" aria-label="Тема: ${name} — ${description}">
     <span class="theme-preview" aria-hidden="true"><i class="preview-rail"></i><span class="preview-list"><i></i><i></i><i></i></span><span class="preview-chat"><i></i><i></i></span></span>
     <span class="theme-meta"><span><b>${name}</b><small>${description}</small></span><i class="theme-check">✓</i></span>
   </button>`).join('');
$('accentPick').innerHTML = ACCENTS.map(([n,hex,label]) =>
  `<button type="button" class="swatch" data-accent="${n}" style="--swatch:${hex}" title="${label}" aria-label="Акцент: ${label}"><i></i><span>${label}</span></button>`).join('');

function applyLook() {
  const savedTheme = localStorage.getItem('theme');
  const theme = THEMES.some(([id]) => id === savedTheme) ? savedTheme : 'system';
  const accent = 'system-blue';
  localStorage.setItem('accent', accent);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.accent = accent;
  for (const b of $('themePick').children) b.setAttribute('aria-pressed', String(b.dataset.theme === theme));
  for (const b of $('accentPick').children) b.setAttribute('aria-pressed', String(b.dataset.accent === accent));
}
$('themePick').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const change = () => { localStorage.setItem('theme', b.dataset.theme); applyLook(); };
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.documentElement.classList.add('theme-transition');
    const transition = document.startViewTransition(change);
    void transition.finished.finally(() => document.documentElement.classList.remove('theme-transition'));
  } else change();
};
$('accentPick').onclick = () => {};
applyLook();

// Навигация настроек следует за реальной позицией прокрутки, как в
// desktop settings: выбранная категория всегда соответствует содержимому.
export const settingsScroller = document.querySelector('.settings-content-scroll');
const settingsLinks = [...document.querySelectorAll('.settings-nav a')];
export let requestedSettingsSection = 'settings-appearance';
export const setSettingsCategory = (id) => {
  requestedSettingsSection = id;
  for (const link of settingsLinks) link.setAttribute('aria-current', String(link.hash === `#${id}`));
};
export const scrollToSettingsCategory = (id, smooth = true) => {
  const section = document.getElementById(id);
  if (!section) return;
  const scrollerTop = settingsScroller.getBoundingClientRect().top;
  const sectionTop = section.getBoundingClientRect().top;
  const top = Math.max(0, settingsScroller.scrollTop + sectionTop - scrollerTop - 4);
  settingsScroller.scrollTo({ top, behavior:smooth ? 'smooth' : 'auto' });
  setSettingsCategory(id);
};
let settingsScrollFrame = 0;
const syncSettingsCategory = () => {
  settingsScrollFrame = 0;
  const scrollerTop = settingsScroller.getBoundingClientRect().top;
  let active = settingsLinks[0]?.hash.slice(1) ?? requestedSettingsSection;
  if (settingsScroller.scrollTop + settingsScroller.clientHeight >= settingsScroller.scrollHeight - 4) {
    active = settingsLinks.at(-1)?.hash.slice(1) ?? active;
  } else {
    for (const link of settingsLinks) {
      const section = document.querySelector(link.hash);
      if (section && section.getBoundingClientRect().top - scrollerTop <= 72) active = section.id;
    }
  }
  if (active) setSettingsCategory(active);
};
for (const link of settingsLinks) link.onclick = (event) => {
  event.preventDefault();
  const id = link.hash.slice(1);
  history.replaceState(null, '', link.hash);
  scrollToSettingsCategory(id);
};
settingsScroller.addEventListener('scroll', () => {
  if (!settingsScrollFrame) settingsScrollFrame = requestAnimationFrame(syncSettingsCategory);
}, { passive:true });
setSettingsCategory('settings-appearance');
