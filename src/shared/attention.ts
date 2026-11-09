/**
 * Состояние внимания диалога (план редизайна, 7.1): кто сейчас должен
 * действовать, почему, и в какой секции списка стоит строка.
 *
 * Сервер считает это на лету из фактов о диалоге и в базе не хранит:
 * состояние зависит от общего режима помощника, от времени (3 минуты
 * молчания помощника, сроки ответа, пауза после ответа человека, конец
 * закрепления) и от того, кто смотрит. Хранимый столбец устаревал бы без
 * записи в строку.
 *
 * Чистый TypeScript без импортов окружения: один и тот же код работает в
 * сервере (src/core/attention.ts) и в новой панели (web/).
 */

export type AttentionState = 'needs_human' | 'ai_handling' | 'waiting_client' | 'done';
/** Секция для конкретного получателя: зависит от живого закрепления и от того, кто смотрит. */
export type Section = 'mine' | 'colleagues' | 'ai' | 'client' | 'done';
export type AiMode = 'off' | 'shadow' | 'suggest' | 'auto';

/**
 * Код причины. Текст рисует словарь панели (раздел 9); сервер шлёт только код
 * и время, от которого причина отсчитывается.
 */
export type ReasonCode =
  // «Ждут вас» / «Ведут коллеги» — по приоритету (7.1, таблица причин)
  | 'handoff'         // 1. передан человеку
  | 'sla_overdue'     // 2. срок ответа вышел (since = срок)
  | 'ai_silent'       // 3. помощник не ответил за 3 мин
  | 'draft_unsure'    // 4. черновик, помощник не уверен
  | 'draft_ready'     // 4. черновик готов
  | 'important'       // 5. отмечено важным
  | 'urgent'          // 5. заявка высокой срочности
  | 'sla_soon'        // 6. срок ответа скоро (since = срок)
  | 'waiting'         // 7. ждёт ответа
  | 'check'           // сервер не смог определить состояние
  // остальные секции
  | 'ai_replying'
  | 'ai_replied'
  | 'waiting_client'
  | 'window_closed'
  | 'resolved';

export interface Reason {
  code: ReasonCode;
  /** Момент, от которого считается причина (мс); для сроков — сам срок. */
  since: number | null;
}

/** Помощник молчит дольше — диалог уходит человеку с причиной «Помощник не ответил». */
export const AI_SILENT_MS = 3 * 60_000;
/** Живое закрепление диалога за оператором (operations.claim). */
export const CLAIM_LEASE_MS = 15 * 60_000;
/** «Срок ответа скоро» — когда осталось меньше этой доли срока. */
export const SLA_SOON_SHARE = 0.25;

/** Факты о диалоге, из которых считается состояние. Их собирает сервер одним запросом. */
export interface AttentionFacts {
  id: number;
  status: string;
  priority: string;
  escalated: boolean;
  /** Режим помощника в самом диалоге: inherit | off | shadow | suggest | auto. */
  aiMode: string;
  handoffAt: number | null;
  createdAt: number;
  lastMessageAt: number | null;
  resolvedAt: number | null;
  lastResolvedAt: number | null;
  /**
   * Первое живое входящее клиента после последнего исходящего и после
   * последнего закрытия. null — клиент ответа не ждёт.
   */
  inboundWaitingSince: number | null;
  /** Последнее исходящее любого автора. */
  lastOut: { at: number; author: string } | null;
  /** Последний ответ человека (author = agent). */
  lastAgentOutAt: number | null;
  /** Живой черновик помощника; unsure — подпись уверенности не «Уверен». */
  draft: { createdAt: number; unsure: boolean } | null;
  /** Конец паузы помощника после ответа человека; null — паузы нет. */
  holdUntil: number | null;
  /** Когда закрывается окно ответа канала; null — у канала окна нет. */
  windowClosesAt: number | null;
  /** Срок первого ответа по приоритету (sla_policy), минуты. */
  slaMinutes: number | null;
}

