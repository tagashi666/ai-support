/**
 * Чип «кто отвечает» и главная кнопка (план, 6.3.1) из строки списка с
 * сервера. Единственное место, где видны режим помощника в диалоге,
 * передача человеку, пауза и то, кто ведёт диалог.
 */
import type { InboxItem } from '@shared/api-types';
import type { AiMode } from '@shared/attention';
import { t } from '@/i18n/ru';
import { clock } from '@/lib/format/format';

export type WhoKind =
  | 'resolved' | 'colleague' | 'youLead' | 'typing' | 'notConfigured' | 'offEverywhere'
  | 'handed' | 'humanHold' | 'aiAuto' | 'aiSuggest' | 'aiWatch' | 'aiOffHere';

export type Primary = 'take' | 'return' | 'reopen' | 'takeover' | 'askHandover' | null;

export interface WhoView {
  kind: WhoKind;
  text: string;
  tone: 'ai' | 'attention' | 'you' | 'quiet';
  lead: 'spark' | 'pause' | 'dot';
  /** Лист по нажатию на чип есть. */
  menu: boolean;
  primary: Primary;
  /** «Вёл: Мария» — ответственный после конца закрепления. */
  ledBy: string | null;
}

export interface WhoInput {
  item: Pick<InboxItem, 'status' | 'owner' | 'assignee' | 'ai' | 'flags'>;
  me: string;
  permissions: ReadonlySet<string>;
  assistant: { mode: AiMode; keys: boolean };
  /** В поле ответа есть ваш текст. */
  typing: boolean;
}

const done = (status: string): boolean => status === 'resolved' || status === 'closed';

export function whoView({ item, me, permissions, assistant, typing }: WhoInput): WhoView {
  const canStatus = permissions.has('conversation:status');
  const base = (view: Omit<WhoView, 'ledBy' | 'menu'> & { menu?: boolean }): WhoView => ({
    ...view,
    menu: (view.menu ?? true) && canStatus,
    ledBy: item.assignee && !item.owner && item.assignee.id !== me && !done(item.status) ? item.assignee.name : null,
  });
  if (done(item.status)) {
    return base({ kind: 'resolved', text: t('who.resolved'), tone: 'quiet', lead: 'dot', menu: false, primary: canStatus ? 'reopen' : null });
  }
  if (item.owner && item.owner.id !== me) {
    const primary: Primary = permissions.has('conversation:assign') ? 'takeover'
      : permissions.has('conversation:notes') ? 'askHandover' : null;
    return base({
      kind: 'colleague', text: t('who.colleague', { name: item.owner.name, time: clock(item.owner.until) }),
      tone: 'quiet', lead: 'dot', menu: false, primary,
    });
  }
  const aiAvailable = assistant.keys && assistant.mode !== 'off';
  if (item.owner && item.owner.id === me) {
    return base({ kind: 'youLead', text: t('who.youLead'), tone: 'you', lead: 'dot', primary: aiAvailable && canStatus ? 'return' : null });
  }
  if (typing) return base({ kind: 'typing', text: t('who.youTyping'), tone: 'you', lead: 'dot', menu: false, primary: null });
  if (!assistant.keys) return base({ kind: 'notConfigured', text: t('who.notConfigured'), tone: 'quiet', lead: 'dot', menu: false, primary: canStatus ? 'take' : null });
  if (assistant.mode === 'off') {
    return base({ kind: 'offEverywhere', text: t('who.offEverywhere'), tone: 'quiet', lead: 'dot', menu: false, primary: canStatus ? 'take' : null });
  }
  if (item.flags.handoff) {
    return base({ kind: 'handed', text: t('who.handedLive'), tone: 'attention', lead: 'dot', primary: canStatus ? 'take' : null });
  }
  if (item.ai.paused_reason === 'human_hold' && item.ai.resume_at) {
    return base({ kind: 'humanHold', text: t('who.humanHold', { time: clock(item.ai.resume_at) }), tone: 'attention', lead: 'pause', primary: null });
  }
  switch (item.ai.effective) {
    case 'auto': return base({ kind: 'aiAuto', text: t('who.aiAuto'), tone: 'ai', lead: 'spark', primary: canStatus ? 'take' : null });
    case 'suggest': return base({ kind: 'aiSuggest', text: t('who.aiSuggest'), tone: 'ai', lead: 'spark', primary: null });
    case 'shadow': return base({ kind: 'aiWatch', text: t('who.aiWatch'), tone: 'quiet', lead: 'spark', primary: null });
    case 'off': return base({ kind: 'aiOffHere', text: t('who.aiOffHere'), tone: 'quiet', lead: 'dot', primary: null });
  }
}

/** Режим помощника в этом диалоге: что отмечено в листе чипа. */
export type HereMode = 'inherit' | 'off' | 'shadow' | 'suggest' | 'auto';

export function hereMode(configured: string): HereMode {
  return configured === 'off' || configured === 'shadow' || configured === 'suggest' || configured === 'auto' ? configured : 'inherit';
}

/** Смелее, чем сейчас: включение «Отвечает сам» — ярус 3, лист «было → станет» (7.6). */
export const isBolder = (next: HereMode, effective: AiMode, global: AiMode): boolean =>
  (next === 'auto' || (next === 'inherit' && global === 'auto')) && effective !== 'auto';
