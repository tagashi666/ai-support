/**
 * Действия рабочего места на живых данных (реестр 7.4, ярусы 7.6).
 * Ярус 0 — одним нажатием и тост «Отменить» на 6 с; у действий со следом
 * вне панели (Решено, Важно, Убрать, Не подходит) запрос уходит после окна
 * отмены. Действия, которые останавливают помощника (взять себе, выключить),
 * применяются сразу: здесь задержка опаснее. Отправка ответа — ярус 1.
 */
import { computed, effect, signal } from '@preact/signals';
import type { InboxItem, ReplyResponse, ThreadMessage, ThreadSuggestion } from '@shared/api-types';
import { t } from '@/i18n/ru';
import { dismissToast, showToast, undoToast, UNDO_MS } from '@/lib/actions/toasts';
import { ApiError, getJson, newClientId, readToken, sendJson, uploadFile } from '@/lib/live/api';
import { liveName } from '@/lib/live/labels';
import { bootstrap, inbox, mode } from '@/lib/live/store';
import type { ServerDraft } from '@shared/api-types';
import { setCollabHooks } from './collab';
import { DraftSync, tabDevice } from './serverDrafts';
import { deferred, deferWithUndo, type DeferredTask } from './deferred';
import { DraftStore, type Quote } from './drafts';
import { actionErrorText, sendErrorView } from './errors';
import { clientWrote, dropPatch, lastSign, patched, patches, setPatch } from './local';
import { mergeMessages, syncThread, threads, updateThread, type Outgoing } from './thread';
import { TypingSignal } from './typing';
import { modeLabel } from './labels';
import type { HereMode } from './who';

/** Окно отмены отправки (6.3.5, вопрос 14.2) — из «Этого устройства»: по умолчанию черновик 5 с, свой текст сразу. */
export { draftUndoMs, ownUndoMs } from '@/lib/device';
const LEASE_MS = 15 * 60_000;

export const permissions = computed(() => new Set(bootstrap.value?.me.permissions ?? []));
export const meKey = computed(() => bootstrap.value?.me.id ?? '');
export const drafts = new DraftStore(undefined, undefined, (id) => draftSync.saved(id));
/** Черновик и на сервере (7.8): только у тех, кто отвечает, и на живых данных. */
export const draftSync = new DraftSync(drafts, {
  get: async (id) => (await getJson<{ draft: ServerDraft | null }>(`/api/conversations/${id}/draft`, token())).draft,
  put: async (id, body) => (await sendJson<{ draft: ServerDraft | null }>(`/api/conversations/${id}/draft`, token(), body, { method: 'PUT', keepalive: true })).draft,
  remove: async (id) => { await sendJson(`/api/conversations/${id}/draft`, token(), {}, { method: 'DELETE', keepalive: true }); },
}, tabDevice(), () => mode.peek() === 'live' && permissions.peek().has('conversation:reply'));
const typing = new TypingSignal();
let typingFor: number | null = null;

if (typeof addEventListener === 'function') addEventListener('pagehide', () => { drafts.flush(); draftSync.flushAll(); });

const token = (): string => readToken() ?? '';
const post = <T = unknown>(path: string, body: unknown, keepalive = false): Promise<T> =>
  sendJson<T>(path, token(), body, { keepalive });
const state = (id: number, body: Record<string, unknown>, keepalive = false) => post(`/api/conversations/${id}/state`, body, keepalive);

/** Строка с сервера без своих заплаток: из списка или из шапки — что новее. */
function serverItem(id: number): InboxItem | undefined {
  const listed = inbox.peek().entries.get(id)?.item;
  const head = threads.peek().get(id)?.head?.item;
  return listed && head ? (listed.updated_at >= head.updated_at ? listed : head) : listed ?? head;
}

/** Строка диалога: из списка, иначе из шапки открытого диалога. */
export function itemOf(id: number): InboxItem | undefined {
  const base = serverItem(id);
  return base ? patched(base, patches.peek()) ?? base : undefined;
}

const nameOf = (id: number): string => {
  const item = itemOf(id);
  return item ? liveName(item) : '';
};

