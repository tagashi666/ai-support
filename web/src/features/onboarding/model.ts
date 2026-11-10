/**
 * Чек-лист запуска (6.13): шаги по фактам системы, а не по галочкам.
 * Отдельного серверного маршрута нет (раздел 15): факты — из bootstrap,
 * /api/kb и /api/team/names, плюс две отметки устройства.
 */
import type { BootstrapResponse } from '@shared/api-types';
import type { Route } from '@/lib/router';

export type StepId = 'telegram' | 'remnawave' | 'assistant' | 'articles' | 'colleague' | 'tutorial';

export interface Facts {
  telegram: boolean;
  remnawave: boolean;
  assistant: boolean;
  /** Опубликовано статей; null — не знаем (нет права или ещё не загрузили). */
  articles: number | null;
  /** Людей в команде; null — не знаем. */
  people: number | null;
  colleagueSkipped: boolean;
  tutorial: boolean;
}

export interface Step {
  id: StepId;
  state: 'done' | 'skipped' | 'todo';
  /** «можно позже» — шаг не обязателен. */
  optional: boolean;
  to: Route;
}

export const ARTICLES_NEEDED = 3;

export function factsFrom(boot: BootstrapResponse | null, extra: Pick<Facts, 'articles' | 'people' | 'colleagueSkipped' | 'tutorial'>): Facts {
  const telegram = Boolean(boot && (boot.sources.some((source) => source.enabled && /^telegram/.test(source.kind))
    || boot.channels.tg_bot || boot.channels.tg_dm));
  return {
    telegram,
    remnawave: Boolean(boot?.capabilities.remnawave),
    assistant: Boolean(boot && boot.assistant.keys && boot.assistant.mode !== 'off'),
    ...extra,
  };
}

export function checklist(facts: Facts): Step[] {
  const step = (id: StepId, done: boolean, to: Route, optional = false, skipped = false): Step =>
    ({ id, state: done ? 'done' : skipped ? 'skipped' : 'todo', optional, to });
  return [
    step('telegram', facts.telegram, { name: 'section', key: 'connections' }),
    step('remnawave', facts.remnawave, { name: 'section', key: 'connections' }, true),
    step('assistant', facts.assistant, { name: 'section', key: 'assistant' }),
    step('articles', (facts.articles ?? 0) >= ARTICLES_NEEDED, { name: 'section', key: 'knowledge', sub: 'new' }),
    step('colleague', (facts.people ?? 0) > 1, { name: 'section', key: 'team', sub: 'people', item: 'new' }, true, facts.colleagueSkipped),
    step('tutorial', facts.tutorial, { name: 'chats', id: 'learn' }),
  ];
}

/** Сколько шагов закрыто: «пропущено» тоже считается — как в макете «3 из 6». */
export const closedCount = (steps: readonly Step[]): number => steps.filter((item) => item.state !== 'todo').length;

/** Система пуста — показать «Добро пожаловать» (вход А): каналов нет и диалогов нет. */
export const isEmptySystem = (facts: Pick<Facts, 'telegram'>, dialogs: number): boolean => !facts.telegram && dialogs === 0;
