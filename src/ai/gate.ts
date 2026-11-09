import { runtime } from '../core/settings.js';
import { isPaused } from '../core/pause.js';
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
  // «суд» — только формы самого слова: «судя по всему» и «судить» сюда не
  // попадают. \b в JS не видит кириллицу, поэтому границы — через \p{L}.
  /(?<!\p{L})(?:суд(?:а|у|ом|е|ы|ов|ам|ами|ах)?|судебн\p{L}*|засуд\p{L}*)(?!\p{L})|юрист|адвокат|жалоб|жаловать|пожалуюсь|прокуратур|роскомнадзор|полици/iu,
  /взлом|украл|угнал|доступ к аккаунту|сменил пароль/i,
  /パートナ|партн[её]рств|сотрудничеств|оптом|реселл/i,
];

/**
 * Клиент явно зовёт живого человека — модель не должна перехватывать.
 *
 * Голое «оператор» ловило «оператор связи», «мобильный оператор», «у моего
 * оператора» — для VPN-поддержки это обычный рассказ о проблеме, а не
 * просьба о человеке. Поэтому слово считается просьбой только рядом с
 * глаголом зова («позовите», «соедините», «хочу», «нужен») или когда оно
 * составляет всё сообщение.
 */
const L = '(?<!\\p{L})';
const R = '(?!\\p{L})';
const HUMAN_NOUN = `(?:оператор(?:а|у|ом)?|менеджер(?:а|у|ом)?|специалист(?:а|у|ом)?|человек(?:а|у|ом)?|сотрудник(?:а|у|ом)?|админ(?:а|у|ом)?|администратор(?:а|у|ом)?)`;
const CALL_VERB = `(?:позов\\p{L}*|позв(?:ать|ите)|зов(?:и|ите)|дайте|дай|соедин\\p{L}*|свяж\\p{L}*|связать\\p{L}*|переключ\\p{L}*|передайте|хочу|нужен|нужна|нужно|требую|можно|где|подключите|давайте)`;
const FILLER = `(?:пожалуйста|плиз|мне|нам|меня|нас|с|со|на|к|хоть|уже|срочно|ваш\\p{L}*|живо\\p{L}*|настоящ\\p{L}*|нормальн\\p{L}*|кого-?(?:то|нибудь)|какого-?(?:то|нибудь)|поговорить|пообщаться|связаться|написать|общаться)`;
/** «оператор связи», «оператор сотовой связи» — речь о провайдере клиента. */
const NOT_CARRIER = '(?![\\s,]+(?:связи|сотов\\p{L}*|мобильн\\p{L}*|интернет\\p{L}*|домашн\\p{L}*))';
const WANTS_HUMAN: RegExp[] = [
  // Глагол зова, между ним и адресатом — только служебные слова:
  // «позовите, пожалуйста, оператора», «свяжите меня с живым человеком».
  // Произвольные слова не пропускаем: «хочу сменить мобильного оператора».
  new RegExp(`${L}${CALL_VERB}${R}(?:[\\s,!.:-]+${FILLER}${R})*[\\s,!.:-]+${HUMAN_NOUN}${R}${NOT_CARRIER}`, 'iu'),
  // «оператор!», «оператора пожалуйста», «оператора позовите» — сообщение и есть просьба
  new RegExp(`^[\\s\\p{P}]*${HUMAN_NOUN}(?:[\\s,!.]+(?:пожалуйста|плиз|позовите|срочно|please))*[\\s\\p{P}]*$`, 'iu'),
  new RegExp(`${L}жив(?:ой|ого|ым)\\s+(?:человек|оператор|сотрудник)\\p{L}*`, 'iu'),
  new RegExp(`${L}${HUMAN_NOUN}\\s+позов\\p{L}*`, 'iu'),
  /支持人员|support agent|real person|human agent|talk to (?:a )?human/i,
];

export function wantsHuman(text: string): boolean {
  return WANTS_HUMAN.some((pattern) => pattern.test(text));
}

export function isSensitive(text: string): boolean {
  return SENSITIVE.some((pattern) => pattern.test(text)) || wantsHuman(text);
}

