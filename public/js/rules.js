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
