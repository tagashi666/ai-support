/** Первый запуск (6.13): чек-лист по фактам, учебный диалог. */
import { describe, expect, it } from 'vitest';
import type { BootstrapResponse } from '@shared/api-types';
import { setsUp } from '@/lib/onboarding';
import { checklist, closedCount, factsFrom, isEmptySystem } from './model';
import { initialTutorial, tutorialReducer, type TutorialState } from './tutorialModel';

const boot = (over: Partial<BootstrapResponse> = {}): BootstrapResponse => ({
  me: { id: 'root', name: 'Владелец', role: 'admin', permissions: [] }, version: '3.0.0',
  capabilities: { nodes: false, update: false, bedolaga: false, minishop: false, remnawave: false, aiKeys: false, inbox: true, events: true, typingWithoutClaim: true },
  assistant: { mode: 'suggest', minConfidence: 0.9, keys: false }, channels: {}, sources: [], folders: [],
  counts: { mine: 0, waiting: 0, ideas: null, problems: null }, update: null, live: { seq: 0, epoch: 'e' }, ...over,
});

describe('чек-лист запуска', () => {
  it('пустая система: ничего не сделано, «Добро пожаловать»', () => {
    const facts = factsFrom(boot(), { articles: 0, people: 1, colleagueSkipped: false, tutorial: false });
    const steps = checklist(facts);
    expect(steps.map((step) => step.state)).toEqual(['todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
    expect(isEmptySystem(facts, 0)).toBe(true);
    expect(isEmptySystem(facts, 3)).toBe(false);
  });
  it('по фактам: канал, модель, 3 статьи, коллега пропущен, учебный пройден', () => {
    const facts = factsFrom(boot({
      sources: [{ id: 's', kind: 'telegram_bot', name: 'Бот', enabled: true }],
      assistant: { mode: 'suggest', minConfidence: 0.9, keys: true },
    }), { articles: 3, people: 1, colleagueSkipped: true, tutorial: true });
    const steps = checklist(facts);
    expect(steps.map((step) => `${step.id}:${step.state}`)).toEqual([
      'telegram:done', 'remnawave:todo', 'assistant:done', 'articles:done', 'colleague:skipped', 'tutorial:done',
    ]);
    expect(closedCount(steps)).toBe(5);
    expect(steps.find((step) => step.id === 'remnawave')?.optional).toBe(true);
  });
  it('помощник выключен — шаг не сделан, даже с ключом', () => {
    const facts = factsFrom(boot({ assistant: { mode: 'off', minConfidence: 0.9, keys: true } }), { articles: null, people: null, colleagueSkipped: false, tutorial: false });
    expect(checklist(facts).find((step) => step.id === 'assistant')?.state).toBe('todo');
  });
  it('шаги ведут на настоящие экраны, адреса без точек', () => {
    const steps = checklist(factsFrom(boot(), { articles: 0, people: 1, colleagueSkipped: false, tutorial: false }));
    expect(steps.find((step) => step.id === 'articles')?.to).toEqual({ name: 'section', key: 'knowledge', sub: 'new' });
    expect(steps.find((step) => step.id === 'tutorial')?.to).toEqual({ name: 'chats', id: 'learn' });
  });
  it('вход А — владелец и администратор, Б — остальные', () => {
    expect(setsUp({ id: 'root', permissions: [] })).toBe(true);
    expect(setsUp({ id: 'op:2', permissions: ['roles:manage'] })).toBe(true);
    expect(setsUp({ id: 'op:3', permissions: ['conversation:reply'] })).toBe(false);
  });
});

describe('учебный диалог', () => {
  const play = (events: Parameters<typeof tutorialReducer>[1][]): { state: TutorialState; tasks: number[] } => {
    let state = initialTutorial(0);
    const tasks: number[] = [];
    for (const event of events) {
      const result = tutorialReducer(state, event, 1000);
      state = result.state;
      if (result.task !== null) tasks.push(result.task);
    }
    return { state, tasks };
  };
  it('пять заданий по порядку', () => {
    const { state, tasks } = play([
      { type: 'sendDraft' }, { type: 'edit' }, { type: 'send', text: 'Да, и на компьютере: установите приложение.' },
      { type: 'note', text: 'Клиент на iOS' }, { type: 'resolve' }, { type: 'reopen' },
    ]);
    expect(tasks).toEqual([1, 2, 3, 4, 5]);
    expect(state.resolved).toBe(false);
    expect(state.messages.filter((message) => message.voice === 'client')).toHaveLength(2);
    expect(state.messages.some((message) => message.edited)).toBe(true);
  });
  it('«Править» без правки — не задание 2', () => {
    const { tasks } = play([{ type: 'edit' }, { type: 'send', text: initialTutorial(0).draft! }]);
    expect(tasks).toEqual([]);
  });
  it('отменить решение можно только после «Решено»', () => {
    expect(play([{ type: 'reopen' }]).tasks).toEqual([]);
  });
});
