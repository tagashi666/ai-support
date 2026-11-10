// Замер плавности панели в Chromium с замедленным CPU (R3).
// node scripts/perfprobe.mjs <baseURL> <token> [cpuRate=4]
// Печатает по сценарию: кадры > 34 мс (≈ пропуск 2+ кадров), худший кадр, длинные задачи.
import { chromium } from '@playwright/test';
const [base, token, rate = '4'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2000, height: 1024 }, colorScheme: 'dark' });
await page.addInitScript((t) => localStorage.setItem('panelToken', t), token);
await page.goto(`${base}/next/chats`);
await page.locator('[data-row-id]').first().waitFor();
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(rate) });
await page.evaluate(() => {
  const w = window; w.__f = []; w.__lt = []; let last = performance.now();
  const loop = (now) => { w.__f.push(now - last); last = now; requestAnimationFrame(loop); }; requestAnimationFrame(loop);
  new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__lt.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
});
const measure = async (name, fn) => {
  await page.evaluate(() => { window.__f = []; window.__lt = []; });
  await fn();
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => ({ f: window.__f, lt: window.__lt }));
  const slow = r.f.filter((d) => d > 34).length;
  console.log(`${name.padEnd(28)} кадров ${String(r.f.length).padStart(4)}  >34мс ${String(slow).padStart(3)}  худший ${Math.round(Math.max(...r.f))}мс  longtask ${JSON.stringify(r.lt.slice(0, 6))}`);
};
const rows = page.locator('[data-row-id]');
await measure('наведение по 15 строкам', async () => {
  for (let i = 0; i < 15; i++) { const b = await rows.nth(i).boundingBox(); if (b) await page.mouse.move(b.x + 120, b.y + b.height / 2, { steps: 4 }); }
});
for (let i = 0; i < 4; i++) {
  await measure(`открыть диалог ${i + 1}`, async () => { await rows.nth(i * 3).click({ position: { x: 120, y: 20 } }); await page.waitForTimeout(700); });
}
await measure('прокрутка списка', async () => {
  const b = await rows.first().boundingBox(); await page.mouse.move(b.x + 100, b.y + 200);
  for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(30); }
});
await measure('прокрутка ленты', async () => {
  const log = await page.getByRole('log').boundingBox(); await page.mouse.move(log.x + 200, log.y + 200);
  for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(30); }
});
const sums = page.locator('aside summary, [aria-label="Клиент"] summary');
const n = Math.min(await sums.count(), 3);
await measure(`раскрыть ${n} блока «Клиент»`, async () => { for (let i = 0; i < n; i++) { await sums.nth(i).click(); await page.waitForTimeout(350); } });
await measure('переключить вкладки списка', async () => {
  for (const name of ['Решённые', 'Открытые', 'Ждут вас']) { await page.getByRole('tab', { name: new RegExp(name) }).first().click().catch(() => {}); await page.waitForTimeout(400); }
});
await browser.close();