export interface AttentionContext {
  now: number;
  /** Общий режим помощника (runtime.aiMode). `off` гасит помощника везде. */
  globalAiMode: AiMode;
  /**
   * Пауза помощника везде (10.4 п.1): клиентам сам не отвечает, поэтому
   * ответа от него не ждём. until — конец паузы, null — «пока не включу».
   */
  paused?: { until: number | null } | null;
}

export interface AttentionAi {
  configured: string;
  effective: AiMode;
  /** pause — пауза помощника везде (10.4 п.1). */
  paused_reason: 'handoff' | 'human_hold' | 'pause' | null;
  resume_at: number | null;
}

export interface Attention {
  state: AttentionState;
  tier: 0 | 1;
  reason: Reason;
  waiting_since: number | null;
  sla: { due_at: number; overdue: boolean } | null;
  ai: AttentionAi;
  /** Передача человеку ещё не отвечена. */
  handoff: boolean;
}

const AI_MODES: readonly string[] = ['off', 'shadow', 'suggest', 'auto'];

/** Как resolveMode в src/ai/gate.ts: общий `off` — рубильник, иначе режим диалога сильнее общего. */
export function effectiveAiMode(own: string, global: AiMode): AiMode {
  if (global === 'off') return 'off';
  return AI_MODES.includes(own) ? (own as AiMode) : global;
}

export const isDone = (status: string): boolean => status === 'resolved' || status === 'closed';
const isUrgentPriority = (priority: string): boolean => priority === 'high' || priority === 'urgent';

/** Время активности для секций «новые сверху». */
export const activityAt = (facts: Pick<AttentionFacts, 'lastMessageAt' | 'createdAt'>): number =>
  facts.lastMessageAt ?? facts.createdAt;

/** Время решения для секции «Решённые» (то же выражение, что DONE_AT_SQL на сервере). */
export const doneAt = (facts: Pick<AttentionFacts, 'resolvedAt' | 'lastResolvedAt' | 'lastMessageAt' | 'createdAt'>): number =>
  facts.resolvedAt ?? facts.lastResolvedAt ?? facts.lastMessageAt ?? facts.createdAt;

/**
 * Состояние, ярус и причина. Не зависит от получателя: секцию досчитывает
 * sectionFor() для каждого, кто смотрит.
 */
