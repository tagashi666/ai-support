/**
 * Строка живого списка словами: код причины с сервера → подпись словаря.
 * Сервер шлёт только код и время (src/shared/attention.ts), текст рисует панель.
 */
import type { InboxItem } from '@shared/api-types';
import type { ReasonCode } from '@shared/attention';
import { t } from '@/i18n/ru';
import { clock, listTime, roughDuration } from '@/lib/format/format';
import type { ReasonView, Tone } from '@/lib/labels';
import type { Channel } from '@/lib/types';

const TONE: Record<ReasonCode, Tone> = {
  handoff: 'attention',
  sla_overdue: 'attention',
  ai_silent: 'attention',
  draft_unsure: 'ai',
  draft_ready: 'ai',
  important: 'attention',
  urgent: 'attention',
  sla_soon: 'quiet',
  waiting: 'quiet',
  check: 'attention',
  ai_replying: 'quiet',
  ai_replied: 'quiet',
  waiting_client: 'quiet',
  window_closed: 'quiet',
  resolved: 'quiet',
};

/** Срочная причина: пилюля янтарная со значком ▲ (7.1 п.3). */
export const isUrgentCode = (code: ReasonCode): boolean =>
  code === 'handoff' || code === 'sla_overdue' || code === 'ai_silent' || code === 'check';

export function liveReasonView(item: InboxItem, now: number): ReasonView {
  if (item.section === 'colleagues' && item.owner) {
    return { text: t('reason.colleagueLeads', { name: item.owner.name }), tone: 'quiet' };
  }
  const { code, since } = item.reason;
  const waited = item.waiting_since !== null ? roughDuration(now - item.waiting_since) : null;
  const withWait = (text: string): string => (waited ? `${text} · ${t('reason.waitsFor', { for: waited })}` : text);
  const from = since ?? now;
  let text: string;
  switch (code) {
    case 'handoff': text = withWait(t('reason.handoff')); break;
    case 'sla_overdue': text = t('reason.slaOver', { ago: roughDuration(now - from) }); break;
    case 'ai_silent': text = withWait(t('reason.aiSilent')); break;
    case 'draft_unsure': text = t('reason.draftUnsure'); break;
    case 'draft_ready': text = withWait(t('reason.draftReady')); break;
    case 'important': text = withWait(t('reason.important')); break;
    case 'urgent': text = withWait(t('reason.urgent')); break;
    case 'sla_soon': text = t('reason.slaSoon', { left: roughDuration(Math.max(0, from - now)) }); break;
    case 'waiting': text = t('reason.waiting', { for: waited ?? '' }).trim(); break;
    case 'check': text = t('reason.check'); break;
    case 'ai_replying': text = t('reason.aiReplying'); break;
    case 'ai_replied': text = t('reason.aiReplied', { time: clock(from) }); break;
    case 'waiting_client': text = t('reason.waitingClient', { for: roughDuration(now - from) }); break;
    case 'window_closed': text = t('reason.windowClosed'); break;
    case 'resolved': text = t('reason.resolved', { when: listTime(from, now) }); break;
  }
  return { text, tone: TONE[code] };
}

/** Превью: «Помощник:», «Оператор:» перед текстом; вложение без подписи — словом. */
export function livePreview(item: InboxItem): { who?: string; text: string } {
  const last = item.last;
  if (!last) return { text: '' };
  const text = last.text || (last.kind !== 'text' ? t('preview.attachment') : '');
  switch (last.author) {
    case 'assistant': return { who: t('preview.assistant'), text };
    case 'operator': return { who: t('preview.operator'), text };
    case 'system': return { who: t('preview.system'), text };
    case 'client': return { text };
  }
}

export function liveName(item: InboxItem): string {
  return item.customer.name?.trim() || (item.customer.username ? `@${item.customer.username}` : t('live.noName', { id: item.id }));
}

const CHANNEL_OF_SOURCE: Record<string, Channel> = {
  telegram_bot: 'telegram',
  telegram_business: 'business',
  bedolaga: 'bedolaga',
  minishop: 'minishop',
};

export const liveChannel = (item: InboxItem): Channel | undefined =>
  item.source ? CHANNEL_OF_SOURCE[item.source.kind] : undefined;
