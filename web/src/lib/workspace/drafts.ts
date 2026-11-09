/**
 * Ваш черновик по диалогу (план, 7.8): текст, вкладка «Ответ» или «Заметка»,
 * цитата. Сохраняется на устройстве с задержкой 300 мс и переживает
 * перезагрузку, ответ 401 и сбой вкладки. Файлы не сохраняются (сказано под
 * полем). На сервере — с этапа 7.
 */
export interface Quote { id: number; quoteId: string; excerpt: string }

export interface LocalDraft {
  text: string;
  mode: 'reply' | 'note';
  quote: Quote | null;
  /** Текст перенесён из черновика помощника («Править»): ответ уйдёт с пометкой «изменён». */
  fromSuggestion: number | null;
  at: number;
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

export const emptyDraft = (): LocalDraft => ({ text: '', mode: 'reply', quote: null, fromSuggestion: null, at: 0 });

const safeStorage = (): DraftStorage | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

export class DraftStore {
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly memory = new Map<number, LocalDraft>();

  constructor(private readonly storage: DraftStorage | null = safeStorage(), private readonly now: () => number = Date.now) {}

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

  /** После отправки: черновик больше не нужен. */
  clear(id: number): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.memory.set(id, emptyDraft());
    try { this.storage?.removeItem(PREFIX + id); } catch { /* хранилище недоступно */ }
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
    try {
      if (!draft.text.trim() && !draft.quote && draft.mode === 'reply') this.storage?.removeItem(PREFIX + id);
      else this.storage?.setItem(PREFIX + id, JSON.stringify(draft));
    } catch { /* хранилище переполнено или закрыто: черновик живёт в памяти */ }
  }
}
