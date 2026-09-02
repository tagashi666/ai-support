import { runtime } from '../core/settings.js';
import { toneOf } from '../core/notify.js';
import { replyWindow, type Conversation, type Store } from '../core/store.js';
import type { AiDraft } from './provider.js';

export interface GateDecision {
  action: 'auto' | 'shadow' | 'suggest' | 'skip';
  reason: string;
}

/**
 * Темы, где ошибка модели стоит денег или репутации. Даже уверенный ответ
 * по ним уходит человеку: возвраты, платежи, обвинения, юридические угрозы.
 */
const SENSITIVE = [
  /возврат|верните|вернуть деньг|refund|чарджбэк|chargeback/i,
  /списал[ои]сь|двойн(ая|ое) оплат|не приш[ёе]л плат|дважды снял/i,
  /обман|мошенн|развод|скам|scam|кинул/i,
  /суд|юрист|адвокат|жалоб|прокуратур|роскомнадзор|полици/i,
  /взлом|украл|угнал|доступ к аккаунту|сменил пароль/i,
  /パートナ|партн[её]рств|сотрудничеств|оптом|реселл/i,
];

/** Клиент явно зовёт живого человека — модель не должна перехватывать. */
const WANTS_HUMAN = /оператор|живой человек|человека позов|менеджер|支持人员|support agent/i;

export function isSensitive(text: string): boolean {
  return SENSITIVE.some((pattern) => pattern.test(text)) || WANTS_HUMAN.test(text);
}

export function resolveMode(conversation: Conversation): 'off' | 'shadow' | 'suggest' | 'auto' {
  // 'off' в настройках — рубильник: гасит AI везде, что бы ни стояло в диалоге.
  // Это единственный способ остановить всё разом, и он должен быть надёжным.
  if (runtime.aiMode === 'off') return 'off';

  // Остальные режимы — значение по умолчанию для новых диалогов. Явно
  // выставленный режим диалога сильнее: иначе переключатель в карточке
  // молча ничего не делает, а это хуже, чем его отсутствие.
  const own = conversation.ai_mode;
  if (own === 'off' || own === 'shadow' || own === 'suggest' || own === 'auto') return own;
  return runtime.aiMode;
}

/**
 * Решение принимается ПОСЛЕ генерации: черновик всё равно сохраняется как
 * предложка, вопрос только в том, уходит ли он клиенту сам.
 */
export function decide(
  store: Store,
  conversation: Conversation,
  clientText: string,
  draft: AiDraft,
  kbHits = 1,
): GateDecision {
  const mode = resolveMode(conversation);
  if (mode === 'shadow') return { action: 'shadow', reason: 'теневой режим: только внутренний черновик' };
  if (mode !== 'auto') return { action: 'suggest', reason: `режим ${mode}` };

  // Главный предохранитель против выдумок: если база знаний по вопросу
  // ничего не нашла, ответ построен на общих соображениях модели. Такое
  // клиенту само не уходит ни при какой уверенности.
  // kbHits — не «поиск что-то нашёл», а «модель назвала выдержку, на которой
  // построила ответ». Совпадения по словам недостаточно: вопрос про сервер
  // цепляет статью про скорость, а ответа в ней нет.
  if (runtime.requireKb && kbHits === 0) {
    return { action: 'suggest', reason: 'ответ не опирается на базу знаний' };
  }
  // Флаг модели уважаем, но не как безусловное вето: при выключенной
  // опоре на базу знаний решает уверенность, иначе переключатель
  // «разрешить отвечать без опоры» не делал бы ничего.
  if (draft.needsHuman && (runtime.requireKb || draft.confidence < 0.85)) {
    return { action: 'suggest', reason: 'модель сама просит человека' };
  }
  if (draft.confidence < runtime.minConfidence) {
    return { action: 'suggest', reason: `уверенность ${draft.confidence.toFixed(2)} ниже порога` };
  }
  if (conversation.escalated) return { action: 'suggest', reason: 'диалог эскалирован' };
  if (isSensitive(clientText)) return { action: 'suggest', reason: 'чувствительная тема' };
  if (toneOf(clientText) === 'агрессивный') {
    return { action: 'suggest', reason: 'клиент на взводе — нужен человек' };
  }

  if (!replyWindow(conversation).open) {
    return { action: 'skip', reason: 'окно ответа закрыто' };
  }

  const lastHuman = store.lastHumanReplyAt(conversation.id);
  if (lastHuman && Date.now() - lastHuman < runtime.humanHoldMinutes * 60_000) {
    return { action: 'suggest', reason: 'диалог недавно вёл человек' };
  }

  // Предохранитель от зацикливания: считается в пределах одного диалога.
  // Ноль означает «без предела» — тогда проверку пропускаем совсем.
  if (runtime.autoPerHour > 0) {
    const recentAi = store.aiRepliesSince(conversation.id, Date.now() - 3_600_000);
    if (recentAi >= runtime.autoPerHour) {
      return { action: 'suggest', reason: `в этом диалоге уже ${recentAi} автоответов за час` };
    }
  }

  return { action: 'auto', reason: `уверенность ${draft.confidence.toFixed(2)}` };
}
