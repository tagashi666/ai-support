/**
 * Сборка новой панели. Выход — web/dist, сервер отдаёт его по /next
 * (src/panel/webapp.ts). Встроенного кода в index.html нет: полифил
 * предзагрузки модулей выключен, CSP `script-src 'self'` не меняется.
 * Проверка готовой сборки — scripts/webbudget.ts.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: at('.'),
  base: '/next/',
  publicDir: at('./public'),
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  resolve: {
    alias: { '@': at('./src'), '@shared': at('../src/shared') },
  },
  css: { modules: { localsConvention: 'camelCaseOnly' } },
  build: {
    outDir: at('./dist'),
    emptyOutDir: true,
    // Вопрос 14.9: две последние версии Chrome, Safari, Firefox; iOS 16+.
    target: ['chrome120', 'safari16', 'firefox120', 'ios16'],
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
    reportCompressedSize: false,
  },
  preview: { port: 4173, strictPort: true },
  test: {
    root: at('.'),
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
