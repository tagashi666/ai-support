/**
 * «Знания» на живых данных (6.6, 10.5): статьи и черновики, версия и 409 при
 * чужой правке, публикация с «Отменить», идеи из диалогов с решением после
 * окна отмены, шаблоны, сбор статей из старых диалогов. Права — из bootstrap.
 */
import { computed, signal } from '@preact/signals';
import { t } from '@/i18n/ru';
import { can } from '@/lib/assistant/store';
import { showToast } from '@/lib/actions/toasts';
import { readToken } from '@/lib/live/api';
import { bootstrap } from '@/lib/live/store';
import { deferWithUndo, type DeferredTask } from '@/lib/workspace/deferred';
import type {
  IdeaDecided, IdeaRejectReason, IdeaRow, IdeasResponse, KbArea, KbConflict, KbDocResponse, KbListResponse, KbWriteResponse,
} from '@shared/api-types';
import { articleRows, composeDoc, nextIdeaId, type DocFields } from './model';

export interface Template {
  id: number;
  shortcut: string;
  title: string;
  body: string;
  uses: number;
}

export interface MineJob {
  id: number;
  /** running · done · failed */
  status: string;
  progress?: string | null;
  error?: string | null;
  started_at?: number;
  ended_at?: number | null;
}

/** Что умеет этот человек (6.6, таблица прав): кнопки без права не рисуются. */
export const rights = computed(() => ({
  read: can('knowledge:read'),
  manage: can('knowledge:manage'),
  review: can('knowledge:review'),
  /** «Опубликовать…» — только при обоих: без review черновик не открыть (10.5). */
  publish: can('knowledge:manage') && can('knowledge:review'),
  mine: can('knowledge:mine'),
  templates: can('templates:read'),
  templatesManage: can('templates:manage'),
  tryIt: can('settings:ai_tools'),
}));

export const kb = signal<KbListResponse | null>(null);
export const kbState = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
export const ideas = signal<IdeaRow[] | null>(null);
export const ideasState = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
/** Идеи, решение по которым ждёт окна отмены: из очереди уже убраны. */
export const ideasHeld = signal<ReadonlySet<number>>(new Set());
export const templates = signal<Template[] | null>(null);
export const templatesState = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
/** «В знания…» из диалога: текст для новой статьи (6.6). */
export const prefill = signal<DocFields | null>(null);

export const pendingIdeas = computed(() => (ideas.value ?? []).filter((row) => row.status === 'pending' && !ideasHeld.value.has(row.id)));
export const ideaFiles = computed(() => new Set(pendingIdeas.value.map((row) => row.file_name)));
export const rows = computed(() => (kb.value ? articleRows(kb.value.kb, kb.value.drafts, ideaFiles.value) : []));

const token = (): string => readToken() ?? '';

export interface Reply<T> {
  ok: boolean;
  status: number;
  body: T;
}

