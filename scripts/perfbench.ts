/**
 * Замеры новой панели под нагрузкой (R2, раздел D): 500 диалогов и диалог на
 * 1000 сообщений (devseed: extra + longThread), браузеры Chromium/WebKit/Firefox,
 * ширины 1440 и 390. Данные синтетические, сервер — на 127.0.0.1.
 *
 *   npm run build:web && node --import tsx scripts/perfbench.ts [chromium,webkit,firefox] [1440,390]
 *   (VITE_PERF=1 npx vite build --config web/vite.config.ts — ещё и счётчик отрисовок строк)
 *
 * Браузеры — из PLAYWRIGHT_BROWSERS_PATH (npx playwright install webkit firefox).
 * Кадры считает requestAnimationFrame; длинные задачи — PerformanceObserver
 * (только Chromium), в остальных — самый длинный кадр. Печатает JSON по прогонам.
 */
import { chromium, firefox, webkit, type Browser, type Page } from 'playwright-core';
import { startDevPanel } from './devseed.js';

const TOKEN = 'perf-bench-0123456789abcdef';
const PORT = Number(process.env.PERF_PORT ?? 8361);
const engines = { chromium, webkit, firefox } as const;
const pick = (process.argv[2] ?? 'chromium,webkit,firefox').split(',') as (keyof typeof engines)[];
const widths = (process.argv[3] ?? '1440,390').split(',').map(Number);

interface Frames { frames: number; fps: number; p95: number; max: number; over50: number; long: number; longMax: number }

/** В странице: счётчик кадров и длинных задач на время fn (шаг на каждый кадр, пока step() не вернёт false). */
const PAGE_HELPERS = `
// tsx (esbuild keepNames) оборачивает функции в __name — в странице его нет.
window.__name = (fn) => fn;
window.__perf = {
  long: [],
  init() {
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__perf.long.push(e.duration); })
        .observe({ type: 'longtask', buffered: false });
    } catch {}
  },
  run(step, ms) {
    return new Promise((resolve) => {
      window.__perf.long = [];
      const deltas = []; let last = performance.now(); const start = last; let i = 0;
      const tick = (now) => {
        deltas.push(now - last); last = now;
        const go = step ? step(i++) !== false : true;
        if (go && now - start < ms) requestAnimationFrame(tick);
        else {
          const sorted = [...deltas].sort((a, b) => a - b);
          const long = window.__perf.long;
          resolve({ frames: deltas.length, fps: Math.round(1000 * deltas.length / (now - start)), p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] || 0),
            max: Math.round(sorted[sorted.length - 1] || 0), over50: deltas.filter((d) => d > 50).length,
            long: long.length, longMax: Math.round(Math.max(0, ...long)) });
        }
      };
      requestAnimationFrame((t) => { last = t; requestAnimationFrame(tick); });
    });
  },
};
window.__perf.init();
`;

async function frames(page: Page, step: string | null, ms: number): Promise<Frames> {
  return await page.evaluate(([body, time]) => {
    const fn = body ? new Function('i', body) as (i: number) => boolean : null;
    return (window as unknown as { __perf: { run: (s: unknown, m: number) => Promise<Frames> } }).__perf.run(fn, time);
  }, [step, ms] as const);
}

