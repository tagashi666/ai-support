/**
 * Первый запуск и обучение (план, 6.13): что уже видели на этом устройстве.
 * Чек-лист считается по фактам системы (onboarding/model.ts), здесь — только
 * отметки устройства: скрыт ли чек-лист, пройдены ли подсказки, «Пропустить»
 * у коллеги, учебный диалог (когда впервые показан, задания, закрыт ли).
 * Экраны обучения — ленивый чанк features/onboarding (бюджет начального JS).
 */
import { signal } from '@preact/signals';

export interface OnboardingState {
  /** «Добро пожаловать» пройден (А: владелец, система пуста). */
  welcomeDone?: boolean;
  checklistHidden?: boolean;
  /** Три подсказки нового оператора (Б) пролистаны или закрыты. */
  hintsDone?: boolean;
  colleagueSkipped?: boolean;
  /** Учебный диалог: когда впервые показан (стоит в списке 7 дней), какие задания сделаны, закрыт ли. */
  tutorialSeenAt?: number;
  tutorialTasks?: number[];
  tutorialClosed?: boolean;
}

const KEY = 'next.onboarding';
export const TUTORIAL_DAYS_MS = 7 * 24 * 60 * 60_000;
/** Адрес учебного диалога: /next/chats/learn (без точки в последнем сегменте). */
export const TUTORIAL_ID = 'learn';

function read(): OnboardingState {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as OnboardingState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

export const onboarding = signal<OnboardingState>(read());

export function updateOnboarding(change: Partial<OnboardingState>): void {
  onboarding.value = { ...onboarding.peek(), ...change };
  try { localStorage.setItem(KEY, JSON.stringify(onboarding.peek())); } catch { /* отметки живут до перезагрузки */ }
}

/** Учебный диалог в списке: не закрыт и показан меньше 7 дней назад (первый показ ставит отметку). */
export function tutorialListed(at: number): boolean {
  const state = onboarding.value;
  if (state.tutorialClosed) return false;
  return state.tutorialSeenAt === undefined || at - state.tutorialSeenAt < TUTORIAL_DAYS_MS;
}

/** Кто настраивает установку (вход А): владелец или тот, кто может менять роли. */
export const setsUp = (me: { id: string; permissions: readonly string[] } | undefined): boolean =>
  Boolean(me && (me.id === 'root' || me.permissions.includes('roles:manage')));

/** «Это устройство → Показать подсказки заново / Показать чек-лист запуска» (6.12). */
export function showHintsAgain(): void { updateOnboarding({ hintsDone: false }); }
export function showChecklistAgain(): void { updateOnboarding({ checklistHidden: false, welcomeDone: true, tutorialClosed: false, tutorialSeenAt: Date.now() }); }

/** Нужен ли ленивый чанк обучения на «Сегодня»: иначе его не грузим вовсе. */
export function onboardingWanted(me: { id: string; permissions: readonly string[] } | undefined): boolean {
  if (!me) return false;
  const state = onboarding.value;
  return setsUp(me) ? !state.welcomeDone || !state.checklistHidden : !state.hintsDone;
}