export function computeAttention(facts: AttentionFacts, ctx: AttentionContext): Attention {
  const { now } = ctx;
  const effective = effectiveAiMode(facts.aiMode, ctx.globalAiMode);
  const handoff = facts.handoffAt !== null
    && (facts.lastAgentOutAt === null || facts.lastAgentOutAt <= facts.handoffAt);
  const holdActive = facts.holdUntil !== null && facts.holdUntil > now;
  const paused = effective !== 'off' && Boolean(ctx.paused);
  const ai: AttentionAi = {
    configured: facts.aiMode,
    effective,
    paused_reason: handoff ? 'handoff' : holdActive ? 'human_hold' : paused ? 'pause' : null,
    resume_at: handoff ? null : holdActive ? facts.holdUntil : paused ? ctx.paused?.until ?? null : null,
  };
  const base = { ai, handoff, sla: null, waiting_since: null } as const;

  if (isDone(facts.status)) {
    return { ...base, state: 'done', tier: 0, reason: { code: 'resolved', since: doneAt(facts) } };
  }

  const waitingSince = handoff
    ? Math.min(facts.handoffAt ?? now, facts.inboundWaitingSince ?? Number.POSITIVE_INFINITY)
    : facts.inboundWaitingSince;

  if (waitingSince === null) {
    // Клиент ответа не ждёт: последним писал человек или помощник.
    if (facts.lastOut && facts.lastOut.author !== 'agent') {
      return { ...base, state: 'ai_handling', tier: 0, reason: { code: 'ai_replied', since: facts.lastOut.at } };
    }
    return { ...base, state: 'waiting_client', tier: 0, reason: { code: 'waiting_client', since: facts.lastOut?.at ?? activityAt(facts) } };
  }

  // Ответить в канале уже нельзя (окно Telegram 24 ч): человеку здесь делать нечего,
  // иначе такие диалоги навсегда заняли бы «Ждут вас».
  if (facts.windowClosesAt !== null && facts.windowClosesAt <= now) {
    return { ...base, state: 'waiting_client', tier: 0, waiting_since: waitingSince,
      reason: { code: 'window_closed', since: facts.windowClosesAt } };
  }

  const waited = now - waitingSince;
  const aiExpected = effective === 'auto' && !holdActive && !handoff && !paused;
  const silent = aiExpected && facts.draft === null && waited >= AI_SILENT_MS;
  const needsHuman = handoff || facts.draft !== null || !aiExpected || facts.escalated || silent;

  if (!needsHuman) {
    return { ...base, state: 'ai_handling', tier: 0, waiting_since: waitingSince,
      reason: { code: 'ai_replying', since: waitingSince } };
  }

  const tier: 0 | 1 = handoff || facts.escalated || isUrgentPriority(facts.priority) ? 0 : 1;
  const slaMs = facts.slaMinutes !== null && facts.slaMinutes > 0 ? facts.slaMinutes * 60_000 : null;
  const dueAt = slaMs !== null ? waitingSince + slaMs : null;
  const sla = dueAt !== null ? { due_at: dueAt, overdue: dueAt <= now } : null;

  let reason: Reason;
  if (handoff) reason = { code: 'handoff', since: facts.handoffAt };
  else if (sla?.overdue) reason = { code: 'sla_overdue', since: sla.due_at };
  else if (silent) reason = { code: 'ai_silent', since: waitingSince + AI_SILENT_MS };
  else if (facts.draft) reason = { code: facts.draft.unsure ? 'draft_unsure' : 'draft_ready', since: facts.draft.createdAt };
  else if (facts.escalated) reason = { code: 'important', since: null };
  else if (isUrgentPriority(facts.priority)) reason = { code: 'urgent', since: null };
  else if (sla && slaMs !== null && sla.due_at - now < slaMs * SLA_SOON_SHARE) reason = { code: 'sla_soon', since: sla.due_at };
  else reason = { code: 'waiting', since: waitingSince };

  return { ...base, state: 'needs_human', tier, reason, waiting_since: waitingSince, sla };
}

/**
 * Ошибка в сторону внимания (7.1, «неизвестно»): если состояние посчитать не
 * удалось, строка стоит в «Ждут вас» с причиной «Проверьте диалог».
 */
export function unknownAttention(facts: Pick<AttentionFacts, 'aiMode'>, ctx: AttentionContext): Attention {
  return {
    state: 'needs_human', tier: 1, reason: { code: 'check', since: null }, waiting_since: null, sla: null, handoff: false,
    ai: { configured: facts.aiMode, effective: effectiveAiMode(facts.aiMode, ctx.globalAiMode), paused_reason: null, resume_at: null },
  };
}

/** Живое закрепление: кто ведёт диалог прямо сейчас (claimed_at + 15 мин). */
export function liveOwner(assignee: string | null, claimedAt: number | null, now: number): { key: string; until: number } | null {
  if (!assignee || claimedAt === null) return null;
  const until = claimedAt + CLAIM_LEASE_MS;
  return until > now ? { key: assignee, until } : null;
}

/**
 * Секция для получателя. needs_human — «Ждут вас», если живое закрепление ваше
 * или его нет, и «Ведут коллеги», если диалог ведёт другой человек (6.3.7).
 */
export function sectionFor(state: AttentionState, ownerKey: string | null, viewerKey: string): Section {
  switch (state) {
    case 'needs_human': return ownerKey !== null && ownerKey !== viewerKey ? 'colleagues' : 'mine';
    case 'ai_handling': return 'ai';
    case 'waiting_client': return 'client';
    case 'done': return 'done';
  }
}

/** «Ждут человека» (7.1 п.9): все needs_human — mine и colleagues вместе, одинаково для всех. */
export const needsHuman = (attention: Pick<Attention, 'state'>): boolean => attention.state === 'needs_human';