/**
 * Вопросы клиента о его собственной подписке. На них отвечают цифрами из
 * блока «Клиент», а не статьёй «где посмотреть в приложении». Эвристика
 * простая: тема (трафик, срок, устройства…) плюс вопросительный признак —
 * «трафик не идёт» про связь, а не про остаток.
 */
export type PersonalTopic = 'traffic' | 'expiry' | 'devices' | 'payment' | 'link' | 'tariff';

const PERSONAL: [PersonalTopic, RegExp, RegExp][] = [
  ['traffic', /трафик|гигабайт|гигов|(?<!\p{L})гб(?!\p{L})|(?<!\p{L})gb(?!\p{L})/u,
    /скольк|остал|остат|израсход|потрач|потрат|лимит|кончил|закончил|исчерпа|\?/u],
  ['expiry', /подписк|тариф|доступ|срок|оплачен/u,
    /когда|до какого|скольк\p{L}* (?:дней|осталось)|истека|истеч|заканчива|закончится|кончится|кончается|действует до|срок действия|продлен\p{L}* до/u],
  ['devices', /устройств|девайс/u, /скольк|лимит|можно|максимум|ещ[её] одн|добав|подключ\p{L}* ещ/u],
  ['payment', /оплат|плат[её]ж|заплатил|оплатил|перевел|перевёл|списал/u,
    /пришл|пришел|пришёл|прош[её]л|прошл|зачисл|дошл|дош[её]л|получил|видн|(?<!\p{L})ли(?!\p{L})|\?/u],
  ['link', /ссылк|ключ|конфиг/u,
    /подписк|(?<!\p{L})(?:мо[йюя]|сво[йюя])(?!\p{L})|скинь|пришлит|дайте|где (?:взять|найти)|скопир|получить|потерял/u],
  ['tariff', /тариф/u, /какой|какая|у меня|(?<!\p{L})мой(?!\p{L})|текущ/u],
];

export function personalTopics(text: string): PersonalTopic[] {
  const normalized = text.toLocaleLowerCase('ru').replace(/ё/g, 'е');
  return PERSONAL
    .filter(([, topic, cue]) => topic.test(normalized) && cue.test(normalized))
    .map(([name]) => name);
}

const CLARIFY_WINDOW_MS = 30 * 60_000;

/**
 * Начало текущего разговора для счётчиков AI. Закрытие диалога завершает
 * разговор: ответы AI до него не должны тормозить новое обращение того же
 * клиента (resolved_at обнуляется входящим, поэтому — last_resolved_at).
 */
function conversationStart(conversation: Conversation, windowMs: number, now = Date.now()): number {
  return Math.max(now - windowMs, conversation.last_resolved_at ?? 0);
}

/**
 * Задавал ли AI уточняющий вопрос в этом разговоре. Раньше считался любой
 * ответ AI: после обычного совета («обновите подписку») модель уже не могла
 * сама спросить «на каком устройстве?», хотя это первый вопрос, а не второй.
 * Признак — сама форма сообщения: короткий вопрос, как в isClarifyingQuestion.
 */
function clarifiedSince(store: Store, conversationId: number, since: number): boolean {
  return store.listMessages(conversationId, 30).some((message) =>
    message.direction === 'out' && message.author === 'ai' && message.created_at > since
    && isClarifyingQuestion({ reply: message.text ?? '', clarify: true, needsHuman: false }));
}

