// Панель: правила живого состояния без DOM. Их проверяет scripts/uitest.ts в node.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './state.js';

const CLOSED_STATUSES = new Set(['resolved', 'closed']);
export const isClosedStatus = (status) => CLOSED_STATUSES.has(status);

/**
 * «Ждут ответа»: есть непрочитанное или открытому диалогу ещё не отвечали.
 * Закрытый без ответа (спам, решён в Bedolaga) раньше висел здесь и в счётчике
 * «Без ответа» навсегда, хотя сервер (SLA, очередь) его уже не ждёт.
 */
export const awaitingReply = (c) => c.unread > 0 || (!c.first_response_at && !isClosedStatus(c.status));
export const unanswered = (c) => !c.first_response_at && Boolean(c.last_inbound_at) && !isClosedStatus(c.status);

/** Скрытый диалог сервер в список не отдаёт — живой кадр его туда не возвращает. */
export const listable = (c) => !c.hidden_at;

const time = (c) => Number(c.last_message_at ?? c.created_at ?? 0);

/**
 * Порядок списка — ровно как ORDER BY в listConversations
 * (src/core/store/conversations.ts): важные выше, потом по последнему
 * сообщению, при равном времени — по id. Пометка «нет в базе» в порядке не
 * участвует. Раньше сервер и браузер сортировали по-разному, и верхний диалог
 * «скакал» между живым кадром и полной загрузкой.
 */
export function compareConversations(a, b) {
  return (Number(b.escalated ?? 0) - Number(a.escalated ?? 0))
    || (time(b) - time(a))
    || (Number(b.id) - Number(a.id));
}

/** Вставляет или заменяет строку на её место без пересортировки всего списка. */
export function upsertConversation(list, conversation) {
  const rest = list.filter((item) => item.id !== conversation.id);
  let low = 0, high = rest.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compareConversations(rest[mid], conversation) <= 0) low = mid + 1; else high = mid;
  }
  rest.splice(low, 0, conversation);
  return rest;
}

/** Кадр старше того, что уже на экране, не откатывает строку назад. */
export const isStale = (incoming, existing) =>
  Boolean(existing) && Number(incoming.updated_at ?? 0) < Number(existing.updated_at ?? 0);

/**
 * Слияние полного снимка с тем, что уже пришло живыми кадрами.
 * - строка новее снимка (больший updated_at) остаётся местной;
 * - строки, которой нет в снимке, нет и в списке — кроме открытого диалога и
 *   строк, пришедших кадром уже после отправки запроса снимка (keep);
 * - неподтверждённое сервером прочтение (pendingRead) не мигает точкой.
 */
export function mergeSnapshot(local, snapshot, { keep = new Set(), pendingRead = new Set() } = {}) {
  const byId = new Map(local.map((item) => [item.id, item]));
  const merged = new Map();
  for (const row of snapshot) {
    const mine = byId.get(row.id);
    let next = mine && isStale(row, mine) ? mine : row;
    if (pendingRead.has(next.id) && next.unread) next = { ...next, unread: 0 };
    merged.set(next.id, next);
  }
  for (const item of local) {
    if (!merged.has(item.id) && keep.has(item.id) && listable(item)) merged.set(item.id, item);
  }
  return [...merged.values()].sort(compareConversations);
}

/**
 * Какая предложка остаётся на экране после живого кадра открытого диалога.
 * Устаревшей она становится, когда клиент написал снова, человек ответил сам
 * (из панели, Telegram или Bedolaga), ушёл именно этот черновик, предложку
 * решили в другой вкладке или диалог закрыли. Сообщение AI о передаче
 * человеку (author 'ai' без suggestion_id) черновик не снимает: в режиме
 * «предлагает» оно приходит сразу после предложки.
 */
export function suggestionAfterFrame(suggestion, frame) {
  if (frame.type === 'suggestion') {
    if (frame.suggestion?.status === 'pending') return frame.suggestion;
    return suggestion && suggestion.id === frame.suggestion?.id ? null : suggestion;
  }
  if (!suggestion) return suggestion;
  const message = frame.type === 'message' ? frame.message : null;
  if (message && !message.is_backfill) {
    if (message.direction === 'in') return null;
    if (message.direction === 'out' && (message.author === 'agent' || message.suggestion_id === suggestion.id)) return null;
  }
  if (frame.conversation && isClosedStatus(frame.conversation.status)) return null;
  return suggestion;
}