const codeOf = (err: unknown): string => (err instanceof ApiError ? err.code : 'unknown');
const failToast = (err: unknown): void => { showToast({ text: t(actionErrorText(codeOf(err))), kind: 'error', ttl: null }); };

/** Последнее обратимое действие: ⌘Z вне поля ввода (7.3). */
let lastUndo: (() => void) | null = null;
export function undoLast(): boolean {
  const run = lastUndo;
  lastUndo = null;
  if (!run) return false;
  run();
  return true;
}

function undoable(text: string, undo: () => void): void {
  let id = 0;
  const run = (): void => { dismissToast(id); lastUndo = null; undo(); };
  lastUndo = run;
  id = undoToast(text, run, t('toast.undo'));
}

/** Отложенное действие с «Отменить» в тосте и по ⌘Z; запрос ушёл — отменять уже нечего (M-2). */
function deferUndoable(task: DeferredTask, text: string): () => void {
  let run = (): void => undefined;
  const id = deferWithUndo({ ...task, started: () => { if (lastUndo === run) lastUndo = null; task.started?.(); } }, text, t('toast.undo'));
  run = (): void => { dismissToast(id); if (lastUndo === run) lastUndo = null; deferred.cancel(task.key); };
  lastUndo = run;
  return run;
}

/** Заплатка поверх текущей строки: показ меняется сразу. held — держать поверх новых кадров до ухода запроса. */
function patch(id: number, change: Partial<InboxItem>, removed = false, held = false): void {
  const item = itemOf(id);
  setPatch(id, { base: item?.updated_at ?? 0, patch: change, ...(removed ? { removed: true } : {}), ...(held ? { held: true } : {}) });
}

/** Запрос ушёл: заплатка снова живёт до первого кадра новее того, что сейчас известно. */
function release(id: number): void {
  guarded.delete(id);
  const local = patches.peek().get(id);
  if (local?.held) setPatch(id, { ...local, held: false, base: Math.max(local.base, serverItem(id)?.updated_at ?? 0) });
}

/**
 * L-1: «Решено» или «Убрать» ждут окна отмены, а клиент тем временем
 * написал — действие уже не к месту. Снимаем его до запроса (строка
 * остаётся в «Ждут вас») и говорим об этом тостом. Отпечаток — последнее
 * сообщение строки в момент нажатия.
 */
const guarded = new Map<number, { sign: string; cancel: () => void }>();
function guard(id: number, cancel: () => void): void {
  guarded.set(id, { sign: lastSign(serverItem(id)), cancel });
}
effect(() => {
  inbox.value; threads.value;
  for (const [id, entry] of guarded) {
    const item = serverItem(id);
    if (!clientWrote(entry.sign, item)) continue;
    guarded.delete(id);
    entry.cancel();
    showToast({ text: t('toast.clientWrote', { name: item ? liveName(item) : '' }) });
  }
});

/** Отложенное действие яруса 0 со следом вне панели; conflict — снять, если клиент напишет в окне отмены. */
function deferredAction(id: number, key: string, change: Partial<InboxItem>, body: Record<string, unknown>, text: string, removed = false, conflict = false): void {
  patch(id, change, removed, true);
  const taskKey = `${key}:${id}`;
  const cancel = deferUndoable({
    key: taskKey,
    commit: async (keepalive) => { await state(id, body, keepalive); },
    revert: () => { guarded.delete(id); dropPatch(id); },
    failed: failToast,
    started: () => release(id),
    done: () => { void syncThread(id); },
  }, text);
  if (conflict) guard(id, cancel);
}

/** Сразу, с «Отменить» обратным запросом. */
async function immediate(id: number, change: Partial<InboxItem>, body: Record<string, unknown>, text: string, undoBody: Record<string, unknown> | null): Promise<void> {
  patch(id, change);
  try {
    await state(id, body);
    void syncThread(id);
    if (undoBody) {
      undoable(text, () => {
        dropPatch(id);
        void state(id, undoBody).then(() => syncThread(id)).catch(failToast);
      });
    } else showToast({ text });
  } catch (err) {
    dropPatch(id);
    failToast(err);
  }
}

