import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { tr } from '@/i18n/sections/onboarding';
import { isMac } from '@/lib/keys';
import { getJson, readToken } from '@/lib/live/api';
import { bootstrap } from '@/lib/live/store';
import { onboarding, setsUp, updateOnboarding } from '@/lib/onboarding';
import { navigate } from '@/lib/router';
import { loadTeamNames, teamNames } from '@/lib/workspace/collab';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { checklist, closedCount, factsFrom, isEmptySystem, type Step, type StepId } from './model';
import s from './onboarding.module.css';

const STEP_TEXT: Record<Exclude<StepId, 'articles'>, Parameters<typeof tr>[0]> = {
  telegram: 'onb.step.telegram',
  remnawave: 'onb.step.remnawave',
  assistant: 'onb.step.assistant',
  colleague: 'onb.step.colleague',
  tutorial: 'onb.step.tutorial',
};
const STEP_ACTION: Record<StepId, Parameters<typeof tr>[0]> = {
  telegram: 'onb.do.connect',
  remnawave: 'onb.do.connect',
  assistant: 'onb.do.setup',
  articles: 'onb.do.add',
  colleague: 'onb.do.invite',
  tutorial: 'onb.do.open',
};

function Welcome(): JSX.Element {
  return (
    <section class={s.welcome} aria-labelledby="onb-welcome">
      <h2 id="onb-welcome" class={s.welcomeTitle}>{tr('onb.welcome.title')}</h2>
      <p>{tr('onb.welcome.text1')}</p>
      <p>{tr('onb.welcome.text2')}</p>
      <div class={s.welcomeActions}>
        <Button variant="primary" onClick={() => { updateOnboarding({ welcomeDone: true }); navigate({ name: 'section', key: 'connections' }); }}>
          {tr('onb.welcome.setup')}
        </Button>
        <Button variant="secondary" onClick={() => updateOnboarding({ welcomeDone: true })}>{tr('onb.welcome.look')}</Button>
      </div>
    </section>
  );
}

function StepRow({ step, index, articles }: { step: Step; index: number; articles: number | null }): JSX.Element {
  const text = step.id === 'articles'
    ? tr(step.state === 'done' ? 'onb.step.articlesDone' : 'onb.step.articles', { n: articles ?? 0 })
    : tr(STEP_TEXT[step.id]);
  return (
    <li class={s.step} data-state={step.state}>
      <span class={s.mark} aria-hidden="true">{step.state === 'todo' ? '○' : '✓'}</span>
      <span class={s.stepText}>
        {index + 1}. {text}
        {step.optional && step.state === 'todo' && <span class={s.optional}> · {tr('onb.list.later')}</span>}
      </span>
      {step.state === 'todo' ? (
        <span class={s.stepActions}>
          {step.id === 'colleague' && <Button variant="quiet" size="sm" onClick={() => updateOnboarding({ colleagueSkipped: true })}>{tr('onb.do.skip')}</Button>}
          <Button variant="secondary" size="sm" onClick={() => navigate(step.to)}>{tr(STEP_ACTION[step.id])}</Button>
        </span>
      ) : <span class={s.stepState}>{tr(step.state === 'done' ? 'onb.list.ready' : 'onb.list.skipped')}</span>}
    </li>
  );
}

/** Чек-лист на «Сегодня» (вход А): по фактам, не мешает работать, скрывается. */
function Checklist(): JSX.Element {
  const boot = bootstrap.value;
  const state = onboarding.value;
  const [articles, setArticles] = useState<number | null>(null);
  const canKb = boot?.me.permissions.includes('knowledge:read') ?? false;
  useEffect(() => {
    void loadTeamNames();
    if (canKb) void getJson<{ kb: unknown[] }>('/api/kb', readToken() ?? '').then((res) => setArticles(res.kb.length)).catch(() => undefined);
  }, [canKb]);
  const steps = checklist(factsFrom(boot, {
    articles, people: teamNames.value?.length ?? null, colleagueSkipped: Boolean(state.colleagueSkipped),
    tutorial: (state.tutorialTasks?.length ?? 0) > 0,
  }));
  const done = closedCount(steps);
  return (
    <Card label={tr('onb.list.label')} class={s.list}>
      <h2 class={s.listTitle}>{tr('onb.list.title', { done, total: steps.length })}</h2>
      <ol class={s.steps}>{steps.map((step, index) => <StepRow key={step.id} step={step} index={index} articles={articles} />)}</ol>
      {done === steps.length && <p class={s.allDone}>{tr('onb.list.allDone')}</p>}
      <div class={s.listFoot}>
        <Button variant="quiet" size="sm" onClick={() => updateOnboarding({ checklistHidden: true })}>{tr('onb.list.hide')}</Button>
        <span class={s.back}>{tr('onb.list.back')}</span>
      </div>
    </Card>
  );
}

const HINTS = ['onb.hint.1', 'onb.hint.2', 'onb.hint.3'] as const;
const ROLE_LINE: Record<string, Parameters<typeof tr>[0]> = {
  agent: 'onb.role.agent', lead: 'onb.role.lead', viewer: 'onb.role.viewer', admin: 'onb.role.admin',
};

/** Три подсказки нового оператора (вход Б): листаются, закрываются, один раз на устройстве. */
function Hints(): JSX.Element {
  const [index, setIndex] = useState(0);
  const role = bootstrap.value?.me.role ?? 'agent';
  const last = index === HINTS.length - 1;
  const finish = (): void => updateOnboarding({ hintsDone: true });
  return (
    <>
      <section class={s.hint} aria-labelledby="onb-hint" aria-live="polite">
        <div class={s.hintHead}>
          <span id="onb-hint" class={`${s.counter} num`}>{tr('onb.hint.counter', { n: index + 1, total: HINTS.length })}</span>
          <Button variant="quiet" size="sm" icon="close" label={tr('onb.hint.close')} onClick={finish} />
        </div>
        <p class={s.hintText}>{tr(HINTS[index]!, { keys: isMac ? '⌘K' : 'Ctrl+K' })}</p>
        <div class={s.hintActions}>
          <Button variant="primary" size="sm" onClick={() => (last ? finish() : setIndex(index + 1))}>{tr(last ? 'onb.hint.done' : 'onb.hint.next')}</Button>
        </div>
      </section>
      {ROLE_LINE[role] && <p class={s.role}>{tr(ROLE_LINE[role]!)}</p>}
    </>
  );
}

/**
 * Первый запуск (6.13) на «Сегодня»: вход А — «Добро пожаловать» при пустой
 * системе, затем чек-лист; вход Б — три подсказки и строка о роли.
 * `dialogs` — сколько диалогов в списке (пустая система — ни одного).
 */
export function TodayOnboarding({ dialogs }: { dialogs: number }): JSX.Element | null {
  const boot = bootstrap.value;
  const state = onboarding.value;
  if (!boot) return null;
  if (setsUp(boot.me)) {
    const facts = factsFrom(boot, { articles: null, people: null, colleagueSkipped: false, tutorial: false });
    if (!state.welcomeDone && isEmptySystem(facts, dialogs)) return <Welcome />;
    return state.checklistHidden ? null : <Checklist />;
  }
  return state.hintsDone ? null : <Hints />;
}

