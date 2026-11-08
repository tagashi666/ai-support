/**
 * Примеры живых ответов оператора для промпта.
 *
 * База знаний говорит модели, ЧТО отвечать, но не КАК: без образца модель
 * пишет длинно и канцелярски, а оператор — коротко и часто начинает с
 * уточняющего вопроса. Здесь из реальных исходящих сообщений оператора
 * собираются пары «вопрос клиента → ответ оператора», и в промпт
 * подмешиваются 2–3 похожие по смыслу.
 *
 * Пары хранятся уже очищенными (scrub): в промпт и в таблицу не попадают
 * ссылки, ключи, почта, телефоны, номера карт и заказов.
 */
import type { Message, Store } from '../core/store.js';
import { ftsExpression } from '../core/fts.js';
import { looksSensitive, scrub } from './scrub.js';

export interface QaExample {
  question: string;
  answer: string;
}

const CURSOR_KEY = 'qa_pair:cursor';
const QUESTION_CHARS = 300;
const ANSWER_CHARS = 400;
/** Соседние сообщения оператора в пределах этого окна — одна реплика. */
const SAME_TURN_MS = 10 * 60_000;

/** Ответы, из которых нечему учиться: подтверждения и «минуту». */
const FILLER = /^(?:ок(?:ей)?|хорошо|понял[аи]?|принял[аи]?|ага|да|нет|минут(?:у|очку)|секунд(?:у|очку)|сейчас(?: посмотрю| проверю| гляну)?|смотрю|проверяю|проверим|уточняю|ждите|здравствуйте|добрый (?:день|вечер|утро)|привет|спасибо|пожалуйста|рад[аы]? помочь|обращайтесь|всего доброго)$/iu;