export function resolve(id: number): void {
  deferredAction(id, 'resolve', { status: 'resolved', state: 'done', section: 'done' }, { status: 'resolved' },
    t('toast.resolved', { name: nameOf(id) }), false, true);
}

export function reopen(id: number): void {
  void immediate(id, { status: 'open' }, { status: 'open' }, t('toast.reopened', { name: nameOf(id) }), { status: 'resolved' });
}

export function waitClient(id: number): void {
  void immediate(id, { status: 'pending' }, { status: 'pending' }, t('toast.waitClient'), { status: 'open' });
}

export function setImportant(id: number, value: boolean): void {
  const item = itemOf(id);
  deferredAction(id, 'important', { flags: { ...(item?.flags ?? { not_found: false, handoff: false }), important: value } },
    { escalated: value }, t(value ? 'toast.important' : 'toast.unimportant'));
}

export function hide(id: number): void {
  deferredAction(id, 'hide', {}, { hidden: true }, t('toast.hidden'), true, true);
}

export function unhide(id: number): void {
  void immediate(id, {}, { hidden: false }, t('toast.unhidden'), { hidden: true });
}

/** «Прочитано»: отметка уходит в канал (voice.md R5) — только явным действием или открытием. */
export function markRead(id: number): void {
  const item = itemOf(id);
  if (!item || item.unread === 0) return;
  patch(id, { unread: 0 });
  void post(`/api/conversations/${id}/read`, {}).catch(() => dropPatch(id));
}

/** «Взять себе»: передача человеку и закрепление на 15 мин — сразу, помощник молчит. */
export async function take(id: number, quiet = false): Promise<boolean> {
  const me = bootstrap.peek()?.me;
  patch(id, { owner: me ? { id: me.id, name: me.name, until: Date.now() + LEASE_MS } : null });
  try {
    await state(id, { handoff: true });
    await post(`/api/conversations/${id}/engage`, {});
    void syncThread(id);
    if (!quiet) undoable(t('toast.took'), () => { void giveBack(id, true); });
    return true;
  } catch (err) {
    dropPatch(id);
    failToast(err);
    return false;
  }
}

export async function giveBack(id: number, quiet = false): Promise<void> {
  patch(id, { owner: null, flags: { ...(itemOf(id)?.flags ?? { important: false, not_found: false }), handoff: false } });
  try {
    await state(id, { handoff: false });
    // Закрепление снимается, только если оно ваше; чужое сервер не отдаст (409).
    await post(`/api/conversations/${id}/release`, {}).catch(() => undefined);
    void syncThread(id);
    if (!quiet) undoable(t('toast.gaveBack'), () => { void take(id, true); });
  } catch (err) {
    dropPatch(id);
    failToast(err);
  }
}

/** «Перехватить…» (ярус 2 — лист спрашивает до вызова). */
export async function takeover(id: number): Promise<void> {
  try {
    await post(`/api/conversations/${id}/engage`, { force: true });
    void syncThread(id);
    showToast({ text: t('toast.took') });
  } catch (err) { failToast(err); }
}

export async function setMode(id: number, mode: HereMode): Promise<void> {
  const before = itemOf(id)?.ai.configured ?? 'inherit';
  try {
    await state(id, { aiMode: mode });
    void syncThread(id);
    undoable(t('who.modeChanged', { mode: modeLabel(mode) }), () => {
      void state(id, { aiMode: before }).then(() => syncThread(id)).catch(failToast);
    });
  } catch (err) { failToast(err); }
}

export async function saveNote(id: number, text: string): Promise<boolean> {
  const body = text.trim();
  if (!body) return false;
  try {
    await post(`/api/conversations/${id}/note`, { text: body });
    void syncThread(id);
    showToast({ text: t('toast.noteSaved') });
    return true;
  } catch (err) {
    failToast(err);
    return false;
  }
}