/** Черновик — ровно один короткий вопрос клиенту, без советов. */
export function isClarifyingQuestion(draft: Pick<AiDraft, 'reply' | 'clarify' | 'needsHuman'>): boolean {
  if (!draft.clarify || draft.needsHuman) return false;
  const reply = draft.reply.trim();
  if (!reply.endsWith('?') || reply.length > 220) return false;
  return (reply.match(/\?/g) ?? []).length <= 2;
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
export interface DecideOptions {
  /**
   * Проверка «как бы ответил в режиме «Отвечает сам»» (песочница, 6.7):
   * режим считается auto, общий рубильник и пауза помощника не учитываются.
   */
  assumeAuto?: boolean;
}

export function decide(
  store: Store,
  conversation: Conversation,
  clientText: string,
  draft: AiDraft,
  kbHits = 1,
  options: DecideOptions = {},
): GateDecision {
  const mode = options.assumeAuto ? 'auto' : resolveMode(conversation);
  // Режим могли выключить, пока модель думала: клиенту в нём не уходит
  // ничего, включая «передал специалисту» из ветки предложки.
  if (mode === 'off') return { action: 'skip', reason: 'AI выключен' };

  // Пауза помощника везде (10.4 п.1, 14.6а): клиенту не уходит ничего, черновик
  // для человека пишется. Настроенный режим не меняется — после паузы всё как было.
  if (!options.assumeAuto && isPaused()) {
    return mode === 'shadow' ? { action: 'shadow', reason: 'теневой режим: только внутренний черновик' }
      : { action: 'suggest', reason: 'пауза помощника: только предложка' };
  }

  // Ответ человека важнее любых свойств черновика. Раньше эта проверка
  // стояла после базы знаний, confidence и sensitive: первая сработавшая
  // ветка возвращала suggest, а Responder успевал отправить handoff клиенту.
  // В итоге AI снова влезал в разговор через пару минут после оператора.
  // В паузе клиенту не уходит ничего, но черновик оператору полезен:
  // в режиме «предлагает» его ждут, а в auto он просто не отправляется сам.
  if (store.humanHoldActive(conversation.id, runtime.humanHoldMinutes)) {
    return mode === 'shadow' ? { action: 'shadow', reason: 'теневой режим: только внутренний черновик' }
      : { action: 'suggest', reason: 'пауза после ответа оператора: только предложка' };
  }
  // Диалог ждёт специалиста: по существу клиенту AI не отвечает, но свежий
  // черновик оператору нужен — прежнюю предложку погасило новое входящее.
  if (conversation.handoff_at) {
    return mode === 'shadow' ? { action: 'shadow', reason: 'теневой режим: только внутренний черновик' }
      : { action: 'suggest', reason: 'диалог ждёт специалиста: только предложка' };
  }

  if (mode === 'shadow') return { action: 'shadow', reason: 'теневой режим: только внутренний черновик' };
  if (mode !== 'auto') return { action: 'suggest', reason: `режим ${mode}` };
  // Пустой reply при needs_human — законный ответ «нужен человек»: отправлять
  // клиенту нечего, что бы ни говорили уверенность и опора.
  if (!draft.reply.trim()) return { action: 'suggest', reason: 'нет текста для клиента' };

  // Главный предохранитель против выдумок: если база знаний по вопросу
  // ничего не нашла, ответ построен на общих соображениях модели. Такое
  // клиенту само не уходит ни при какой уверенности.
  // kbHits — не «поиск что-то нашёл», а «модель назвала выдержку, на которой
  // построила ответ». Совпадения по словам недостаточно: вопрос про сервер
  // цепляет статью про скорость, а ответа в ней нет.
  // Исключение — один короткий уточняющий вопрос («на каком устройстве?»):
  // фактов в нём нет, выдумать в нём нечего, а оператор начинает с него
  // примерно в трети обращений. Второй вопрос подряд — уже допрос, его
  // решает человек.
  const clarifying = isClarifyingQuestion(draft);
  if (clarifying && clarifiedSince(store, conversation.id, conversationStart(conversation, CLARIFY_WINDOW_MS))) {
    return { action: 'suggest', reason: 'уточняющий вопрос уже задавали' };
  }
  if (runtime.requireKb && kbHits === 0 && !clarifying) {
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

  // Предохранитель от зацикливания: считается в пределах одного диалога.
  // Ноль означает «без предела» — тогда проверку пропускаем совсем.
  if (runtime.autoPerHour > 0) {
    const recentAi = store.aiRepliesSince(conversation.id, conversationStart(conversation, 3_600_000));
    if (recentAi >= runtime.autoPerHour) {
      return { action: 'suggest', reason: `в этом диалоге уже ${recentAi} автоответов за час` };
    }
  }

  return { action: 'auto', reason: `уверенность ${draft.confidence.toFixed(2)}` };
}
