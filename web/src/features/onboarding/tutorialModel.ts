/**
 * Ход учебного диалога (6.13 В) — чистая функция для Vitest. Задания:
 * 1 — отправить черновик как есть; 2 — «Править» и отправить изменённый;
 * 3 — заметка; 4 — «Решено»; 5 — отменить решение.
 */
import { tr } from '@/i18n/sections/onboarding';

export interface TutorialMessage { id: number; voice: 'client' | 'you' | 'note'; text: string; at: number; edited?: boolean }

export interface TutorialState {
  messages: TutorialMessage[];
  /** Черновик помощника на экране; null — нет. */
  draft: string | null;
  /** Какой по счёту черновик (1 или 2): второй приходит после ответа на первый. */
  round: number;
  /** «Править» нажато: следующий ответ — по черновику. */
  editing: string | null;
  resolved: boolean;
}

export type TutorialEvent =
  | { type: 'sendDraft' } | { type: 'edit' } | { type: 'send'; text: string } | { type: 'note'; text: string }
  | { type: 'resolve' } | { type: 'reopen' };

export function initialTutorial(now: number): TutorialState {
  return {
    messages: [{ id: 1, voice: 'client', text: tr('onb.tut.msg1'), at: now - 4 * 60_000 }],
    draft: tr('onb.tut.draft1'), round: 1, editing: null, resolved: false,
  };
}

/** После ответа на первый черновик клиент спрашивает ещё — и приходит второй черновик. */
function nextRound(state: TutorialState, now: number): TutorialState {
  if (state.round !== 1) return { ...state, draft: null };
  return {
    ...state, round: 2, draft: tr('onb.tut.draft2'),
    messages: [...state.messages, { id: state.messages.length + 2, voice: 'client', text: tr('onb.tut.msg2'), at: now + 1000 }],
  };
}

export function tutorialReducer(state: TutorialState, event: TutorialEvent, now: number): { state: TutorialState; task: number | null } {
  const add = (message: Omit<TutorialMessage, 'id'>): TutorialMessage[] => [...state.messages, { ...message, id: state.messages.length + 1 }];
  switch (event.type) {
    case 'sendDraft': {
      if (state.draft === null) return { state, task: null };
      const sent = { ...state, messages: add({ voice: 'you', text: state.draft, at: now }) };
      return { state: nextRound(sent, now), task: 1 };
    }
    case 'edit':
      return { state: { ...state, editing: state.draft, draft: null }, task: null };
    case 'send': {
      const edited = state.editing !== null && event.text !== state.editing.trim();
      const sent = { ...state, editing: null, messages: add({ voice: 'you', text: event.text, at: now, edited }) };
      const after = state.editing !== null ? nextRound(sent, now) : sent;
      return { state: after, task: edited ? 2 : null };
    }
    case 'note':
      return { state: { ...state, messages: add({ voice: 'note', text: event.text, at: now }) }, task: 3 };
    case 'resolve':
      return { state: { ...state, resolved: true }, task: 4 };
    case 'reopen':
      return { state: { ...state, resolved: false }, task: state.resolved ? 5 : null };
  }
}
