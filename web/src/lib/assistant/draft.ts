/**
 * Несохранённые правки раздела «Помощник» (6.7, правило сохранения 1): всё,
 * что меняет ответы клиентам, копится в полосе «Изменено: N» до «Сохранить».
 * Одна полоса на все подразделы — правка не теряется при смене вкладки.
 */
import { computed, signal } from '@preact/signals';
import { t } from '@/i18n/ru';
import { changedKeys, diffLines, type AssistantSettings } from './model';
import { saveSettings, settings } from './store';

export const draft = signal<Partial<AssistantSettings>>({});
/** Ошибка сохранения: значение остаётся прежним, причина — у полосы. */
export const saveError = signal<string | null>(null);
export const saving = signal(false);

export function setDraft<K extends keyof AssistantSettings>(key: K, value: AssistantSettings[K]): void {
  const saved = settings.peek();
  const next = { ...draft.peek(), [key]: value };
  if (saved && JSON.stringify(saved[key]) === JSON.stringify(value)) delete next[key];
  draft.value = next;
  saveError.value = null;
}

/** Значение поля: правка поверх сохранённого. */
export function valueOf<K extends keyof AssistantSettings>(key: K): AssistantSettings[K] | undefined {
  const edited = draft.value[key];
  return edited !== undefined ? edited as AssistantSettings[K] : settings.value?.[key];
}

export const dirty = computed(() => (settings.value ? changedKeys(settings.value, draft.value) : []));
export const dirtyLines = computed(() => (settings.value ? diffLines(settings.value, draft.value, t) : []));

export function discard(): void {
  draft.value = {};
  saveError.value = null;
}

export async function commit(): Promise<boolean> {
  const values = Object.fromEntries(dirty.peek().map((key) => [key, draft.peek()[key]])) as Partial<AssistantSettings>;
  if (!Object.keys(values).length) return true;
  saving.value = true;
  const result = await saveSettings(values);
  saving.value = false;
  if (!result.ok) { saveError.value = result.error; return false; }
  draft.value = {};
  return true;
}

// Уйти со страницы с несохранённым можно только через вопрос браузера.
if (typeof addEventListener === 'function') {
  addEventListener('beforeunload', (event) => {
    if (dirty.peek().length) { event.preventDefault(); event.returnValue = ''; }
  });
}
