/**
 * Совместная работа на кадрах сокета (план, 6.3.7 и 10.6 п.6, п.8):
 * присутствие во всех диалогах (мини-аватар «Мария смотрит» в списке и
 * строка в шапке), просьба передать диалог тому, кто ведёт, — тостом с
 * «Передать». До кадра присутствие обновляется ответом своего heartbeat.
 */
import { signal } from '@preact/signals';
import type { PresenceResponse, TeamNamesResponse, ThreadFrame, ThreadPresence } from '@shared/api-types';
import { t } from '@/i18n/ru';
import { dismissToast, showToast } from '@/lib/actions/toasts';
import { getJson, readToken } from '@/lib/live/api';

/** Присутствие старше — уже не «смотрит» (как collaboration на сервере). */
export const PRESENCE_FRESH_MS = 90_000;

export const presence = signal<ReadonlyMap<number, ThreadPresence[]>>(new Map());

export function setPresence(id: number, list: ThreadPresence[]): void {
  const next = new Map(presence.peek());
  if (list.length) next.set(id, list); else next.delete(id);
  presence.value = next;
}

/** Коллеги в диалоге сейчас: без вас и без устаревших отметок; печатающие первыми. */
export function colleaguesIn(list: readonly ThreadPresence[] | undefined, me: string, at: number): ThreadPresence[] {
  return (list ?? []).filter((entry) => entry.id !== me && at - entry.at < PRESENCE_FRESH_MS)
    .sort((a, b) => (a.state === b.state ? b.at - a.at : a.state === 'typing' ? -1 : 1));
}

export async function loadPresence(): Promise<void> {
  try {
    const response = await getJson<PresenceResponse>('/api/presence', readToken() ?? '');
    presence.value = new Map(response.items.map((item) => [item.conversation_id, item.presence]));
  } catch { /* без присутствия список работает как раньше */ }
}

/** Имена команды для всех с conversation:read (10.6 п.4): фильтр «Ответственный: Мария», чек-лист запуска. */
export const teamNames = signal<TeamNamesResponse['people'] | null>(null);
let namesAt = 0;
export async function loadTeamNames(force = false): Promise<TeamNamesResponse['people'] | null> {
  if (!force && teamNames.peek() && Date.now() - namesAt < 60_000) return teamNames.peek();
  try {
    teamNames.value = (await getJson<TeamNamesResponse>('/api/team/names', readToken() ?? '')).people;
    namesAt = Date.now();
  } catch { /* без имён фильтр — только «Все / Я / Никто» */ }
  return teamNames.peek();
}

/** Обработчики, которые знают о действиях и черновиках (их ставит actions.ts — без циклического импорта). */
interface CollabHooks {
  draft(id: number, frame: Extract<ThreadFrame, { kind: 'draft' }>): void;
  release(id: number): Promise<boolean>;
  intent(id: number, frame: Extract<ThreadFrame, { kind: 'intent' }>): void;
}
let hooks: CollabHooks | null = null;
export function setCollabHooks(next: CollabHooks): void { hooks = next; }

/** Кадр ленты, который не про ленту: присутствие, черновик, просьба передать. */
export function onCollabFrame(frame: ThreadFrame): void {
  if (frame.kind === 'presence') setPresence(frame.conversation_id, frame.presence);
  else if (frame.kind === 'draft') hooks?.draft(frame.conversation_id, frame);
  else if (frame.kind === 'intent') hooks?.intent(frame.conversation_id, frame);
  else if (frame.kind === 'handover_request') {
    const id = frame.conversation_id;
    let toastId = 0;
    toastId = showToast({
      text: t('handover.asked', { name: frame.from.name, customer: frame.customer ?? t('handover.customer') }),
      ttl: null,
      action: { label: t('handover.give'), run: () => {
        dismissToast(toastId);
        void hooks?.release(id).then((ok) => { if (ok) showToast({ text: t('handover.given', { name: frame.from.name }) }); });
      } },
    });
  }
}
