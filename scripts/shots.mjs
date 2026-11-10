// Скриншоты панели для приёмки: node scripts/shots.mjs <baseURL> <token> <outDir> [w=2560] [h=1310] [scale=0.5]
import { chromium } from '@playwright/test';
const [base, token, out, w = '2560', h = '1310', scale = '0.5'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: +scale, colorScheme: 'dark' });
await page.addInitScript((t) => { localStorage.setItem('panelToken', t); }, token);
const shot = async (name, path, prep) => {
  await page.goto(`${base}${path}`); await page.waitForTimeout(1200);
  if (prep) await prep(); await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${w}-${name}.png` });
};
await shot('dialog', '/next/chats/500');
await shot('dialog-photo', '/next/chats/1');
await shot('chats', '/next/chats');
await shot('today', '/next/today');
await shot('knowledge', '/next/knowledge');
await shot('system', '/next/system');
if (+w >= 1024) {
  await shot('assistant', '/next/assistant');
  await shot('reports', '/next/reports');
  await shot('connections', '/next/connections');
  await shot('team', '/next/team');
}
await browser.close();
