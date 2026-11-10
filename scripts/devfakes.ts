/**
 * Поддельные обновление, подключения, серверы и уведомления для локальной
 * панели и e2e (scripts/devseed.ts). Ничего не уходит в сеть и не пишется в
 * data/: обновление «идёт» шагами по таймеру, источник «подключается» так же,
 * серверы — выдуманные. Формы ответов — как у настоящих классов
 * (src/core/update.ts, src/core/sources.ts, src/core/nodes.ts).
 */
import type { SourceProgress } from '../src/core/sources.js';
import type { UpdateProgress, UpdateState } from '../src/core/update.js';

const STEP_MS = Number(process.env.DEV_FAKE_STEP_MS ?? 700);

function nextMinor(current: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  return match ? `${match[1]}.${Number(match[2]) + 1}.0` : '9.9.0';
}

/** Шаги, по которым идёт поддельная операция: каждый — через STEP_MS. */
function stepper<S extends string>(steps: readonly S[], startedAt: number, now = Date.now()): S {
  const index = Math.min(steps.length - 1, Math.floor((now - startedAt) / STEP_MS));
  return steps[index]!;
}

export class FakeUpdates {
  private started: { at: number; action: 'update' | 'rollback'; version: string } | null = null;
  private installed: string;
  constructor(private current: string, private onDone: (action: string, version: string, status: string) => void = () => undefined) {
    this.installed = current;
  }

  private progress(): UpdateProgress | null {
    if (!this.started) return null;
    const steps = ['queued', 'backing_up', 'installing', 'checking', 'completed'] as const;
    const status = this.started.action === 'rollback'
      ? stepper(['queued', 'backing_up', 'installing', 'checking', 'rolled_back'] as const, this.started.at)
      : stepper(steps, this.started.at);
    if ((status === 'completed' || status === 'rolled_back') && this.installed !== this.started.version) {
      this.installed = this.started.version;
      this.onDone(this.started.action, this.started.version, status);
    }
    return { action: this.started.action, status, version: this.started.version, startedAt: new Date(this.started.at).toISOString(),
      updatedAt: new Date().toISOString(), ...(status === 'installing' ? { percent: 60 } : {}) };
  }

  cachedAvailability(): { available: boolean; latest: string | null } {
    const latest = nextMinor(this.current);
    return { available: this.installed !== latest, latest };
  }

  async state(): Promise<UpdateState> {
    const latest = nextMinor(this.current);
    const progress = this.progress();
    const active = progress !== null && !['completed', 'rolled_back', 'failed'].includes(progress.status);
    return {
      enabled: true, current: this.installed, available: this.installed !== latest, reinstallable: true, queued: active,
      tag: `v${latest}`, latest, name: `Версия ${latest}`, url: null, publishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      prerelease: false,
      changelog: '## Что нового\n\n- Отчёты и сроки ответа в новой панели\n- Система: серверы и обновление\n- Исправлена подпись в уведомлениях',
      assets: [], progress,
      compatibility: { externalUpdaterRequired: true, backupRequired: true, healthChecksRequired: true, rollbackAvailable: true },
    };
  }

  async request(action: 'update' | 'rollback' = 'update'): Promise<UpdateState> {
    const state = await this.state();
    if (state.queued) return state;
    if (action === 'update' && !state.available && !state.reinstallable) throw new Error('Новой версии пока нет');
    this.started = { at: Date.now(), action, version: action === 'rollback' ? this.current : nextMinor(this.current) };
    return this.state();
  }
}

export class FakeSources {
  private job: { at: number; kind: string; id: string; name: string; fail: boolean } | null = null;
  private seq = 0;
  constructor(private onDone: (job: { kind: string; id: string; name: string }) => void = () => undefined) {}
  private done = false;

  async state(): Promise<{ queued: boolean; progress: SourceProgress | null }> {
    if (!this.job) return { queued: false, progress: null };
    const steps = this.job.fail
      ? (['queued', 'backing_up', 'applying', 'checking', 'rolled_back'] as const)
      : (['queued', 'backing_up', 'applying', 'checking', 'completed'] as const);
    const status = stepper(steps, this.job.at);
    if (status === 'completed' && !this.done) { this.done = true; this.onDone(this.job); }
    const progress: SourceProgress = {
      status, kind: this.job.kind as SourceProgress['kind'], id: this.job.id, name: this.job.name,
      requestedAt: new Date(this.job.at).toISOString(), updatedAt: new Date().toISOString(),
      ...(status === 'rolled_back' ? { detail: 'Проверка не прошла: ключ не подошёл' } : {}),
    };
    return { queued: !['completed', 'rolled_back', 'failed'].includes(status), progress };
  }

  async request(input: Record<string, unknown>): Promise<{ queued: boolean; progress: SourceProgress | null }> {
    const state = await this.state();
    if (state.queued) throw new Error('Другой источник уже добавляется');
    const kind = String(input.kind ?? '');
    if (!['telegram_bot', 'remnawave', 'minishop'].includes(kind)) throw new Error('Неизвестный тип источника');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new Error('Название: заполните поле');
    const token = typeof input.token === 'string' ? input.token : '';
    if (!token) throw new Error('Ключ: заполните поле');
    this.seq += 1;
    this.done = false;
    this.job = { at: Date.now(), kind, id: kind === 'minishop' ? 'minishop-default' : `${kind === 'telegram_bot' ? 'telegram' : 'remnawave'}-dev${this.seq}`,
      name, fail: /bad|wrong|плох/i.test(token) };
    return this.state();
  }
}

/** Выдуманные серверы: один не отвечает, один выключен — для «Системы» и «Нужно внимание». */
export function fakeNodes(now: number) {
  const nodes = [
    { uuid: 'n1', rawName: 'de-fra-2', name: 'Франкфурт-2', country: 'DE', online: false, disabled: false, usersOnline: 0, trafficUsedBytes: 0, aliasKey: 'de-fra-2' },
    { uuid: 'n2', rawName: 'nl-ams-1', name: 'Амстердам-1', country: 'NL', online: true, disabled: false, usersOnline: 142, trafficUsedBytes: 812 * 1024 ** 3, aliasKey: 'nl-ams-1' },
    { uuid: 'n3', rawName: 'fi-hel-1', name: 'Хельсинки-1', country: 'FI', online: true, disabled: false, usersOnline: 57, trafficUsedBytes: 301 * 1024 ** 3, aliasKey: 'fi-hel-1' },
    { uuid: 'n4', rawName: 'se-sto-1', name: 'Стокгольм-1', country: 'SE', online: true, disabled: false, usersOnline: 33, trafficUsedBytes: 120 * 1024 ** 3, aliasKey: 'se-sto-1' },
    { uuid: 'n5', rawName: 'pl-waw-old', name: 'Варшава (старый)', country: 'PL', online: false, disabled: true, usersOnline: 0, trafficUsedBytes: 0, aliasKey: 'pl-waw-old' },
  ];
  let at = now - 60_000;
  return {
    get: () => ({ at, nodes }),
    async refresh() { at = Date.now(); return { at, nodes }; },
  };
}

/** Уведомления «настроены», тест никуда не отправляет. */
export function fakeNotifier() {
  let sent = 0;
  return {
    state: () => ({ configured: true, sent, lastError: null }),
    async test() { sent += 1; return { ok: true as const }; },
    async notify() { /* синтетика: никуда не шлём */ },
    sentCount: () => sent,
  };
}
