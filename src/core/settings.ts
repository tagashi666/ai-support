import { config, log } from '../config.js';
import type { Store } from './store.js';

/**
 * Настройки, которые меняются из панели без перезапуска.
 *
 * Значение из .env остаётся значением по умолчанию, запись в базе его
 * перекрывает. Сюда попадает только то, что безопасно менять на лету:
 * ключи, адреса и токены живут в .env и правятся на сервере — иначе панель
 * превращается в способ увести доступ ко всей инфраструктуре.
 */
export interface Runtime {
  aiMode: 'off' | 'suggest' | 'auto';
  minConfidence: number;
  autoPerHour: number;
  humanHoldMinutes: number;
  maxAgeMinutes: number;
  slaFirstResponseMinutes: number;
  brand: string;
  replyStyle: string;
  requireKb: boolean;
  handoffMessage: string;
  handoffRepeatMinutes: number;
  notifyLevel: 'all' | 'important' | 'minimal';
  model: string;
  fallbackModel: string;
  /** Индекс ключа для модели, -1 — любой доступный. */
  modelKey: number;
  fallbackKey: number;
}

export const runtime: Runtime = {
  aiMode: config.ai.mode,
  minConfidence: config.ai.minConfidence,
  autoPerHour: config.ai.autoPerHour,
  humanHoldMinutes: config.ai.humanHoldMinutes,
  maxAgeMinutes: config.ai.maxAgeMinutes,
  slaFirstResponseMinutes: config.sla.firstResponseMinutes,
  brand: config.ai.brand,
  replyStyle: config.ai.replyStyle,
  requireKb: config.ai.requireKb,
  handoffMessage: config.ai.handoffMessage,
  handoffRepeatMinutes: config.ai.handoffRepeatMinutes,
  notifyLevel: config.notifyLevel,
  model: config.ai.model,
  fallbackModel: config.ai.fallbackModel,
  modelKey: -1,
  fallbackKey: -1,
};

type Validator = (value: unknown) => unknown | undefined;

interface PendingSetting {
  key: keyof Runtime;
  value: unknown;
}

const NUMBER = (min: number, max: number): Validator => (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return undefined;
  return parsed;
};

/** Каждое поле проверяется: панель не должна уметь записать мусор в конфиг. */
const FIELDS: Record<keyof Runtime, Validator> = {
  aiMode: (value) => (['off', 'suggest', 'auto'].includes(String(value)) ? String(value) : undefined),
  minConfidence: NUMBER(0, 1),
  autoPerHour: NUMBER(0, 100),
  humanHoldMinutes: NUMBER(0, 1440),
  maxAgeMinutes: NUMBER(1, 10080),
  slaFirstResponseMinutes: NUMBER(1, 10080),
  brand: (value) => {
    const text = String(value).trim();
    return text.length >= 1 && text.length <= 60 ? text : undefined;
  },
  replyStyle: (value) => {
    const text = String(value).trim();
    return text.length <= 1200 ? text : undefined;
  },
  handoffMessage: (value) => {
    const text = String(value).trim();
    return text.length >= 5 && text.length <= 600 ? text : undefined;
  },
  handoffRepeatMinutes: NUMBER(0, 10080),
  notifyLevel: (value) => (['all', 'important', 'minimal'].includes(String(value)) ? String(value) : undefined),
  // Имя модели приходит из панели: пробелы и кавычки в нём — верный признак
  // опечатки, а не экзотического названия.
  model: (value) => {
    const text = String(value).trim();
    return /^[\w.:@/\-]{2,80}$/.test(text) ? text : undefined;
  },
  modelKey: NUMBER(-1, 19),
  fallbackKey: NUMBER(-1, 19),
  fallbackModel: (value) => {
    const text = String(value).trim();
    if (!text) return '';
    return /^[\w.:@/\-]{2,80}$/.test(text) ? text : undefined;
  },
  requireKb: (value) => {
    if (typeof value === 'boolean') return value;
    const text = String(value).toLowerCase();
    if (['true','1','on','yes','да'].includes(text)) return true;
    if (['false','0','off','no','нет'].includes(text)) return false;
    return undefined;
  },
};

export function loadSettings(store: Store): void {
  for (const key of Object.keys(FIELDS) as (keyof Runtime)[]) {
    const raw = store.getSetting(key);
    if (raw === undefined) continue;
    const parsed = FIELDS[key](raw);
    if (parsed === undefined) {
      log.warn(`Настройка ${key} в базе невалидна, беру значение из окружения`);
      continue;
    }
    (runtime as unknown as Record<string, unknown>)[key] = parsed;
  }
}

function validateSetting(key: string, value: unknown): { ok: true; setting: PendingSetting } | { ok: false; error: string } {
  // Именно Object.hasOwn, а не `key in FIELDS`: последний видит унаследованные
  // свойства прототипа (constructor, toString, __proto__), и такой ключ прошёл
  // бы валидацию, перезаписав служебные поля runtime и осев мусором в базе.
  if (!Object.hasOwn(FIELDS, key)) return { ok: false, error: `Настройка ${key} не меняется из панели` };
  const parsed = FIELDS[key as keyof Runtime](value);
  if (parsed === undefined) return { ok: false, error: `Недопустимое значение для ${key}` };
  return { ok: true, setting: { key: key as keyof Runtime, value: parsed } };
}

function persistSetting(store: Store, setting: PendingSetting): void {
  (runtime as unknown as Record<string, unknown>)[setting.key] = setting.value;
  store.setSetting(setting.key, setting.value);
}

export function applySetting(store: Store, key: string, value: unknown): { ok: boolean; error?: string } {
  const checked = validateSetting(key, value);
  if (!checked.ok) return checked;
  persistSetting(store, checked.setting);
  log.info(`Настройка ${key} → ${String(checked.setting.value)}`);
  return { ok: true };
}

/**
 * Пакет настроек либо применяется целиком, либо не меняет ничего. Раньше
 * валидное первое поле успевало сохраниться до ошибки во втором, хотя API
 * отвечал 400 и интерфейс считал, что весь запрос отклонён.
 */
export function applySettings(
  store: Store,
  values: Record<string, unknown>,
): { ok: boolean; error?: string } {
  const pending: PendingSetting[] = [];
  const errors: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const checked = validateSetting(key, value);
    if (checked.ok) pending.push(checked.setting);
    else errors.push(checked.error);
  }
  if (errors.length) return { ok: false, error: errors.join('; ') };

  const before = { ...runtime };
  try {
    store.db.transaction(() => {
      for (const setting of pending) persistSetting(store, setting);
    })();
  } catch (err) {
    Object.assign(runtime, before);
    return { ok: false, error: `Настройки не сохранены: ${(err as Error).message}` };
  }

  for (const setting of pending) log.info(`Настройка ${setting.key} → ${String(setting.value)}`);
  return { ok: true };
}