/**
 * «Попросить передать» (10.6 п.8): тому, кто ведёт, — тост «Иван просит
 * передать диалог · Передать», в ленте — заметка для команды (пишет сервер).
 * Сервер не принял (закрепление уже кончилось) — только своя заметка, как раньше.
 */
export async function askHandover(id: number, owner: string): Promise<void> {
  try {
    await post(`/api/conversations/${id}/handover-request`, {});
    void syncThread(id);
    showToast({ text: t('handover.sent', { name: owner }) });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'permission') { failToast(err); return; }
    void saveNote(id, t('note.askHandover', { name: owner }));
  }
}

/** «Передать» из тоста просьбы: снять своё закрепление. */
async function handOver(id: number): Promise<boolean> {
  try {
    await post(`/api/conversations/${id}/release`, {});
    void syncThread(id);
    return true;
  } catch (err) { failToast(err); return false; }
}
setCollabHooks({ draft: (id, frame) => draftSync.frame(id, frame.draft), release: handOver });

export async function copyLink(id: number): Promise<void> {
  try {
    await navigator.clipboard.writeText(`${location.origin}/next/chats/${id}`);
    showToast({ text: t('toast.linkCopied') });
  } catch { showToast({ text: t('error.copy'), kind: 'error', ttl: null }); }
}

/** Печать в поле ответа: помощник молчит, диалог не закрепляется (10.2 п.6). */
export function typingKey(id: number): void {
  if (typingFor !== id) { typing.reset(); typingFor = id; }
  if (!permissions.peek().has('conversation:status') || !typing.keystroke(Date.now())) return;
  void post(`/api/conversations/${id}/engage`, { typing: true }).catch(() => undefined);
}

// --- черновик помощника -------------------------------------------------

/** «Не подходит»: черновик убирается сразу, решение уходит после окна отмены. */
export function rejectDraft(id: number, reason: string | null): void {
  const suggestion = threads.peek().get(id)?.suggestion;
  if (!suggestion) return;
  updateThread(id, (current) => ({ ...current, suggestion: null }));
  const key = `reject:${suggestion.id}`;
  deferUndoable({
    key,
    commit: async (keepalive) => {
      await post(`/api/suggestions/${suggestion.id}/decide`, { status: 'rejected', ...(reason ? { reason } : {}) }, keepalive);
    },
    revert: () => updateThread(id, (current) => ({ ...current, suggestion: current.suggestion ?? suggestion })),
    failed: failToast,
  }, t('draft.rejected'));
}

/** «Править»: текст черновика — в поле, курсор в конец; ответ уйдёт с пометкой «изменён». */
export function editDraft(id: number): void {
  const suggestion = threads.peek().get(id)?.suggestion;
  if (!suggestion) return;
  drafts.set(id, { text: suggestion.text, mode: 'reply', fromSuggestion: suggestion.id });
  draftTick.value += 1;
}

// --- отправка -------------------------------------------------------------

function setOutgoing(id: number, localId: string, change: Partial<Outgoing> | null): void {
  updateThread(id, (current) => ({
    ...current,
    outgoing: change === null
      ? current.outgoing.filter((item) => item.localId !== localId)
      : current.outgoing.map((item) => (item.localId === localId ? { ...item, ...change } : item)),
  }));
}

function delivered(id: number, localId: string, message: ThreadMessage | null, suggestionId: number | null): void {
  updateThread(id, (current) => ({
    ...current,
    outgoing: current.outgoing.filter((item) => item.localId !== localId),
    messages: message ? mergeMessages(current.messages, [message]) : current.messages,
    suggestion: suggestionId !== null && current.suggestion?.id === suggestionId ? null : current.suggestion,
  }));
  void syncThread(id);
}

