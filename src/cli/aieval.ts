/**
 * Прогон качества ответов ИИ на синтетических обращениях.
 *
 *   node dist/cli/aieval.js [--model X] [--out file.md] [--only id1,id2] [--limit N]
 *
 * Ходит в настроенный провайдер (AI_API_KEY из окружения или .env) — это
 * стоит токенов, поэтому в npm test не входит. База знаний — встроенная
 * тестовая (src/ai/eval.ts), во временной SQLite: рабочую базу не трогает.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { openDatabase } from '../core/db.js';
import { Store } from '../core/store.js';
import { runtime } from '../core/settings.js';
import { AiProvider } from '../ai/provider.js';
import { EVAL_KB, renderReport, runEval, summarize } from '../ai/eval.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  if (!config.ai.apiKeys.length) {
    console.error('AI_API_KEY не задан — прогон невозможен');
    process.exit(1);
  }
  const model = arg('model');
  const out = arg('out');
  const only = arg('only')?.split(',').map((id) => id.trim()).filter(Boolean);
  const limit = Number(arg('limit')) || undefined;

  const dir = mkdtempSync(join(tmpdir(), 'ai-eval-'));
  try {
    const store = new Store(openDatabase(join(dir, 'eval.db')));
    store.syncKb('eval', EVAL_KB);
    // Вердикт считается как в боевом auto: рубильник инсталляции на прогон не влияет.
    runtime.aiMode = 'auto';
    const provider = new AiProvider(config.ai.baseUrl, config.ai.apiKeys, model);
    const name = model ?? runtime.model;
    console.log(`AI eval: модель ${name}, база — встроенная тестовая (${EVAL_KB.length} статей)\n`);
    const rows = await runEval(provider, (query) => store.searchKb(query, config.ai.kbLimit), {
      only,
      limit,
      onRow: (row) => console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.id.padEnd(14)} ${row.result.padEnd(8)} ${row.problems.join('; ')}`),
    });
    const report = renderReport(rows, name);
    const summary = summarize(rows);
    console.log(`\nразобрано ${Math.round(summary.parseRate * 100)}% · человеку ${Math.round(summary.handoffRate * 100)}% · прошло ${Math.round(summary.passRate * 100)}%`);
    if (out) {
      writeFileSync(out, report);
      console.log(`Отчёт: ${out}`);
    } else {
      console.log(`\n${report}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