function normalize(text: string): string {
  return text.toLocaleLowerCase('ru').replace(/[.,!?;:()"'«»…)\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Очистка от персональных данных: scrub плюс номера заказов и платежей. */
export function cleanExample(text: string, max: number): string {
  const cleaned = scrub(text)
    // Номера заказов, платежей, счетов: шесть и больше цифр подряд.
    .replace(/(?<!\p{L})\d{6,}(?!\p{L})/gu, '[номер]')
    .replace(/#\d{3,}/g, '#[номер]')
    .replace(/\s*\n\s*/g, ' ');
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
}

/**
 * Ответ чему-то учит, если это не голое подтверждение. Длина сама по себе
 * плохой критерий: «Обновите подписку в приложении» короче 40 символов,
 * но это полноценный ответ.
 */
export function isMeaningfulAnswer(text: string): boolean {
  const normalized = normalize(text);
  if (normalized.length < 12) return false;
  if (FILLER.test(normalized)) return false;
  return normalized.split(' ').length >= 3;
}

function isMeaningfulQuestion(text: string): boolean {
  const normalized = normalize(text);
  if (normalized.length < 8) return false;
  return !/^(?:спасибо|благодарю|ок(?:ей)?|понял[а]?|ясно|хорошо|привет|здравствуйте)(?: \p{L}+)?$/iu.test(normalized);
}

/**
 * Вопрос к ответу оператора: реплики клиента после предыдущего ответа
 * человека. Сообщения AI (передача специалисту) и заметки пропускаем —
 * обычно вопрос стоит как раз перед ними.
 */
function questionFor(store: Store, answer: Message): string {
  const before = store.db
    .prepare('SELECT * FROM message WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT 15')
    .all(answer.conversation_id, answer.id) as Message[];
  const parts: string[] = [];
  let turnStart = answer.created_at;
  let collecting = false;
  for (const message of before) {
    if (message.direction === 'note') continue;
    if (message.direction === 'out') {
      if (message.author !== 'agent') continue;
      // Оператор отвечает в несколько сообщений подряд: «Здравствуйте», затем суть.
      if (!collecting && turnStart - message.created_at <= SAME_TURN_MS) {
        turnStart = message.created_at;
        continue;
      }
      break;
    }
    collecting = true;
    if (message.text?.trim()) parts.unshift(message.text.trim());
    if (parts.length >= 3) break;
  }
  return parts.join(' / ');
}

/**
 * Разбирает новые исходящие ответы оператора с прошлого прохода. Курсор —
 * id сообщения, поэтому проход дешёвый и его можно звать перед каждым
 * ответом: ответы из любых каналов (панель, Telegram) доезжают сами.
 * Заодно отклонённая предложка связывается со следующим ответом
 * человека — так видно, как надо было ответить.
 */
export function syncExamples(store: Store, batch = 2000): number {
  const cursor = Number(store.getState(CURSOR_KEY) ?? 0) || 0;
  const answers = store.db
    .prepare(
      `SELECT * FROM message
        WHERE id > ? AND direction = 'out' AND author = 'agent'
        ORDER BY id LIMIT ?`,
    )
    .all(cursor, batch) as Message[];
  if (!answers.length) return 0;

  const insert = store.db.prepare(
    `INSERT OR IGNORE INTO qa_pair (conversation_id, answer_message_id, question, answer, suggestion_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const suggestionStatus = store.db.prepare('SELECT status FROM ai_suggestion WHERE id = ?');
  const linkRejected = store.db.prepare(
    `UPDATE ai_suggestion SET answer_message_id = ?, final_text = ?
      WHERE id = (SELECT id FROM ai_suggestion
                   WHERE conversation_id = ? AND status = 'rejected'
                     AND answer_message_id IS NULL AND created_at <= ?
                   ORDER BY id DESC LIMIT 1)`,
  );

  let added = 0;
  store.db.transaction(() => {
    for (const answer of answers) {
      const text = answer.text?.trim();
      if (!text) continue;
      if (!answer.suggestion_id) linkRejected.run(answer.id, text, answer.conversation_id, answer.created_at);
      if (!isMeaningfulAnswer(text)) continue;
      const rawQuestion = questionFor(store, answer);
      if (!rawQuestion || !isMeaningfulQuestion(rawQuestion)) continue;
      const question = cleanExample(rawQuestion, QUESTION_CHARS);
      const cleanAnswer = cleanExample(text, ANSWER_CHARS);
      if (looksSensitive(question) || looksSensitive(cleanAnswer)) continue;
      const status = answer.suggestion_id
        ? (suggestionStatus.get(answer.suggestion_id) as { status: string } | undefined)?.status ?? null
        : null;
      added += insert.run(answer.conversation_id, answer.id, question, cleanAnswer, status, answer.created_at).changes;
    }
    store.setState(CURSOR_KEY, String(answers.at(-1)!.id));
  })();
  return added;
}

/** Бэкфилл всей истории — при старте. Идёт пачками, чтобы не держать базу. */
export function backfillExamples(store: Store): number {
  let total = 0;
  for (let round = 0; round < 1000; round += 1) {
    const before = store.getState(CURSOR_KEY);
    total += syncExamples(store);
    if (store.getState(CURSOR_KEY) === before) break;
  }
  return total;
}

/**
 * 2–3 пары, похожие на вопрос клиента. Бюджет в символах небольшой: у
 * бесплатных тарифов лимит токенов в минуту общий на весь запрос.
 * Пары из этого же диалога не берём — модель и так видит его историю.
 */
export function similarExamples(
  store: Store,
  query: string,
  options: { limit?: number; maxChars?: number; excludeConversationId?: number } = {},
): QaExample[] {
  const limit = options.limit ?? 3;
  const maxChars = options.maxChars ?? 900;
  const expression = ftsExpression(query);
  if (!expression || limit <= 0 || maxChars <= 0) return [];
  let rows: (QaExample & { conversation_id: number })[];
  try {
    rows = store.db
      .prepare(
        `SELECT p.question, p.answer, p.conversation_id
           FROM qa_fts JOIN qa_pair p ON p.id = qa_fts.rowid
          WHERE qa_fts MATCH ? AND p.conversation_id != ?
          ORDER BY bm25(qa_fts) - CASE WHEN p.suggestion_status = 'edited' THEN 0.5 ELSE 0 END
          LIMIT ?`,
      )
      .all(expression, options.excludeConversationId ?? -1, limit * 4) as (QaExample & { conversation_id: number })[];
  } catch {
    return [];
  }
  const picked: QaExample[] = [];
  const seenConversations = new Set<number>();
  const seenAnswers = new Set<string>();
  let used = 0;
  for (const row of rows) {
    // Разные диалоги и разные ответы: три копии одного шаблона ничему не учат.
    if (seenConversations.has(row.conversation_id)) continue;
    const key = normalize(row.answer).slice(0, 60);
    if (seenAnswers.has(key)) continue;
    const size = row.question.length + row.answer.length;
    if (used + size > maxChars) continue;
    picked.push({ question: row.question, answer: row.answer });
    seenConversations.add(row.conversation_id);
    seenAnswers.add(key);
    used += size;
    if (picked.length >= limit) break;
  }
  return picked;
}

/** Блок для промпта. Текст клиента — в тех же ограничителях, что и в истории. */
export function renderExamples(examples: QaExample[]): string {
  return examples
    .map((example) => `Клиент: <client>${example.question.replace(/<\s*\/?\s*client\s*>/gi, ' ')}</client>\nОператор: ${example.answer}`)
    .join('\n\n');
}

/** Ответ оператора по предложке: итоговый текст и сообщение — для разбора правок. */
export function linkSuggestionAnswer(store: Store, suggestionId: number, messageId: number | undefined, finalText: string): void {
  store.db
    .prepare('UPDATE ai_suggestion SET final_text = ?, answer_message_id = COALESCE(?, answer_message_id) WHERE id = ?')
    .run(finalText, messageId ?? null, suggestionId);
}
