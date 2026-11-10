/**
 * Ваш черновик по диалогу (план, 7.8): текст, вкладка «Ответ» или «Заметка»,
 * цитата. Сохраняется на устройстве с задержкой 300 мс и переживает
 * перезагрузку, ответ 401 и сбой вкладки. Файлы не сохраняются (сказано под
 * полем). С этапа 7 ещё и на сервере (serverDrafts.ts): onSaved сообщает
 * о каждой записи, adopt кладёт пришедшее с сервера без обратного эха.
 */
export interface Quote { id: number; quoteId: string; excerpt: string }

export interface LocalDraft {
  text: string;
  mode: 'reply' | 'note';
  quote: Quote | null;
  /** Текст перенесён из черновика помощника («Править»): ответ уйдёт с пометкой «изменён». */
  fromSuggestion: number | null;
  at: number;
  /** Значение `at`, с которым черновик последний раз сверен с сервером: at > synced — есть несохранённое на сервере. */
  synced?: number;
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = 'next.draft.';
export const DRAFT_SAVE_MS = 300;
/** Старше — не восстанавливаем (как будущий срок хранения на сервере, 7.8). */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/** Пусто: нечего хранить ни на устройстве, ни на сервере. */
export const isEmpty = (draft: Pick<LocalDraft, 'text' | 'quote' | 'mode'>): boolean => !draft.text.trim() && !draft.quote && draft.mode === 'reply';

export const emptyDraft = (): LocalDraft => ({ text: '', mode: 'reply', quote: null, fromSuggestion: null, at: 0 });

const safeStorage = (): DraftStorage | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

export class DraftStore {
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly memory = new Map<number, LocalDraft>();

  constructor(
    private readonly storage: DraftStorage | null = safeStorage(),
    private readonly now: () => number = Date.now,
    /** Черновик записан на устройство (null — очищен): повод отправить его на сервер. */
    private readonly onSaved: ((id: number, draft: LocalDraft | null) => void) | null = null,
  ) {}

  get(id: number): LocalDraft {
    const known = this.memory.get(id);
    if (known) return known;
    let parsed: LocalDraft | null = null;
    try {
      const raw = this.storage?.getItem(PREFIX + id);
      parsed = raw ? JSON.parse(raw) as LocalDraft : null;
    } catch { parsed = null; }
    const draft = parsed && typeof parsed.text === 'string' && this.now() - (parsed.at ?? 0) < DRAFT_MAX_AGE_MS
      ? { ...emptyDraft(), ...parsed }
      : emptyDraft();
    this.memory.set(id, draft);
    return draft;
  }

  /** Изменение видно сразу; на устройство — через 300 мс после последнего. */
  set(id: number, change: Partial<LocalDraft>): LocalDraft {
    const next = { ...this.get(id), ...change, at: this.now() };
    this.memory.set(id, next);
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.set(id, setTimeout(() => this.persist(id), DRAFT_SAVE_MS));
    return next;
  }

  /** После отправки: черновик больше не нужен. quiet — без сообщения наружу (пришло с сервера). */
  clear(id: number, quiet = false): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.memory.set(id, emptyDraft());
    try { this.storage?.removeItem(PREFIX + id); } catch { /* хранилище недоступно */ }
    if (!quiet) this.onSaved?.(id, null);
  }

  /** Черновик с сервера: сразу на устройство, уже сверенный, без onSaved. */
  adopt(id: number, change: Omit<LocalDraft, 'at' | 'synced'>): LocalDraft {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const at = this.now();
    const next: LocalDraft = { ...change, at, synced: at };
    this.memory.set(id, next);
    this.write(id, next);
    return next;
  }

  /** Сервер принял черновик с этим `at`. */
  markSynced(id: number, at: number): void {
    const current = this.memory.get(id);
    if (!current || current.at !== at) return;
    const next = { ...current, synced: at };
    this.memory.set(id, next);
    if (!this.timers.has(id)) this.write(id, next);
  }

  /** Записать всё отложенное сейчас (уход со страницы). */
  flush(): void {
    for (const id of [...this.timers.keys()]) this.persist(id);
  }

  private persist(id: number): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const draft = this.memory.get(id);
    if (!draft) return;
    this.write(id, draft);
    this.onSaved?.(id, isEmpty(draft) ? null : draft);
  }

  private write(id: number, draft: LocalDraft): void {
    try {
      if (isEmpty(draft)) this.storage?.removeItem(PREFIX + id);
      else this.storage?.setItem(PREFIX + id, JSON.stringify(draft));
    } catch { /* хранилище переполнено или закрыто: черновик живёт в памяти */ }
  }
}
