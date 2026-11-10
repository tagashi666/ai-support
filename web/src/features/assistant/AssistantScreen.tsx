import type { JSX } from 'preact';
import { usePresence } from '@/ui/motion';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t, type Key } from '@/i18n/ru';
import { clock } from '@/lib/format/format';
import { MODE_LABEL, SETTING_LABEL, valueWords } from '@/lib/assistant/model';
import { can, changedBy, loadSettings, offline, revertConflicts, revertLast, revertMemo, settings, settingsState } from '@/lib/assistant/store';
import { commit, dirty, dirtyLines, discard, saveError, saving } from '@/lib/assistant/draft';
import { bootstrap } from '@/lib/live/store';
import { navigate } from '@/lib/router';
import { Button } from '@/ui/Button';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import { Tabs } from '@/ui/Tabs';
import type { AiMode } from '@shared/attention';
import { ActivityPanel } from './ActivityPanel';
import { AnswersPanel } from './AnswersPanel';
import { ExpertPanel } from './ExpertPanel';
import { TryPanel } from './TryPanel';
import { VoicePanel } from './VoicePanel';
import a from './assistant.module.css';

type Tab = 'answers' | 'activity' | 'try' | 'voice' | 'expert';
const SUB: Record<Tab, string | undefined> = { answers: undefined, activity: 'activity', try: 'try', voice: 'voice', expert: 'expert' };
const LABEL: Record<Tab, Key> = {
  answers: 'assistant.tab.answers', activity: 'assistant.tab.activity', try: 'assistant.tab.try', voice: 'assistant.tab.voice', expert: 'assistant.tab.expert',
};

/** Какие подразделы видит этот человек (6.7, состояния): без права подраздела нет. */
function tabsFor(): Tab[] {
  const tabs: Tab[] = [];
  if (can('settings:read')) tabs.push('answers');
  if (can('stats:read')) tabs.push('activity');
  if (can('settings:ai_tools')) tabs.push('try');
  if (can('settings:read')) tabs.push('voice', 'expert');
  return tabs;
}

/**
 * «Применено в 14:05: Отвечает сам → Подсказывает · Вернуть как было» —
 * сутки после изменения, здесь и на «Сегодня» (6.7). Если ключи с тех пор
 * менял кто-то ещё — сначала вопрос.
 */
export function RevertLine(): JSX.Element | null {
  const memo = revertMemo.value;
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!memo || offline.value) return null;
  const keys = Object.keys(memo.before) as Array<keyof typeof memo.before>;
  const what = keys.length === 1 && keys[0] === 'aiMode'
    ? `${t(MODE_LABEL[memo.before.aiMode as AiMode])} → ${t(MODE_LABEL[memo.after.aiMode as AiMode])}`
    : keys.map((key) => `${t(SETTING_LABEL[key])}: ${valueWords(key, memo.before[key], t)} → ${valueWords(key, memo.after[key], t)}`).join('; ');
  const run = async (force: boolean): Promise<void> => {
    setError(null);
    if (!force && (await revertConflicts()).length) { setConflict(true); return; }
    setConflict(false);
    const result = await revertLast();
    if (!result.ok) setError(result.error);
  };
  return (
    <div class={a.revert} role="status">
      <span>{t('assistant.applied', { time: clock(memo.at), what })}</span>
      <Button variant="link" size="sm" onClick={() => void run(false)}>{t('assistant.revert')}</Button>
      {error && <span class={a.error} role="alert">{error}</span>}
      <Sheet open={conflict} onClose={() => setConflict(false)} title={t('assistant.revert')}>
        <p class={sheetStyles.text}>{t('assistant.revertConflict')}</p>
        <div class={sheetStyles.actions}>
          <Button variant="quiet" onClick={() => setConflict(false)}>{t('assistant.sheet.cancel')}</Button>
          <Button variant="primary" onClick={() => void run(true)}>{t('assistant.revertAnyway')}</Button>
        </div>
      </Sheet>
    </div>
  );
}

/** Полоса «Изменено: 2 · было → станет · Отменить · Сохранить» (6.7, правило 1). */
function ChangeBar(): JSX.Element | null {
  // Полоса входит снизу и уходит (R2 C); пока уходит — с прежним текстом.
  const n = dirty.value.length;
  const { mounted, closing } = usePresence(n > 0);
  const last = useRef({ n, lines: dirtyLines.value });
  if (n) last.current = { n, lines: dirtyLines.value };
  if (!mounted) return null;
  return (
    <div class={a.changeBar} role="region" aria-label={t('assistant.changed', { n: last.current.n })}
      data-state={closing ? 'closing' : undefined} inert={closing || undefined}>
      <div class={a.changeText}>
        <strong class="num">{t('assistant.changed', { n: last.current.n })}</strong>
        <span>{last.current.lines.join(' · ')}</span>
        {saveError.value && <span class={a.error} role="alert">{saveError.value}</span>}
      </div>
      <div class={a.actions}>
        <Button variant="quiet" onClick={discard}>{t('assistant.discard')}</Button>
        <Button variant="primary" disabled={saving.value || offline.value} onClick={() => void commit()}>{t('assistant.save')}</Button>
      </div>
    </div>
  );
}

export function AssistantScreen({ sub }: { sub?: string }): JSX.Element {
  const tabs = tabsFor();
  const asked = (Object.keys(SUB) as Tab[]).find((tab) => SUB[tab] === sub) ?? 'answers';
  const tab: Tab | undefined = tabs.includes(asked) ? asked : tabs[0];
  const ready = bootstrap.value !== null;
  // Права приходят с bootstrap: до него не знаем, можно ли читать настройки.
  useEffect(() => { if (ready) void loadSettings(); }, [ready]);
  const by = changedBy.value;
  const needsSettings = tab === 'answers' || tab === 'voice' || tab === 'expert';
  return (
    <div class={a.screen}>
      <div class={a.inner}>
        <h1 class={a.title}>{t('nav.assistant')}</h1>
        {!ready ? <div class={a.skeleton} key="skeleton" aria-hidden="true" /> : tabs.length === 0 ? <p class={a.muted}>{t('assistant.noAccess')}</p> : (
          <>
            <div class={a.tabsScroll}>
              <Tabs<Tab> label={t('nav.assistant')} value={tab ?? 'answers'}
                onChange={(next) => navigate({ name: 'section', key: 'assistant', ...(SUB[next] ? { sub: SUB[next] } : {}) }, true)}
                items={tabs.map((value) => ({ value, label: t(LABEL[value]) }))} />
            </div>
            <RevertLine />
            {by && <p class={a.muted} role="status">{t('assistant.changedBy', { name: by.name, time: clock(by.at) })}</p>}
            {offline.value && <p class={a.muted}>{t('assistant.offlineAll')}</p>}
            {needsSettings && settingsState.value === 'loading' && !settings.value && <div class={a.skeleton} key="skeleton" aria-hidden="true" />}
            {needsSettings && settingsState.value === 'error' && (
              <p class={a.error} role="alert">{t('assistant.loadFailed')} <Button variant="link" size="sm" onClick={() => void loadSettings()}>{t('live.retry')}</Button></p>
            )}
            {tab === 'answers' && <AnswersPanel />}
            {tab === 'activity' && <ActivityPanel />}
            {tab === 'try' && <TryPanel />}
            {tab === 'voice' && settings.value && <VoicePanel />}
            {tab === 'expert' && settings.value && <ExpertPanel />}
          </>
        )}
      </div>
      <ChangeBar />
    </div>
  );
}
