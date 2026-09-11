import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BOT_TOKEN = '1:FakeForUpdateTests';
process.env.PANEL_TOKEN = 'update-tests-0123456789';
process.env.AI_MODE = 'off';
process.env.LOG_LEVEL = 'error';

const { config, version } = await import('../src/config.js');
const { UpdateManager } = await import('../src/core/update.js');

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`  ok    ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`, detail ?? ''); }
};
const asset = (name: string) => ({ name, browser_download_url: `https://example.invalid/${name}`, size: 123 });
const completeRelease = (tag: string, prerelease = false) => ({
  tag_name: tag, name: tag, html_url: `https://example.invalid/${tag}`,
  published_at: '2026-09-11T00:00:00Z', draft: false, prerelease,
  assets: [asset('ai-support.tar.gz'), asset('ai-support.tar.gz.sha256')],
});
const reply = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

const directory = await mkdtemp(join(tmpdir(), 'ai-support-update-'));
const originalFetch = globalThis.fetch;
const original = { ...config.update };
Object.assign(config.update, {
  enabled: true, repository: 'example/project', channel: 'stable', checkMinutes: 15,
  requestFile: join(directory, 'request.json'), statusFile: join(directory, 'status.json'),
});

try {
  console.log('\n[ центр обновлений ]');
  globalThis.fetch = async () => reply([
    completeRelease('v2.1.2'),
    completeRelease('v2.6.0-rc.1', true),
    completeRelease('v2.5.0'),
  ]);
  const manager = new UpdateManager();
  const state = await manager.state(true);
  check('выбран самый новый стабильный релиз независимо от порядка API', state.tag === 'v2.5.0', state.tag);
  check('релиз с обоими файлами доступен для установки', state.available && state.assets.length === 2, state);

  const queued = await manager.request('update');
  const request = JSON.parse(await readFile(config.update.requestFile, 'utf8')) as Record<string, unknown>;
  check('полная установка атомарно поставлена в очередь', queued.queued === true && request['schema'] === 2);
  check('в запросе закреплён проверенный тег', request['tag'] === 'v2.5.0' && request['current'] === version, request);
  await manager.request('update');
  const repeated = JSON.parse(await readFile(config.update.requestFile, 'utf8')) as Record<string, unknown>;
  check('повторный клик не перезаписывает активный запрос', repeated['requestedAt'] === request['requestedAt']);

  await unlink(config.update.requestFile);
  globalThis.fetch = async () => reply([{
    ...completeRelease('v2.5.0'), assets: [asset('ai-support.tar.gz')],
  }]);
  const incomplete = await new UpdateManager().state(true);
  check('неполный релиз нельзя установить', !incomplete.available && /обязательных файлов/u.test(incomplete.error ?? ''), incomplete);

  globalThis.fetch = async () => reply([completeRelease('v2.5.0')]);
  const resilient = new UpdateManager();
  await resilient.state(true);
  globalThis.fetch = async () => { throw new Error('temporary network failure'); };
  const afterFailure = await resilient.state(true);
  check('краткий сетевой сбой сохраняет последний проверенный релиз',
    afterFailure.tag === 'v2.5.0' && afterFailure.available && /temporary network/u.test(afterFailure.error ?? ''), afterFailure);

  globalThis.fetch = async () => reply([completeRelease('v2.5.0')]);
  await writeFile(config.update.statusFile, JSON.stringify({
    action: 'update', status: 'completed', backupPath: '/var/lib/ai-support-updater/backups/verified',
    percent: 100, updatedAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const rollbackManager = new UpdateManager();
  const rollbackState = await rollbackManager.state(true);
  check('откат доступен только при подтверждённом backup в статусе', rollbackState.compatibility.rollbackAvailable);
  await rollbackManager.request('rollback');
  const rollback = JSON.parse(await readFile(config.update.requestFile, 'utf8')) as Record<string, unknown>;
  check('откат формирует отдельный безопасный запрос',
    rollback['action'] === 'rollback' && rollback['tag'] === null
      && rollback['backupPath'] === '/var/lib/ai-support-updater/backups/verified', rollback);
} finally {
  globalThis.fetch = originalFetch;
  Object.assign(config.update, original);
  await rm(directory, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} проверок центра обновлений не прошли`);
  process.exit(1);
}
console.log('\nЦентр обновлений: все проверки прошли.');
