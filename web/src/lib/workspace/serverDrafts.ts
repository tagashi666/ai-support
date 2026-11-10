/**
 * Черновик на сервере (план, 7.8 и 10.6 п.5): начатый на телефоне ответ можно
 * дописать на компьютере. Устройство остаётся главным: запись на устройство
 * сразу, на сервер — через 1,5 с после последней записи. При открытии диалога
 * и по кадру `draft` с другого устройства:
 * - здесь пусто или всё уже сверено — берём текст с сервера молча;
 * - здесь есть несохранённое на сервере и тексты разные — спрашиваем:
 *   «На другом устройстве есть текст от 16:12 · Взять его · Оставить этот».
 * Сбой сети черновик не теряет: он остаётся «несверенным» и уйдёт позже.
 */
import { signal } from '@preact/signals';
import type { ServerDraft } from '@shared/api-types';
import { isEmpty, type DraftStore, type LocalDraft } from './drafts';

export const DRAFT_PUSH_MS = 1500;

export interface DraftApi {
  get(id: number): Promise<ServerDraft | null>;
  put(id: number, body: Omit<ServerDraft, 'updated_at'>): Promise<ServerDraft | null>;
  remove(id: number): Promise<void>;
}

const toServer = (draft: LocalDraft, device: string): Omit<ServerDraft, 'updated_at'> => ({
  text: draft.text,
  mode: draft.mode,
  quote: draft.quote ? { id: draft.quote.id, quote_id: draft.quote.quoteId, excerpt: draft.quote.excerpt } : null,
  from_suggestion: draft.fromSuggestion,
  device,
});

const fromServer = (draft: ServerDraft): Omit<LocalDraft, 'at' | 'synced'> => ({
  text: draft.text,
  mode: draft.mode,
  quote: draft.quote ? { id: draft.quote.id, quoteId: draft.quote.quote_id, excerpt: draft.quote.excerpt } : null,
  fromSuggestion: draft.from_suggestion,
});

const same = (local: LocalDraft, server: ServerDraft): boolean =>
  local.text === server.text && local.mode === server.mode && (local.quote?.quoteId ?? null) === (server.quote?.quote_id ?? null);

export class DraftSync {
  /** Расхождения, о которых надо спросить: диалог → черновик с сервера. */
  readonly conflicts = signal<ReadonlyMap<number, ServerDraft>>(new Map());
  /** Черновик в поле сменился с сервера: поле перечитывает его без фокуса. */
  readonly tick = signal(0);
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: DraftStore,
    private readonly api: DraftApi,
    readonly device: string,
    private readonly enabled: () => boolean,
    private readonly delay = DRAFT_PUSH_MS,
  ) {}

  /** DraftStore записал черновик на устройство. */
  saved(id: number): void {
    if (!this.enabled()) return;
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.set(id, setTimeout(() => { void this.push(id); }, this.delay));
  }

  /** Отправить сейчас (уход со страницы, «Оставить этот»). */
  async push(id: number): Promise<void> {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    if (!this.enabled() || this.conflicts.peek().has(id)) return;
    const local = this.store.get(id);
    try {
      if (isEmpty(local)) await this.api.remove(id);
      else {
        await this.api.put(id, toServer(local, this.device));
        this.store.markSynced(id, local.at);
      }
    } catch { /* останется несверенным: уйдёт при следующей записи или открытии */ }
  }

  flushAll(): void { for (const id of [...this.timers.keys()]) void this.push(id); }

  /** Диалог открыт: сверить с сервером. */
  async open(id: number): Promise<void> {
    if (!this.enabled()) return;
    let server: ServerDraft | null;
    try { server = await this.api.get(id); } catch { return; }
    this.reconcile(id, server);
  }

  /** Кадр `draft`: свой (с этой вкладки) пропускаем. */
  frame(id: number, server: ServerDraft | null): void {
    if (!this.enabled() || (server && server.device === this.device)) return;
    this.reconcile(id, server);
  }

  reconcile(id: number, server: ServerDraft | null): void {
    const local = this.store.get(id);
    const dirty = !isEmpty(local) && local.at > (local.synced ?? 0);
    if (!server) {
      if (isEmpty(local)) return;
      // Здесь новое — дописать на сервер; иначе текст отправили или стёрли на другом устройстве.
      if (dirty) this.saved(id);
      else { this.store.clear(id, true); this.tick.value += 1; }
      return;
    }
    if (same(local, server)) { this.store.markSynced(id, local.at); return; }
    if (isEmpty(local) || !dirty) {
      this.store.adopt(id, fromServer(server));
      this.tick.value += 1;
      return;
    }
    if (server.device === this.device) { this.saved(id); return; }
    const next = new Map(this.conflicts.peek());
    next.set(id, server);
    this.conflicts.value = next;
  }

  /** «Взять его»: текст с другого устройства в поле. */
  take(id: number): void {
    const server = this.conflicts.peek().get(id);
    this.drop(id);
    if (!server) return;
    this.store.adopt(id, fromServer(server));
    this.tick.value += 1;
  }

  /** «Оставить этот»: этот текст уходит на сервер. */
  keep(id: number): void {
    this.drop(id);
    void this.push(id);
  }

  private drop(id: number): void {
    if (!this.conflicts.peek().has(id)) return;
    const next = new Map(this.conflicts.peek());
    next.delete(id);
    this.conflicts.value = next;
  }
}

/** Вкладка: своя для каждой, чтобы свой кадр не считался чужим текстом. */
export function tabDevice(): string {
  const key = 'next.deviceTab';
  try {
    const known = sessionStorage.getItem(key);
    if (known) return known;
    const made = `t${Math.random().toString(36).slice(2, 12)}`;
    sessionStorage.setItem(key, made);
    return made;
  } catch { return `t${Math.random().toString(36).slice(2, 12)}`; }
}
