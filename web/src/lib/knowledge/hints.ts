/**
 * «Подсказки по кабинету Bedolaga» (бывший «Справочник интерфейса», 6.6):
 * стандартное из поставки + правки установки. Та же модель, что в классике
 * (public/js/iface.js): правка — заплатка `all` или вида, свой экран — в
 * `added`, скрытый — `hidden`. Сервер проверяет и чистит всё сам.
 */
export type HintMode = 'full' | 'lite';
export const HINT_FIELDS = ['title', 'routeDescription', 'keywords', 'instructions', 'caption', 'image'] as const;
export type HintField = (typeof HINT_FIELDS)[number];

export interface HintScreen {
  id: string;
  title: string;
  routeDescription: string;
  keywords: string[];
  instructions: string[];
  image?: string | null;
  caption?: string | null;
  only?: HintMode;
  modes?: Partial<Record<HintMode, Partial<HintScreen>>>;
}

type Patch = Partial<Record<HintField, unknown>>;

export interface HintOverrides {
  screens: Record<string, { all?: Patch; full?: Patch; lite?: Patch; hidden?: boolean }>;
  added: HintScreen[];
}

export interface HintsState {
  enabled: boolean;
  setting: 'auto' | HintMode;
  effectiveMode: HintMode;
  detected: { mode: HintMode; at: number } | null;
  modes: HintMode[];
  shipped: { screens?: HintScreen[] } | null;
  overrides: HintOverrides;
  resolved: Record<HintMode, HintScreen[]>;
}

export interface HintRow {
  id: string;
  custom: boolean;
  hidden: boolean;
  edited: boolean;
  /** Стандартный вид экрана в этом виде кабинета; null — свой экран. */
  std: HintScreen | null;
  screen: HintScreen;
}

/** Значение экрана «по умолчанию» в выбранном виде: поставка плюс её же отличия вида. */
export function shippedScreen(state: HintsState, id: string, mode: HintMode): HintScreen | null {
  const base = (state.shipped?.screens ?? []).find((item) => item?.id === id);
  if (!base || ((base.only === 'full' || base.only === 'lite') && base.only !== mode)) return null;
  return { ...base, ...(base.modes?.[mode] ?? {}) };
}

export function hintRows(state: HintsState, mode: HintMode): HintRow[] {
  const resolved = new Map((state.resolved[mode] ?? []).map((screen) => [screen.id, screen]));
  const rows = new Map<string, HintRow>();
  for (const base of state.shipped?.screens ?? []) {
    const std = shippedScreen(state, base.id, mode);
    if (!std) continue;
    const own = state.overrides.screens[base.id];
    rows.set(base.id, {
      id: base.id, custom: false, hidden: Boolean(own?.hidden), std, screen: resolved.get(base.id) ?? std, edited: Boolean(own && (own.all || own[mode])),
    });
  }
  for (const item of state.overrides.added) {
    if (item.only && item.only !== mode) continue;
    const screen = resolved.get(item.id);
    if (screen) rows.set(item.id, { id: item.id, custom: true, hidden: false, edited: false, std: null, screen });
  }
  return [...rows.values()];
}

export const normField = (field: HintField, value: unknown): string | string[] =>
  field === 'keywords' || field === 'instructions' ? (Array.isArray(value) ? value.map(String) : []) : String(value ?? '').trim();

export const sameField = (field: HintField, a: unknown, b: unknown): boolean =>
  JSON.stringify(normField(field, a)) === JSON.stringify(normField(field, b));

/** Поле в виде текста для ввода: слова — через запятую, шаги — по строке. */
export function fieldText(field: HintField, value: unknown): string {
  const norm = normField(field, value);
  return Array.isArray(norm) ? norm.join(field === 'keywords' ? ', ' : '\n') : norm;
}

export interface HintForm {
  title: string;
  routeDescription: string;
  keywords: string;
  instructions: string;
  caption: string;
  image: string | null;
}

