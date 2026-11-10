import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { tr } from '@/i18n/sections/onboarding';
import { showToast, undoToast } from '@/lib/actions/toasts';
import { clock } from '@/lib/format/format';
import { tabArrows } from '@/lib/keys';
import { onboarding, updateOnboarding } from '@/lib/onboarding';
import { navigate } from '@/lib/router';
import { Avatar } from '@/ui/Avatar';
import { Bubble } from '@/ui/Bubble';
import { Button } from '@/ui/Button';
import { tutorialReducer, type TutorialEvent, type TutorialState, initialTutorial } from './tutorialModel';
import s from './onboarding.module.css';

const TASKS = ['onb.tut.task1', 'onb.tut.task2', 'onb.tut.task3', 'onb.tut.task4', 'onb.tut.task5'] as const;

/**
 * Учебный диалог «Анна Пример · учебный» (6.13 В): целиком в браузере —
 * набор данных в коде, никаких запросов к серверу и каналам, ни в одном
 * счётчике. Пять заданий: отправить черновик, поправить и отправить,
 * заметка, «Решено», отменить решение. Отметки заданий — на устройстве.
 */
export function TutorialThread(): JSX.Element {
  const [state, setState] = useState<TutorialState>(() => initialTutorial(Date.now()));
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const done = new Set(onboarding.value.tutorialTasks ?? []);

  useEffect(() => { if (onboarding.peek().tutorialSeenAt === undefined) updateOnboarding({ tutorialSeenAt: Date.now() }); }, []);

  // Тост «Отменить» срабатывает позже — ход берётся из ссылки, а не из замыкания.
  const current = useRef(state);
  current.current = state;
  const run = (event: TutorialEvent): void => {
    const result = tutorialReducer(current.current, event, Date.now());
    current.current = result.state;
    setState(result.state);
    const known = new Set(onboarding.peek().tutorialTasks ?? []);
    if (result.task !== null && !known.has(result.task)) updateOnboarding({ tutorialTasks: [...known, result.task].sort() });
  };

  const send = (): void => {
    const body = text.trim();
    if (!body) return;
    if (mode === 'note') {
      run({ type: 'note', text: body });
      showToast({ text: tr('onb.tut.noteSaved') });
    } else {
      run({ type: 'send', text: body });
      showToast({ text: tr('onb.tut.sent') });
    }
    setText('');
  };

  const resolve = (): void => {
    run({ type: 'resolve' });
    undoToast(tr('onb.tut.resolved'), () => { run({ type: 'reopen' }); showToast({ text: tr('onb.tut.reopened') }); }, tr('onb.tut.undo'));
  };

  const count = done.size;
  return (
    <div class={s.tutorial}>
      <header class={s.tutHead}>
        <Button variant="quiet" size="sm" icon="back" label={tr('onb.tut.back')} onClick={() => navigate({ name: 'chats', id: null })} />
        <Avatar name={tr('onb.tut.client')} channel="telegram" />
        <h1 class={s.tutTitle}>{tr('onb.tut.name')}</h1>
        {!state.resolved && <Button variant="secondary" size="sm" icon="check" onClick={resolve}>{tr('onb.tut.resolve')}</Button>}
      </header>
      <p class={s.tutBanner}>{tr('onb.tut.banner')}</p>
      <section class={s.tasks} aria-labelledby="tut-tasks">
        <h2 id="tut-tasks" class={s.tasksTitle}>{tr('onb.tut.tasks')} · <span class="num">{tr('onb.tut.progress', { n: count })}</span></h2>
        <ol class={s.taskList}>
          {TASKS.map((key, index) => (
            <li key={key} data-done={done.has(index + 1) ? 'true' : 'false'}>
              <span aria-hidden="true">{done.has(index + 1) ? '✓' : '○'}</span> {tr(key)}
            </li>
          ))}
        </ol>
        {count === TASKS.length && <p class={s.allDone}>{tr('onb.tut.allDone')}</p>}
      </section>
      <div class={s.tutFeed} role="log" aria-label={tr('onb.tut.name')}>
        {state.messages.map((message) => (
          message.voice === 'note' ? (
            <p key={message.id} class={s.tutNote}><b>{tr('onb.tut.noteLabel')}</b> · {message.text}</p>
          ) : (
            <Bubble key={message.id} voice={message.voice === 'client' ? 'client' : 'you'}
              label={message.voice === 'client' ? tr('onb.tut.client') : tr('onb.tut.you')}
              meta={<span class="num">{clock(message.at)}{message.edited ? ` · ${tr('onb.tut.edited')}` : ''}</span>}
              a11y={`${message.voice === 'client' ? tr('onb.tut.client') : tr('onb.tut.you')}, ${clock(message.at)}: ${message.text}`}>
              {message.text}
            </Bubble>
          )
        ))}
        {state.resolved && <p class={s.tutNote}>{tr('onb.tut.isResolved')}</p>}
      </div>
      {state.draft !== null && !state.resolved && (
        <section class={s.tutDraft} aria-labelledby="tut-draft">
          <h2 id="tut-draft" class={s.tasksTitle}>{tr('onb.tut.draftTitle')}</h2>
          <p>{state.draft}</p>
          <div class={s.hintActions}>
            <Button variant="primary" size="sm" onClick={() => { run({ type: 'sendDraft' }); showToast({ text: tr('onb.tut.sent') }); }}>{tr('onb.tut.send')}</Button>
            <Button variant="secondary" size="sm" onClick={() => {
              setText(state.draft ?? ''); setMode('reply'); run({ type: 'edit' });
              requestAnimationFrame(() => area.current?.focus());
            }}>{tr('onb.tut.edit')}</Button>
          </div>
        </section>
      )}
      {!state.resolved && (
        <div class={s.tutComposer}>
          <div class={s.tutModes} role="tablist" aria-label={tr('onb.tut.modes')} onKeyDown={tabArrows}>
            <button type="button" role="tab" aria-selected={mode === 'reply'} tabIndex={mode === 'reply' ? 0 : -1} onClick={() => setMode('reply')}>{tr('onb.tut.reply')}</button>
            <button type="button" role="tab" aria-selected={mode === 'note'} tabIndex={mode === 'note' ? 0 : -1} onClick={() => setMode('note')}>{tr('onb.tut.note')}</button>
          </div>
          <textarea ref={area} rows={3} value={text} aria-label={tr(mode === 'note' ? 'onb.tut.placeholderNote' : 'onb.tut.placeholderReply')}
            placeholder={tr(mode === 'note' ? 'onb.tut.placeholderNote' : 'onb.tut.placeholderReply')}
            onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); } }} />
          <Button variant="primary" size="sm" disabled={!text.trim()} onClick={send}>{tr(mode === 'note' ? 'onb.tut.submitNote' : 'onb.tut.submit')}</Button>
        </div>
      )}
      <div class={s.tutFoot}>
        <Button variant="quiet" size="sm" onClick={() => {
          const fresh = initialTutorial(Date.now());
          current.current = fresh; setState(fresh); setText(''); updateOnboarding({ tutorialTasks: [] });
        }}>{tr('onb.tut.restart')}</Button>
        <Button variant="quiet" size="sm" onClick={() => { updateOnboarding({ tutorialClosed: true }); navigate({ name: 'chats', id: null }); }}>{tr('onb.tut.close')}</Button>
      </div>
    </div>
  );
}