const panel = await startDevPanel({ port: PORT, token: TOKEN, extra: 460, longThread: 1000 });
const base = `http://127.0.0.1:${PORT}`;
type Inbox = { items: { id: number; customer?: { name?: string } }[] };
const get = async (q: string): Promise<Inbox> => await (await fetch(`${base}/api/inbox?view=open&limit=50${q}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as Inbox;
const inbox = await get('');
const longId = (await get(`&q=${encodeURIComponent('Длинный диалог')}`)).items.find((item) => item.customer?.name === 'Длинный диалог')?.id;
if (!longId) throw new Error('нет длинного диалога');
const results: Record<string, unknown>[] = [];

async function run(browser: Browser, name: string, width: number): Promise<void> {
  const mobile = width < 768;
  const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow',
    ...(mobile && name !== 'firefox' ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await context.addInitScript(({ token }) => {
    localStorage.setItem('panelToken', token);
    localStorage.setItem('next.mode', 'live');
    localStorage.setItem('next.chatsView', 'open');
    localStorage.setItem('next.onboarding', JSON.stringify({ welcomeDone: true, checklistHidden: true, hintsDone: true, tutorialClosed: true }));
  }, { token: TOKEN });
  await context.addInitScript({ content: PAGE_HELPERS });
  const page = await context.newPage();
  // PERF_CPU=4 — замедлить процессор в Chromium (CDP), как на слабом ноутбуке.
  if (name === 'chromium' && process.env.PERF_CPU) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.PERF_CPU) });
  }
  const out: Record<string, unknown> = { browser: name, width, cpu: name === 'chromium' ? Number(process.env.PERF_CPU ?? 1) : 1 };

  await page.goto(`${base}/next/chats`);
  await page.waitForSelector('[data-scroller="chats"] [data-row-id]');
  await page.waitForTimeout(800);
  out.rows = await page.locator('[data-scroller="chats"] [data-row-id]').count();
  out.listScroll = await frames(page, `const el = document.querySelector('[data-scroller="chats"]'); const top = el.scrollTop; el.scrollTop = top + 60; return el.scrollTop !== top || i < 3;`, 4000);

  // Открытие обычного и длинного диалога: щелчок → лента с пузырями и два кадра.
  const open = async (id: number): Promise<number> => await page.evaluate(async (target) => {
    const scroller = document.querySelector('[data-scroller="chats"]')!;
    const row = scroller.querySelector<HTMLElement>(`[data-row-id="${target}"] button`);
    const t0 = performance.now();
    if (row) row.click();
    else { history.pushState(null, '', `/next/chats/${target}`); dispatchEvent(new PopStateEvent('popstate')); }
    const ready = (): boolean => location.pathname.endsWith(`/${target}`) && document.querySelectorAll('[role="log"] [data-voice]').length > 0
      && document.querySelector('[role="log"]')?.getAttribute('aria-busy') !== 'true';
    while (!ready()) await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return Math.round(performance.now() - t0);
  }, id);
  const short = inbox.items.find((item) => item.id !== longId)!.id;
  await page.evaluate(() => { (window as unknown as { __perf: { long: number[] } }).__perf.long = []; });
  out.openShort = await open(short);
  if (mobile) { await page.goBack(); await page.waitForSelector('[data-scroller="chats"] [data-row-id]'); }
  await page.evaluate(() => { (window as unknown as { __perf: { long: number[] } }).__perf.long = []; });
  out.openLong = await open(longId);
  out.openLong_longtasks = await page.evaluate(() => (window as unknown as { __perf: { long: number[] } }).__perf.long.map(Math.round));
  await page.waitForTimeout(600);
  out.bubbles = await page.locator('[role="log"] [data-voice]').count();
  out.feedScroll = await frames(page, `const el = document.querySelector('[role="log"]'); const top = el.scrollTop; el.scrollTop = top - 60; return el.scrollTop !== top || i < 3;`, 4000);

  // 20 живых кадров подряд (по 50 мс) в другие диалоги: кадры и сколько строк списка тронуто.
  if (mobile) { await page.goBack(); await page.waitForSelector('[data-scroller="chats"] [data-row-id]'); }
  await page.evaluate(() => { document.querySelector('[data-scroller="chats"]')!.scrollTop = 0; });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const w = window as unknown as { __touched: Set<string> };
    w.__touched = new Set();
    new MutationObserver((list) => {
      for (const m of list) {
        const row = (m.target instanceof Element ? m.target : m.target.parentElement)?.closest('[data-row-id]');
        if (row) w.__touched.add(row.getAttribute('data-row-id')!);
      }
    }).observe(document.querySelector('[data-scroller="chats"]')!, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await page.evaluate(() => { (window as unknown as { __renders: Record<string, number> }).__renders = {}; });
  const burst = frames(page, null, 2500);
  // В верхние строки «Ждут вас» (самые давние нагрузочные: 459, 456, …) — их видно на экране.
  for (let i = 0; i < 20; i += 1) { panel.inboundExtra(459 - 3 * i, `Живой кадр ${i + 1}`); await new Promise((r) => setTimeout(r, 50)); }
  out.live20 = await burst;
  out.live20_rowsTouched = await page.evaluate(() => (window as unknown as { __touched: Set<string> }).__touched.size);
  // Отрисовки строк за 20 кадров — только в сборке VITE_PERF=1 (web/src/lib/perf.ts), иначе null.
  out.live20_rowRenders = await page.evaluate(() => (window as unknown as { __renders?: Record<string, number> }).__renders?.row ?? null);

  // Лист «Клиент» (на 1440 — боковой лист, на 390 — снизу) и тост «Решено → Вернуть».
  await page.evaluate((id) => { history.pushState(null, '', `/next/chats/${id}`); dispatchEvent(new PopStateEvent('popstate')); }, longId);
  await page.waitForSelector('[role="log"] [data-voice]');
  await page.waitForTimeout(400);
  const sheet = frames(page, null, 700);
  await page.evaluate((id) => { history.pushState(null, '', `/next/chats/${id}/client`); dispatchEvent(new PopStateEvent('popstate')); }, longId);
  out.sheetOpen = await sheet;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const resolve = page.getByRole('button', { name: 'Решено', exact: true }).first();
  if (await resolve.isVisible().catch(() => false)) {
    const toast = frames(page, null, 700);
    await resolve.click();
    out.toastIn = await toast;
    const undo = page.getByRole('button', { name: /Вернуть|Отменить/ }).first();
    if (await undo.isVisible().catch(() => false)) await undo.click();
  }
  results.push(out);
  console.log(JSON.stringify(out));
  await context.close();
}

try {
  for (const name of pick) {
    const browser = await engines[name].launch();
    try { for (const width of widths) await run(browser, name, width); } catch (err) { console.log(JSON.stringify({ browser: name, error: String(err).slice(0, 300) })); }
    await browser.close();
  }
} finally {
  await panel.stop();
}
process.exit(0);