/** Запрос, который отдаёт и тело ошибки: 409 несёт текст и автора (10.5 п.5–6). */
async function call<T>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
  try {
    const response = await fetch(path, {
      method,
      headers: { authorization: `Bearer ${token()}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => ({})) as T;
    return { ok: response.ok, status: response.status, body: data };
  } catch {
    return { ok: false, status: 0, body: {} as T };
  }
}

/** Ошибка словами (6.6, состояния): без серверной подсказки про chown. */
export function errorText(reply: Reply<unknown>): string {
  const body = reply.body as { code?: string } | null;
  if (reply.status === 0) return t('kb.error.network');
  if (body?.code === 'write_denied') return t('kb.error.writeDenied');
  if (reply.status === 403) return t('kb.error.permission');
  if (reply.status === 404) return t('kb.error.notFound');
  return t('kb.error.generic', { code: String(reply.status) });
}

const path = (area: KbArea, name: string): string => `/api/kb/${area}/${encodeURIComponent(name)}`;

export async function loadKb(): Promise<void> {
  if (!rights.value.read) return;
  kbState.value = kb.peek() ? 'ready' : 'loading';
  const reply = await call<KbListResponse>('GET', '/api/kb');
  if (reply.ok) { kb.value = reply.body; kbState.value = 'ready'; } else kbState.value = kb.peek() ? 'ready' : 'error';
}

function setIdeasCount(count: number): void {
  const boot = bootstrap.peek();
  if (boot && boot.counts.ideas !== null) bootstrap.value = { ...boot, counts: { ...boot.counts, ideas: count } };
}

export async function loadIdeas(): Promise<void> {
  if (!rights.value.review) return;
  ideasState.value = ideas.peek() ? 'ready' : 'loading';
  const reply = await call<IdeasResponse>('GET', '/api/learning/candidates?status=pending');
  if (reply.ok) {
    ideas.value = reply.body.candidates;
    ideasState.value = 'ready';
    setIdeasCount(pendingIdeas.peek().length);
  } else ideasState.value = ideas.peek() ? 'ready' : 'error';
}

export async function readArticle(area: KbArea, name: string): Promise<KbDocResponse | null | 'error'> {
  const reply = await call<KbDocResponse>('GET', path(area, name));
  if (reply.ok) return reply.body;
  return reply.status === 404 ? null : 'error';
}

export type WriteOutcome =
  | { kind: 'ok'; result: KbWriteResponse }
  | { kind: 'conflict'; conflict: KbConflict }
  | { kind: 'error'; text: string };

function outcome(reply: Reply<unknown>): WriteOutcome {
  if (reply.ok) return { kind: 'ok', result: reply.body as KbWriteResponse };
  const body = reply.body as Partial<KbConflict>;
  if (reply.status === 409 && body.code === 'version_conflict') return { kind: 'conflict', conflict: body as KbConflict };
  return { kind: 'error', text: errorText(reply) };
}

/** Новая статья — всегда черновик (10.5 п.1). */
export async function createDraft(fields: DocFields): Promise<WriteOutcome> {
  return outcome(await call('POST', '/api/kb', { title: fields.title.trim(), text: fields.body.trim(), draft: true }));
}

/** Сохранить черновик; expected — версия черновика, null — его ещё нет, undefined — без проверки. */
export async function saveDraft(name: string, fields: DocFields, expected: string | null | undefined): Promise<WriteOutcome> {
  return outcome(await call('PUT', path('draft', name), { text: composeDoc(fields), ...(expected !== undefined ? { expectedVersion: expected } : {}) }));
}

export async function publishDraft(name: string, expected: string): Promise<WriteOutcome> {
  return outcome(await call('POST', `/api/kb/publish/${encodeURIComponent(name)}`, { expectedVersion: expected }));
}

/**
 * «Опубликовано · Отменить» (7.6): опубликованный текст возвращается в
 * черновик (правка не теряется), а в базу — прежний текст или ничего.
 */
export async function undoPublish(name: string, published: string, previous: string | null): Promise<boolean> {
  const back = await call('PUT', path('draft', name), { text: published });
  const restored = previous === null ? await call('DELETE', path('kb', name), {}) : await call('PUT', path('kb', name), { text: previous });
  return back.ok && restored.ok;
}

export async function removeArticle(name: string, kbVersion: string | null, draftVersion: string | null): Promise<WriteOutcome> {
  if (draftVersion !== null) {
    const reply = await call('DELETE', path('draft', name), { expectedVersion: draftVersion });
    if (!reply.ok) return outcome(reply);
  }
  if (kbVersion !== null) {
    const reply = await call('DELETE', path('kb', name), { expectedVersion: kbVersion });
    if (!reply.ok) return outcome(reply);
  }
  return { kind: 'ok', result: { ok: true, name, version: '', previous: null } };
}

/** Похожие статьи для идеи — по названию через поиск (6.6). */
export async function similarArticles(title: string): Promise<Array<{ id: number; title: string; ext_id: string | null; source: string }>> {
  const words = title.split(/\s+/).filter((word) => word.length > 3).slice(0, 3).join(' ') || title;
  const reply = await call<{ knowledge?: Array<{ id: number; title: string; ext_id: string | null; source: string }> }>(
    'GET', `/api/search?q=${encodeURIComponent(words.slice(0, 80))}`);
  return reply.ok ? (reply.body.knowledge ?? []).slice(0, 3) : [];
}

export type Decision = { decision: 'approved' } | { decision: 'rejected'; reason: IdeaRejectReason | null };

class Decided extends Error {
  constructor(readonly info: IdeaDecided) { super(info.error); }
}

/**
 * Решение по идее (6.6): карточка уходит сразу, запрос — после окна отмены
 * 6 с. 409 «уже разобрали» — тост с тем, кто и как решил; публикации нет.
 * Возвращает id следующей идеи.
 */
export function decideIdea(id: number, choice: Decision, onUndo: (id: number) => void): number | null {
  const order = pendingIdeas.peek().map((row) => row.id);
  const next = nextIdeaId(order, id);
  const hold = (on: boolean): void => {
    const set = new Set(ideasHeld.peek());
    if (on) set.add(id); else set.delete(id);
    ideasHeld.value = set;
    setIdeasCount(pendingIdeas.peek().length);
  };
  const row = ideas.peek()?.find((item) => item.id === id);
  hold(true);
  const task: DeferredTask = {
    key: `idea:${id}`,
    async commit(keepalive) {
      const body = choice.decision === 'approved' ? { decision: 'approved' } : { decision: 'rejected', reason: choice.reason, discardDraft: true };
      const response = await fetch(`/api/learning/candidates/${id}`, {
        method: 'POST', keepalive,
        headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({})) as Partial<IdeaDecided> & { candidates?: IdeaRow[] };
      if (response.status === 409 && data.code === 'already_decided') throw new Decided(data as IdeaDecided);
      if (!response.ok) throw new Error(errorText({ ok: false, status: response.status, body: data }));
      if (data.candidates) ideas.value = data.candidates.concat((ideas.peek() ?? []).filter((item) => ideasHeld.peek().has(item.id) && item.id !== id));
    },
    revert() { hold(false); },
    failed(err) {
      if (err instanceof Decided) {
        // Решение уже есть — идею из очереди убираем насовсем.
        ideas.value = (ideas.peek() ?? []).filter((item) => item.id !== id);
        setIdeasCount(pendingIdeas.peek().length);
        const how = err.info.decision === 'approved' ? t('kb.idea.wasPublished') : t('kb.idea.wasRejected');
        showToast({ text: err.info.decided_by ? t('kb.idea.decidedBy', { name: err.info.decided_by, how }) : t('kb.idea.decided', { how }) });
        return;
      }
      showToast({ kind: 'error', ttl: null, text: `${t('kb.idea.failed')} ${err instanceof Error ? err.message : ''}`.trim() });
    },
    done() {
      const set = new Set(ideasHeld.peek());
      set.delete(id);
      ideasHeld.value = set;
      ideas.value = (ideas.peek() ?? []).filter((item) => item.id !== id);
      setIdeasCount(pendingIdeas.peek().length);
      if (choice.decision === 'approved') void loadKb();
    },
  };
  const text = choice.decision === 'approved' ? t('kb.idea.published', { title: row?.title ?? '' }) : t('kb.idea.rejected', { title: row?.title ?? '' });
  deferWithUndo(task, text, t('kb.undo'), () => onUndo(id));
  return next;
}

// --- шаблоны --------------------------------------------------------------

export async function loadTemplates(): Promise<void> {
  if (!rights.value.templates) return;
  templatesState.value = templates.peek() ? 'ready' : 'loading';
  const reply = await call<{ templates: Template[] }>('GET', '/api/templates');
  if (reply.ok) { templates.value = reply.body.templates; templatesState.value = 'ready'; } else templatesState.value = templates.peek() ? 'ready' : 'error';
}

export async function saveTemplate(input: { shortcut: string; title: string; body: string }, replaces?: Template): Promise<string | null> {
  const reply = await call<{ templates?: Template[]; error?: string }>('POST', '/api/templates', input);
  if (!reply.ok) return reply.body.error ?? errorText(reply);
  // Новое короткое имя — новый шаблон: старый убираем (POST обновляет по shortcut).
  if (replaces && replaces.shortcut !== input.shortcut.trim()) {
    const removed = await call<{ templates?: Template[] }>('DELETE', `/api/templates/${replaces.id}`);
    if (removed.ok && removed.body.templates) { templates.value = removed.body.templates; return null; }
  }
  if (reply.body.templates) templates.value = reply.body.templates;
  return null;
}

/** «Удалить» шаблона — сразу с «Отменить» (ярус 0): запрос уходит после окна. */
export function removeTemplate(item: Template): void {
  const before = templates.peek() ?? [];
  templates.value = before.filter((row) => row.id !== item.id);
  deferWithUndo({
    key: `template:${item.id}`,
    async commit(keepalive) {
      const response = await fetch(`/api/templates/${item.id}`, { method: 'DELETE', keepalive, headers: { authorization: `Bearer ${token()}` } });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json().catch(() => ({})) as { templates?: Template[] };
      if (data.templates) templates.value = data.templates;
    },
    revert() { templates.value = before; },
    failed() { showToast({ kind: 'error', ttl: null, text: t('kb.template.removeFailed') }); },
  }, t('kb.template.removed', { name: item.title }), t('kb.undo'));
}

// --- сбор статей из старых диалогов ---------------------------------------

export const mineJob = signal<MineJob | null>(null);

export async function loadMineJob(): Promise<MineJob | null> {
  const reply = await call<{ job: MineJob | null }>('GET', '/api/kb/mine');
  if (reply.ok) mineJob.value = reply.body.job;
  return reply.ok ? reply.body.job : null;
}

export async function startMine(source: 'archive' | 'panel', limit: number): Promise<string | null> {
  const reply = await call<{ error?: string }>('POST', '/api/kb/mine', { source, limit });
  if (reply.ok) { void loadMineJob(); return null; }
  return reply.status === 409 ? t('kb.mine.busy') : reply.body.error ?? errorText(reply);
}

/** Выгрузка Telegram Desktop: первый заход — список участников, второй — с «чьи сообщения ваши». */
export async function startMineExport(file: File, me: string | null): Promise<{ participants: string[] } | { started: true; pairs: number } | { error: string }> {
  try {
    const response = await fetch(`/api/kb/mine/export${me ? `?me=${encodeURIComponent(me)}` : ''}`, {
      method: 'POST', headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/octet-stream' }, body: file,
    });
    const data = await response.json().catch(() => ({})) as { needsMe?: boolean; participants?: string[]; pairs?: number; error?: string };
    if (!response.ok) return { error: response.status === 409 ? t('kb.mine.busy') : data.error ?? t('kb.error.generic', { code: String(response.status) }) };
    if (data.needsMe) return { participants: data.participants ?? [] };
    void loadMineJob();
    return { started: true, pairs: data.pairs ?? 0 };
  } catch {
    return { error: t('kb.error.network') };
  }
}
