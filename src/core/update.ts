import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config, log, version } from '../config.js';

interface GithubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  body?: string;
  assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>;
}

export interface UpdateProgress {
  action: 'update' | 'rollback';
  status: 'queued' | 'backing_up' | 'installing' | 'checking' | 'completed' | 'rolled_back' | 'failed';
  stage?: string;
  percent?: number;
  version?: string;
  backupPath?: string;
  detail?: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface UpdateState {
  enabled: boolean;
  current: string;
  available: boolean;
  reinstallable: boolean;
  queued: boolean;
  tag: string | null;
  latest: string | null;
  name: string | null;
  url: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  changelog: string | null;
  assets: Array<{ name: string; url: string; size: number | null }>;
  progress: UpdateProgress | null;
  compatibility: {
    externalUpdaterRequired: true;
    backupRequired: true;
    healthChecksRequired: true;
    rollbackAvailable: boolean;
  };
  error?: string;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function parse(value: string): [number, number, number, string | null] | null {
  const match = VERSION_RE.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? null];
}

/** Достаточное сравнение semver для наших тегов v2.0.0-rc.N. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  if (a[3] === b[3]) return false;
  if (a[3] === null) return true;
  if (b[3] === null) return false;
  const left = a[3].split('.');
  const right = b[3].split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i];
    const y = right[i];
    if (x === y) continue;
    if (x === undefined) return false;
    if (y === undefined) return true;
    const xn = /^\d+$/.test(x) ? Number(x) : null;
    const yn = /^\d+$/.test(y) ? Number(y) : null;
    if (xn !== null && yn !== null) return xn > yn;
    if (xn !== null) return false;
    if (yn !== null) return true;
    return x.localeCompare(y) > 0;
  }
  return false;
}

export function isSameVersion(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  return Boolean(a && b && a.every((part, index) => part === b[index]));
}

export class UpdateManager {
  private cached?: { at: number; release: GithubRelease | null; error?: string };

  private async requestQueued(): Promise<boolean> {
    try {
      await readFile(config.update.requestFile, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  private async progress(): Promise<UpdateProgress | null> {
    try {
      const raw = await readFile(config.update.statusFile, 'utf8');
      if (raw.length > 64 * 1024) return null;
      const value = JSON.parse(raw) as Partial<UpdateProgress>;
      const actions = ['update', 'rollback'];
      const statuses = ['queued', 'backing_up', 'installing', 'checking', 'completed', 'rolled_back', 'failed'];
      if (!actions.includes(String(value.action)) || !statuses.includes(String(value.status))) return null;
      return {
        action: value.action as UpdateProgress['action'],
        status: value.status as UpdateProgress['status'],
        ...(typeof value.stage === 'string' ? { stage: value.stage.slice(0, 200) } : {}),
        ...(Number.isFinite(value.percent) ? { percent: Math.min(100, Math.max(0, Number(value.percent))) } : {}),
        ...(typeof value.version === 'string' ? { version: value.version.slice(0, 80) } : {}),
        ...(typeof value.backupPath === 'string' ? { backupPath: value.backupPath.slice(0, 1000) } : {}),
        ...(typeof value.detail === 'string' ? { detail: value.detail.slice(0, 2000) } : {}),
        ...(typeof value.startedAt === 'string' ? { startedAt: value.startedAt } : {}),
        ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
      };
    } catch {
      return null;
    }
  }

  async state(force = false): Promise<UpdateState> {
    if (!config.update.enabled) {
      const progress = await this.progress();
      return {
        enabled: false, current: version, available: false, reinstallable: false, queued: false,
        tag: null, latest: null, name: null, url: null, publishedAt: null, prerelease: false,
        changelog: null, assets: [], progress,
        compatibility: { externalUpdaterRequired: true, backupRequired: true, healthChecksRequired: true, rollbackAvailable: Boolean(progress?.backupPath) },
      };
    }

    const maxAge = config.update.checkMinutes * 60_000;
    if (force || !this.cached || Date.now() - this.cached.at > maxAge) {
      try {
        const response = await fetch(`https://api.github.com/repos/${config.update.repository}/releases?per_page=20`, {
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': `ai-support/${version}`,
            'x-github-api-version': '2022-11-28',
          },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) throw new Error(`GitHub вернул HTTP ${response.status}`);
        const releases = await response.json() as GithubRelease[];
        const release = releases.find((item) => !item.draft && item.tag_name && TAG_RE.test(item.tag_name)
          && (config.update.channel === 'prerelease' || !item.prerelease)) ?? null;
        this.cached = { at: Date.now(), release };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.cached = { at: Date.now(), release: null, error: message };
        log.warn(`Проверка обновлений не удалась: ${message}`);
      }
    }

    const release = this.cached.release;
    const tag = release?.tag_name ?? null;
    const progress = await this.progress();
    const activeProgress = progress && ['queued', 'backing_up', 'installing', 'checking'].includes(progress.status);
    return {
      enabled: true,
      current: version,
      available: Boolean(tag && isNewer(tag, version)),
      // Переустанавливать можно только тот же самый тег. Иначе локальная
      // сборка, которая новее GitHub Release, могла «переустановиться» назад.
      reinstallable: Boolean(tag && isSameVersion(tag, version)),
      // Host-updater первым делом забирает request-файл в root-only каталог.
      // Поэтому одного наличия файла недостаточно: пока status активен, кнопку
      // нельзя показывать повторно и создавать второй запрос.
      queued: await this.requestQueued() || Boolean(activeProgress),
      tag,
      latest: tag?.replace(/^v/, '') ?? null,
      name: release?.name ?? null,
      url: release?.html_url ?? null,
      publishedAt: release?.published_at ?? null,
      prerelease: release?.prerelease === true,
      changelog: release?.body?.slice(0, 20_000) ?? null,
      assets: (release?.assets ?? []).flatMap((asset) => asset.name && asset.browser_download_url
        ? [{ name: asset.name, url: asset.browser_download_url, size: Number.isFinite(asset.size) ? Number(asset.size) : null }]
        : []),
      progress,
      compatibility: {
        externalUpdaterRequired: true,
        backupRequired: true,
        healthChecksRequired: true,
        rollbackAvailable: Boolean(progress?.backupPath),
      },
      ...(this.cached.error ? { error: this.cached.error } : {}),
    };
  }

  async request(action: 'update' | 'rollback' = 'update', options: { force?: boolean } = {}): Promise<UpdateState> {
    const state = await this.state(true);
    if (!state.enabled) throw new Error('Обновления отключены на сервере');
    if (state.queued) return state;
    // force разрешает администратору переустановить текущий релиз. Это важно
    // после восстановления backup или неудачного ручного обновления: кнопка
    // остаётся полноценным установщиком, а не исчезает сразу после проверки.
    if (action === 'update' && (!state.tag || !TAG_RE.test(state.tag)
      || (options.force ? !state.reinstallable : !state.available))) {
      throw new Error(options.force ? 'Текущий релиз нельзя безопасно переустановить' : 'Новой версии пока нет');
    }
    if (action === 'rollback' && !state.compatibility.rollbackAvailable) throw new Error('Нет проверенной резервной копии для отката');

    const targetDir = dirname(config.update.requestFile);
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    const temporary = `${config.update.requestFile}.${process.pid}.tmp`;
    const requestedAt = new Date().toISOString();
    const payload = `${JSON.stringify({
      schema: 2,
      action,
      tag: action === 'update' ? state.tag : null,
      current: version,
      force: action === 'update' && options.force === true,
      backupPath: action === 'rollback' ? state.progress?.backupPath : null,
      requestedAt,
      safety: {
        backupRequired: true,
        healthChecks: ['nginx', 'application', 'database', 'channels'],
        rollbackOnFailure: true,
      },
    }, null, 2)}\n`;
    try {
      await writeFile(temporary, payload, { mode: 0o600, flag: 'wx' });
      await chmod(temporary, 0o600);
      await rename(temporary, config.update.requestFile);
    } catch (err) {
      await unlink(temporary).catch(() => undefined);
      throw err;
    }
    return {
      ...state,
      queued: true,
      progress: {
        action,
        status: 'queued',
        stage: 'Запрос принят и передан host-updater',
        percent: 0,
        ...(action === 'update' && state.latest ? { version: state.latest } : {}),
        ...(state.progress?.backupPath ? { backupPath: state.progress.backupPath } : {}),
        startedAt: requestedAt,
        updatedAt: requestedAt,
      },
    };
  }
}