function scheduleSend(id: number, entry: Outgoing, delay: number): void {
  const key = `send:${entry.localId}`;
  deferred.schedule({
    key,
    commit: async (keepalive) => {
      setOutgoing(id, entry.localId, { state: 'sending', sendAt: null, error: null });
      const response = await post<ReplyResponse>(`/api/conversations/${id}/reply`, {
        text: entry.text,
        clientMsgId: entry.clientMsgId,
        ...(entry.suggestionId !== null ? { suggestionId: entry.suggestionId, edited: entry.edited } : {}),
        ...(entry.quote ? { replyTo: entry.quote.quoteId, replyExcerpt: entry.quote.excerpt } : {}),
      }, keepalive);
      delivered(id, entry.localId, response.thread, entry.suggestionId);
    },
    // Отмена — cancelSend; неудача оставляет пузырь с «Повторить».
    revert: () => undefined,
    failed: (err) => {
      const code = codeOf(err);
      setOutgoing(id, entry.localId, { state: 'failed', code, error: sendErrorView(code, true) });
    },
  }, delay);
}

export interface SendInput { text: string; suggestionId: number | null; edited: boolean; quote: Quote | null; delay: number; restore?: ThreadSuggestion }

/** Пузырь появляется сразу; запрос — после окна отмены. */
export function sendReply(id: number, input: SendInput): void {
  const text = input.text.trim();
  if (!text) return;
  const entry: Outgoing = {
    localId: newClientId(), clientMsgId: newClientId(), kind: 'text', text, state: input.delay > 0 ? 'waiting' : 'sending',
    sendAt: input.delay > 0 ? Date.now() + input.delay : null, error: null, code: null,
    suggestionId: input.suggestionId, edited: input.edited, quote: input.quote, at: Date.now(),
    ...(input.restore ? { restore: input.restore } : {}),
  };
  updateThread(id, (current) => ({ ...current, outgoing: [...current.outgoing, entry] }));
  // «Отправить» по черновику сразу останавливает помощника — ещё до окна отмены (5 с < 45 с).
  if (input.suggestionId !== null) {
    typing.sent(Date.now());
    void post(`/api/conversations/${id}/engage`, { typing: true }).catch(() => undefined);
  }
  scheduleSend(id, entry, input.delay);
}

/** «Отменить» во время окна: сообщение не уходит, текст возвращается в поле. */
export function cancelSend(id: number, localId: string): void {
  const entry = threads.peek().get(id)?.outgoing.find((item) => item.localId === localId);
  if (!entry || !deferred.cancel(`send:${localId}`)) return;
  setOutgoing(id, localId, null);
  const restore = entry.restore;
  if (restore) updateThread(id, (current) => ({ ...current, suggestion: current.suggestion ?? restore }));
  else toField(id, entry);
}

/** Повторное ⌘↵ или кнопка — отправить сейчас. */
export function sendNow(localId: string): void { deferred.now(`send:${localId}`); }

export function retrySend(id: number, localId: string): void {
  const entry = threads.peek().get(id)?.outgoing.find((item) => item.localId === localId);
  if (!entry || entry.kind !== 'text') return;
  setOutgoing(id, localId, { state: 'sending', error: null });
  scheduleSend(id, entry, 0);
}

/** «Вернуть в поле»: текст снова ваш черновик. */
export function returnToField(id: number, localId: string): void {
  const entry = threads.peek().get(id)?.outgoing.find((item) => item.localId === localId);
  if (!entry) return;
  setOutgoing(id, localId, null);
  toField(id, entry);
}

function toField(id: number, entry: Outgoing): void {
  if (entry.kind !== 'text') return;
  const current = drafts.get(id);
  drafts.set(id, {
    text: current.text.trim() ? `${current.text}\n${entry.text}` : entry.text,
    mode: 'reply',
    quote: entry.quote,
    fromSuggestion: entry.suggestionId,
  });
  draftTick.value += 1;
}

/** Черновики живут вне сигналов; счётчик будит поле ответа после «Вернуть в поле» и «Править». */
export const draftTick = signal(0);

// --- файлы ----------------------------------------------------------------

const DANGEROUS = /\.(?:exe|msi|bat|cmd|com|scr|ps1|vbs|js|jar|apk|sh|dmg|pkg|app|deb|rpm|run)$/i;
export const isDangerous = (name: string): boolean => DANGEROUS.test(name);
export const FILE_MAX_BYTES = 45 * 1024 * 1024;
export const FILES_MAX = 10;

