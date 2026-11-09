/**
 * Значения перечислений → слова словаря. Единственное место, где enum
 * превращается в подпись; на экран сырые значения не попадают.
 */
import type { ConfidenceLevel } from '@shared/confidence';
import { t, type Key } from '@/i18n/ru';
import { clock, roughDuration, listTime } from '@/lib/format/format';
import type { Channel, Reason, Section, Who } from '@/lib/types';

export const SECTION_ORDER: readonly Section[] = ['mine', 'colleagues', 'ai', 'client', 'done'];

const SECTION_KEY: Record<Section, Key> = {
  mine: 'section.mine',
  colleagues: 'section.colleagues',
  ai: 'section.ai',
  client: 'section.client',
  done: 'section.done',
};
export const sectionLabel = (section: Section): string => t(SECTION_KEY[section]);

const CHANNEL_KEY: Record<Channel, Key> = {
  telegram: 'channel.telegram',
  business: 'channel.business',
  bedolaga: 'channel.bedolaga',
  minishop: 'channel.minishop',
};
export const channelLabel = (channel: Channel): string => t(CHANNEL_KEY[channel]);

const LEVEL_KEY: Record<ConfidenceLevel, Key> = {
  sure: 'draft.sure',
  check: 'draft.check',
  unsure: 'draft.unsure',
};
export const levelLabel = (level: ConfidenceLevel): string => t(LEVEL_KEY[level]);

/** Тон причины: янтарный — только «нужно вам», фиолетовый — помощник. */
export type Tone = 'attention' | 'ai' | 'quiet';

export interface ReasonView {
  text: string;
  tone: Tone;
}

/** Причина в строке списка (7.1): одна, словами, со временем ожидания. */
export function reasonView(reason: Reason, now: number, waitingSince?: number): ReasonView {
  const waited = waitingSince !== undefined ? roughDuration(now - waitingSince) : null;
  const withWait = (text: string): string =>
    waited ? `${text} · ${t('reason.waitsFor', { for: waited })}` : text;
  switch (reason.kind) {
    case 'asksHuman': return { text: withWait(t('reason.asksHuman')), tone: 'attention' };
    case 'handedOver': return { text: t('reason.handedOver', { topic: reason.topic }), tone: 'attention' };
    case 'slaOver': return { text: t('reason.slaOver', { ago: roughDuration(now - reason.since) }), tone: 'attention' };
    case 'aiSilent': return { text: withWait(t('reason.aiSilent')), tone: 'attention' };
    case 'draftUnsure': return { text: t('reason.draftUnsure'), tone: 'ai' };
    case 'draftReady': return { text: withWait(t('reason.draftReady')), tone: 'ai' };
    case 'important': return { text: t('reason.important'), tone: 'attention' };
    case 'slaSoon': return { text: t('reason.slaSoon', { left: roughDuration(reason.due - now) }), tone: 'quiet' };
    case 'waiting': return { text: t('reason.waiting', { for: waited ?? '' }), tone: 'quiet' };
    case 'aiReplying': return { text: t('reason.aiReplying'), tone: 'quiet' };
    case 'aiReplied': return { text: t('reason.aiReplied', { time: clock(reason.at) }), tone: 'quiet' };
    case 'colleagueLeads': return { text: t('reason.colleagueLeads', { name: reason.name }), tone: 'quiet' };
    case 'waitingClient': return { text: t('reason.waitingClient', { for: waited ?? '' }), tone: 'quiet' };
    case 'windowClosed': return { text: t('reason.windowClosed'), tone: 'quiet' };
    case 'resolved': return { text: t('reason.resolved', { when: listTime(reason.at, now) }), tone: 'quiet' };
  }
}

/** Приоритет причины в «Ждут вас» (7.1): меньше — выше. */
export function reasonTier(reason: Reason): number {
  switch (reason.kind) {
    case 'asksHuman':
    case 'handedOver': return 1;
    case 'slaOver': return 2;
    case 'aiSilent': return 3;
    case 'draftUnsure':
    case 'draftReady': return 4;
    case 'important': return 5;
    case 'slaSoon': return 6;
    default: return 7;
  }
}

/** Срочная причина: пилюля становится янтарной, и приходит тост. */
export const isUrgent = (reason: Reason): boolean => reasonTier(reason) <= 3;

export interface ChipView {
  text: string;
  lead: 'spark' | 'pause' | 'dot';
  tone: 'ai' | 'attention' | 'you' | 'quiet';
  /** Есть ли лист по нажатию на чип. */
  menu: boolean;
  /** Главная кнопка рядом с чипом. */
  primary: 'take' | 'giveBack' | 'resume' | 'intercept' | 'reopen' | null;
}

/** Чип «кто отвечает» и главная кнопка (таблица 6.3.1). */
export function chipView(who: Who, typing: boolean): ChipView {
  if (typing && who.kind !== 'colleague' && who.kind !== 'resolved' && who.kind !== 'youLead') {
    return { text: t('who.youTyping'), tone: 'you', lead: 'dot', menu: false, primary: null };
  }
  switch (who.kind) {
    case 'aiAuto': return { text: t('who.aiAuto'), tone: 'ai', lead: 'spark', menu: true, primary: 'take' };
    case 'aiSuggest': return { text: t('who.aiSuggest'), tone: 'ai', lead: 'spark', menu: true, primary: null };
    case 'aiWatch': return { text: t('who.aiWatch'), tone: 'quiet', lead: 'spark', menu: true, primary: null };
    case 'aiOffHere': return { text: t('who.aiOffHere'), tone: 'quiet', lead: 'dot', menu: true, primary: null };
    case 'paused': return { text: t('who.paused', { time: clock(who.until) }), tone: 'attention', lead: 'pause', menu: true, primary: 'resume' };
    case 'handed': return { text: t('who.handed', { topic: who.topic }), tone: 'attention', lead: 'dot', menu: true, primary: 'take' };
    case 'youLead': return { text: t('who.youLead'), tone: 'you', lead: 'dot', menu: true, primary: 'giveBack' };
    case 'colleague': return {
      text: t('who.colleague', { name: who.name, time: clock(who.until) }), tone: 'quiet', lead: 'dot', menu: false, primary: 'intercept',
    };
    case 'resolved': return { text: t('who.resolved'), tone: 'quiet', lead: 'dot', menu: false, primary: 'reopen' };
  }
}