export const formOf = (screen: Partial<HintScreen>): HintForm => ({
  title: fieldText('title', screen.title), routeDescription: fieldText('routeDescription', screen.routeDescription),
  keywords: fieldText('keywords', screen.keywords), instructions: fieldText('instructions', screen.instructions),
  caption: fieldText('caption', screen.caption), image: screen.image ?? null,
});

export function valueOf(form: HintForm): Record<HintField, unknown> {
  return {
    title: form.title.trim(), routeDescription: form.routeDescription.trim(),
    keywords: form.keywords.split(/[,;\n]/).map((word) => word.trim()).filter(Boolean),
    instructions: form.instructions.split('\n').map((step) => step.trim()).filter(Boolean),
    caption: form.caption.trim(), image: form.image,
  };
}

export type HintProblem = 'needTitle' | 'needSteps' | 'tooManySteps' | 'tooManyWords' | null;

export function checkForm(form: HintForm): HintProblem {
  const value = valueOf(form);
  const steps = value.instructions as string[];
  const words = value.keywords as string[];
  if (!value.title || !value.routeDescription) return 'needTitle';
  if (!steps.length) return 'needSteps';
  if (steps.length > 30 || steps.some((step) => step.length > 600)) return 'tooManySteps';
  if (words.length > 30 || words.some((word) => word.length > 80)) return 'tooManyWords';
  return null;
}

const copy = (value: HintOverrides): HintOverrides => JSON.parse(JSON.stringify(value)) as HintOverrides;

/** Сохранить правку поставляемого экрана: в заплатку идут только отличия от текущего вида. */
export function withEdit(overrides: HintOverrides, id: string, target: 'all' | HintMode, form: HintForm, current: HintScreen): HintOverrides {
  const next = copy(overrides);
  const entry = (next.screens[id] ??= {});
  const patch: Patch = { ...(entry[target] ?? {}) };
  const value = valueOf(form);
  for (const field of HINT_FIELDS) {
    if (sameField(field, value[field], current[field])) continue;
    // null снимает значение: так убираются подпись и картинка из поставки.
    patch[field] = field === 'caption' || field === 'image' ? (value[field] || null) : value[field];
  }
  if (Object.keys(patch).length) entry[target] = patch; else delete entry[target];
  if (!Object.keys(entry).length) delete next.screens[id];
  return next;
}

/** Свой экран: добавить или заменить. */
export function withOwn(overrides: HintOverrides, id: string | null, form: HintForm, only: HintMode | null, now = Date.now()): HintOverrides {
  const next = copy(overrides);
  const value = valueOf(form);
  const item: HintScreen = {
    id: id ?? `own-${now.toString(36)}`, title: value.title as string, routeDescription: value.routeDescription as string,
    keywords: value.keywords as string[], instructions: value.instructions as string[],
    ...(value.caption ? { caption: value.caption as string } : {}), ...(value.image ? { image: value.image as string } : {}),
    ...(only ? { only } : {}),
  };
  const at = next.added.findIndex((entry) => entry.id === item.id);
  if (at >= 0) next.added[at] = item; else next.added.push(item);
  return next;
}

export function withHidden(overrides: HintOverrides, id: string, hidden: boolean): HintOverrides {
  const next = copy(overrides);
  if (hidden) (next.screens[id] ??= {}).hidden = true;
  else if (next.screens[id]) {
    delete next.screens[id].hidden;
    if (!Object.keys(next.screens[id]).length) delete next.screens[id];
  }
  return next;
}

export function withReset(overrides: HintOverrides, id: string): HintOverrides {
  const next = copy(overrides);
  const entry = next.screens[id];
  if (entry) {
    delete entry.all; delete entry.full; delete entry.lite;
    if (!entry.hidden) delete next.screens[id];
  }
  return next;
}

export function withoutOwn(overrides: HintOverrides, id: string): HintOverrides {
  const next = copy(overrides);
  next.added = next.added.filter((item) => item.id !== id);
  return next;
}
