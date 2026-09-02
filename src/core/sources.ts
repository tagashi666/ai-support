import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config, version } from '../config.js';

export type AddableSourceKind = 'telegram_bot' | 'remnawave';
export type SourceApplyStatus = 'queued' | 'backing_up' | 'applying' | 'checking' | 'completed' | 'rolled_back' | 'failed';

export interface SourceProgress {
  status: SourceApplyStatus;
  kind?: AddableSourceKind;
  id?: string;
  name?: string;
  stage?: string;
  detail?: string;
  backupPath?: string;
  requestedAt?: string;
  updatedAt?: string;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const BOT_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{20,}$/;
const ACTIVE = new Set<SourceApplyStatus>(['queued', 'backing_up', 'applying', 'checking']);

function clean(value: unknown, label: string, max = 120): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) throw new Error(`${label}: заполните поле`);
  if (result.length > max || /[\r\n\0#]/.test(result)) throw new Error(`${label}: недопустимое значение`);
  return result;
}

export class SourceManager {
  private async requestQueued(): Promise<boolean> {
    try { await readFile(config.sourceManagement.requestFile, 'utf8'); return true; } catch { return false; }
  }

  private async progress(): Promise<SourceProgress | null> {
    try {
      const raw = await readFile(config.sourceManagement.statusFile, 'utf8');
      if (raw.length > 64 * 1024) return null;
      const value = JSON.parse(raw) as Partial<SourceProgress>;
      if (!['queued', 'backing_up', 'applying', 'checking', 'completed', 'rolled_back', 'failed'].includes(String(value.status))) return null;
      return {
        status: value.status as SourceApplyStatus,
        ...(value.kind === 'telegram_bot' || value.kind === 'remnawave' ? { kind: value.kind } : {}),
        ...(typeof value.id === 'string' ? { id: value.id.slice(0, 80) } : {}),
        ...(typeof value.name === 'string' ? { name: value.name.slice(0, 120) } : {}),
        ...(typeof value.stage === 'string' ? { stage: value.stage.slice(0, 200) } : {}),
        ...(typeof value.detail === 'string' ? { detail: value.detail.slice(0, 1000) } : {}),
        ...(typeof value.backupPath === 'string' ? { backupPath: value.backupPath.slice(0, 1000) } : {}),
        ...(typeof value.requestedAt === 'string' ? { requestedAt: value.requestedAt } : {}),
        ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
      };
    } catch { return null; }
  }

  async state(): Promise<{ queued: boolean; progress: SourceProgress | null }> {
    const progress = await this.progress();
    return { queued: await this.requestQueued() || Boolean(progress && ACTIVE.has(progress.status)), progress };
  }

  async request(input: Record<string, unknown>, existingIds: string[]): Promise<{
    queued: boolean;
    progress: SourceProgress | null;
  }> {
    const state = await this.state();
    if (state.queued) throw new Error('Другой источник уже добавляется');
    const kind = input.kind;
    if (kind !== 'telegram_bot' && kind !== 'remnawave') throw new Error('Неизвестный тип источника');
    const name = clean(input.name, 'Название');
    const fallbackId = `${kind === 'telegram_bot' ? 'telegram' : 'remnawave'}-${randomBytes(6).toString('hex')}`;
    const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : fallbackId;
    if (!ID_RE.test(id)) throw new Error('Технический ID: только буквы, цифры и . _ : -');
    if (existingIds.includes(id)) throw new Error('Источник с таким ID уже существует');

    let source: Record<string, unknown>;
    if (kind === 'telegram_bot') {
      const token = clean(input.token, 'Токен бота', 256);
      if (!BOT_TOKEN_RE.test(token)) throw new Error('Токен Telegram выглядит некорректно');
      source = { kind, id, name, token };
    } else {
      const url = clean(input.url, 'URL панели', 1000);
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error('Укажите полный URL панели'); }
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname))) {
        throw new Error('Для внешней Remnawave-панели нужен HTTPS');
      }
      const token = clean(input.token, 'Токен API', 2000);
      source = { kind, id, name, url: parsed.toString().replace(/\/$/, ''), token, readOnly: input.readOnly !== false };
    }

    const targetDir = dirname(config.sourceManagement.requestFile);
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    const temporary = `${config.sourceManagement.requestFile}.${process.pid}.tmp`;
    const requestedAt = new Date().toISOString();
    const payload = `${JSON.stringify({
      schema: 1, action: 'add_source', current: version, requestedAt, source,
      safety: { backupRequired: true, healthCheckRequired: true, rollbackOnFailure: true },
    }, null, 2)}\n`;
    try {
      await writeFile(temporary, payload, { mode: 0o600, flag: 'wx' });
      await chmod(temporary, 0o600);
      await rename(temporary, config.sourceManagement.requestFile);
    } catch (err) {
      await unlink(temporary).catch(() => undefined);
      throw err;
    }
    // Не возвращаем payload: в нём находится токен.
    return { queued: true, progress: { status: 'queued', kind, id, name, requestedAt } };
  }
}