/** Отправка файла: пузырь «Загружается…», повтор без дубля по x-client-msg-id. */
export async function sendFile(id: number, file: File, options: { dangerousConfirmed: boolean; quote: Quote | null }): Promise<void> {
  const entry: Outgoing = {
    localId: newClientId(), clientMsgId: newClientId(), kind: 'file', text: '', fileName: file.name, state: 'sending',
    sendAt: null, error: null, code: null, suggestionId: null, edited: false, quote: options.quote, at: Date.now(),
  };
  updateThread(id, (current) => ({ ...current, outgoing: [...current.outgoing, entry] }));
  try {
    const response = await uploadFile<ReplyResponse>(`/api/conversations/${id}/attachments`, token(), file, {
      'x-upload-batch': entry.clientMsgId.replace(/^cm-/, ''),
      'x-upload-batch-size': '1',
      'x-upload-index': '0',
      'x-client-msg-id': entry.clientMsgId,
      ...(options.quote ? { 'x-reply-to': encodeURIComponent(options.quote.quoteId) } : {}),
      ...(options.dangerousConfirmed ? { 'x-dangerous-confirmed': 'yes' } : {}),
    });
    delivered(id, entry.localId, response.thread, null);
  } catch (err) {
    const code = codeOf(err);
    setOutgoing(id, entry.localId, { state: 'failed', code, error: sendErrorView(code, true) });
  }
}

export function dismissOutgoing(id: number, localId: string): void { setOutgoing(id, localId, null); }

// --- пакетные действия (6.2, 7.6, 10.3 п.1) ---------------------------------

export type BulkAction = 'resolve' | 'read' | 'important' | 'hide';

const BULK_BODY: Record<BulkAction, Record<string, unknown> | null> = {
  resolve: { status: 'resolved' }, important: { escalated: true }, hide: { hidden: true }, read: null,
};

/**
 * Пакет: показ меняется сразу у всех строк, запросы уходят после окна
 * отмены. Маршрута-пакета (10.3 п.1) на сервере пока нет — панель шлёт /state
 * по одному и сама собирает итог «Решено 8 из 9». «Прочитано» уходит в канал
 * клиенту, поэтому сразу и без отмены.
 */
export function bulk(ids: readonly number[], action: BulkAction): void {
  if (!ids.length) return;
  const n = ids.length;
  if (action === 'read') {
    for (const id of ids) markRead(id);
    showToast({ text: t('bulk.readDone', { n }) });
    return;
  }
  for (const id of ids) {
    const item = itemOf(id);
    if (action === 'resolve') patch(id, { status: 'resolved', state: 'done', section: 'done' }, false, true);
    else if (action === 'important') patch(id, { flags: { ...(item?.flags ?? { not_found: false, handoff: false }), important: true } }, false, true);
    else patch(id, {}, true, true);
    // Клиент написал в окне отмены — эту строку из пакета не закрываем (L-1).
    if (action !== 'important') guard(id, () => dropPatch(id));
  }
  const key = `bulk:${action}:${ids.join(',')}`;
  const body = BULK_BODY[action]!;
  const label = action === 'resolve' ? 'bulk.resolved' : action === 'important' ? 'bulk.important' : 'bulk.hidden';
  deferUndoable({
    key,
    commit: async (keepalive) => {
      const failed: number[] = [];
      // Снятые по L-1 (заплатки уже нет) не отправляем.
      const live = ids.filter((id) => patches.peek().get(id)?.held);
      for (const id of live) release(id);
      for (const id of live) {
        try { await state(id, body, keepalive); } catch { failed.push(id); dropPatch(id); }
      }
      for (const id of live) if (!failed.includes(id)) void syncThread(id);
      if (failed.length) {
        showToast({ text: t('bulk.partial', { done: live.length - failed.length, n: live.length, names: failed.map(nameOf).filter(Boolean).join(', ') }), kind: 'error', ttl: null });
      }
    },
    revert: () => { for (const id of ids) { guarded.delete(id); dropPatch(id); } },
    failed: failToast,
  }, t(label, { n }));
}
