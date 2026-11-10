/**
 * Проверка собранной новой панели (web/dist), план 11.6:
 * - в index.html нет встроенного кода: <script> только с src, нет on*= и style=;
 * - в сборке нет внешних адресов (кроме пространств имён XML);
 * - бюджет размера: начальный JS ≤ 120 КБ gzip (точка входа и modulepreload из
 *   index.html; разделы, которые грузятся по требованию, — отдельно, весь JS ≤ 200 КБ),
 *   CSS ≤ 40 КБ gzip.
 * Запускается после vite build (npm run build:web).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = new URL('../web/dist/', import.meta.url).pathname;
const JS_BUDGET = 120 * 1024;
const JS_TOTAL_BUDGET = 200 * 1024;
const CSS_BUDGET = 40 * 1024;
const ALLOWED_URLS = [/^http:\/\/www\.w3\.org\/(2000\/svg|1999\/xlink|1999\/xhtml|1998\/Math\/MathML|XML\/1998\/namespace)/];

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`  ok    ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`, detail ?? ''); }
};

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)];
check('в index.html есть точка входа модулем', scripts.some(([, attrs]) => /type="module"/u.test(attrs ?? '') && /\bsrc="\/next\/assets\//u.test(attrs ?? '')));
check('нет встроенных скриптов', scripts.every(([, attrs, body]) => /\bsrc=/u.test(attrs ?? '') && !(body ?? '').trim()));
check('нет обработчиков on*= в разметке', !/<[^>]+\son[a-z]+\s*=/iu.test(html));
check('нет атрибутов style= в разметке', !/<[^>]+\sstyle\s*=/iu.test(html));
check('нет встроенных стилей <style>', !/<style\b/iu.test(html));

const files = walk(dist);
const text = files.filter((file) => ['.js', '.css', '.html', '.svg'].includes(extname(file)));
const external = text.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/https?:\/\/[^\s"'`)<>]+/gu)]
  .map((match) => match[0])
  .filter((url) => !ALLOWED_URLS.some((allowed) => allowed.test(url)))
  .map((url) => `${file.slice(dist.length)}: ${url}`));
check('в сборке нет внешних адресов', external.length === 0, external.slice(0, 5));
check('нет карт исходников с путями машины', !text.some((file) => /\/Users\/|\/home\//u.test(readFileSync(file, 'utf8'))));

const gz = (ext: string): number => files.filter((file) => extname(file) === ext)
  .reduce((sum, file) => sum + gzipSync(readFileSync(file)).length, 0);
// Начальный JS — то, что браузер грузит до первого экрана: модуль точки входа и modulepreload.
const initialRefs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="\/next\/(assets\/[^"]+\.js)"/giu)].map((match) => match[1]!);
const js = [...new Set(initialRefs)].reduce((sum, ref) => sum + gzipSync(readFileSync(join(dist, ref))).length, 0);
const jsTotal = gz('.js');
const css = gz('.css');
check('начальный JS найден в index.html', initialRefs.length > 0);
check(`начальный JS ${(js / 1024).toFixed(1)} КБ gzip ≤ ${JS_BUDGET / 1024} КБ`, js > 0 && js <= JS_BUDGET);
check(`весь JS ${(jsTotal / 1024).toFixed(1)} КБ gzip ≤ ${JS_TOTAL_BUDGET / 1024} КБ`, jsTotal <= JS_TOTAL_BUDGET);
check(`CSS ${(css / 1024).toFixed(1)} КБ gzip ≤ ${CSS_BUDGET / 1024} КБ`, css <= CSS_BUDGET);

console.log(failures === 0 ? '\nСборка новой панели в порядке' : `\nПровалено: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
