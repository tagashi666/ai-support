/**
 * e2e новой панели (план, 11.6): Playwright против собранной панели через
 * Fastify с настоящей CSP. Сервер — scripts/e2eserver.ts (синтетическая
 * база, поддельные каналы). Запуск: npm run test:e2e (сначала собирает web).
 * Тесты меняют общую базу (отправка, «Решено»), поэтому идут по одному.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8197);
const LOAD_PORT = PORT + 2;
// PANEL_UI=classic для всей установки (этап 8): только переключатель на /, база своя.
const CLASSIC_PORT = PORT + 4;

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: process.env.CI ? [['list']] : [['list']],
  outputDir: '../../test-results/e2e',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
  },
  projects: [
    { name: 'desktop', testIgnore: /load\.e2e\.ts$/, use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', testIgnore: /load\.e2e\.ts$/, use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 } },
    // Нагрузка (11.6): свой сервер на ~500 диалогах, чтобы не менять базу остальных тестов.
    { name: 'load', testMatch: /load\.e2e\.ts$/, use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, baseURL: `http://127.0.0.1:${LOAD_PORT}` } },
  ],
  webServer: [{
    command: 'node --import tsx scripts/e2eserver.ts',
    cwd: '../..',
    url: `http://127.0.0.1:${PORT}/next/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { E2E_PORT: String(PORT) },
  }, {
    command: 'node --import tsx scripts/e2eserver.ts',
    cwd: '../..',
    url: `http://127.0.0.1:${LOAD_PORT}/next/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { E2E_PORT: String(LOAD_PORT), E2E_EXTRA: '460' },
  }, {
    command: 'node --import tsx scripts/e2eserver.ts',
    cwd: '../..',
    url: `http://127.0.0.1:${CLASSIC_PORT}/next/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { E2E_PORT: String(CLASSIC_PORT), E2E_PANEL_UI: 'classic' },
  }],
});
