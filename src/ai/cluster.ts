import { log } from '../config.js';
import { extractJson, stripThinking, type AiProvider } from './provider.js';

export interface Groupable {
  question: string;
}

const STOP = new Set([
  'что','как','для','это','мне','вот','там','так','его','при','или','нет','да','the','ещё','еще',
  'если','когда','надо','можно','почему','просто','был','была','было','быть','меня','мной','моей','мою',
  'здравствуйте','привет','добрый','день','вечер','утро','пожалуйста','спасибо','подскажите','скажите',
  'вообще','очень','уже','тоже','этот','этом','дело','такой','есть','нужно','нужен','хочу','могу',
]);

export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 3 && !STOP.has(word))
      .map((word) => word.slice(0, 5)), // грубый стемминг: «айфон» и «айфоне» должны совпасть
  );
}

/**
 * Косинус с весами IDF.
 *
 * Жаккар здесь не годится: он делит на объединение, поэтому два длинных
 * вопроса об одном и том же получают низкую оценку просто из-за длины.
 * На живых тикетах это дало 60 «тем» на 62 пары. IDF заодно обесценивает
 * слова, которые встречаются у всех, и поднимает те, что отличают тему.
 */
export function cosine(a: Set<string>, b: Set<string>, idf: Map<string, number>): number {
  const weight = (word: string): number => idf.get(word) ?? 1;
  let dot = 0;
  for (const word of a) if (b.has(word)) dot += weight(word) ** 2;
  if (!dot) return 0;
  let normA = 0;
  for (const word of a) normA += weight(word) ** 2;
  let normB = 0;
  for (const word of b) normB += weight(word) ** 2;
  return dot / Math.sqrt(normA * normB);
}

/**
 * Лексическая группировка — запасной путь на случай, когда модель недоступна
 * или упёрлась в лимит. Она заведомо слабее: люди описывают одну проблему
 * разными словами, и пересечение словаря этого не ловит. Порог занижен
 * сознательно, потому что недосклеенные темы дают лишние похожие статьи,
 * а это чинится вручную за минуту.
 */
export function clusterLexically(items: Groupable[], threshold = 0.25): number[] {
  const sets = items.map((item) => tokens(item.question));

  const df = new Map<string, number>();
  for (const set of sets) for (const word of set) df.set(word, (df.get(word) ?? 0) + 1);
  const idf = new Map<string, number>();
  for (const [word, count] of df) idf.set(word, Math.log(1 + items.length / count));

  const assigned: number[] = new Array(items.length).fill(-1);
  const centroids: Set<string>[] = [];

  for (let i = 0; i < items.length; i += 1) {
    let best = -1;
    let bestScore = threshold;
    for (let c = 0; c < centroids.length; c += 1) {
      const score = cosine(sets[i]!, centroids[c]!, idf);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best === -1) {
      centroids.push(new Set(sets[i]!));
      assigned[i] = centroids.length - 1;
    } else {
      assigned[i] = best;
      for (const word of sets[i]!) centroids[best]!.add(word);
    }
  }
  return assigned;
}

const TOPIC_PROMPT = `Ты разбираешь обращения в поддержку VPN-сервиса и группируешь их по темам.

Правила:
1. Одна тема — один тип проблемы, а не одна формулировка. «Не подключается на
   айфоне» и «на телефоне не работает подключение» — это одна тема.
2. Оплата, регионы, лимит устройств, скорость, доступ к сервису — разные темы.
3. Обращения, из которых нельзя сделать статью базы знаний (благодарности,
   претензии без вопроса, единичные частные случаи), собери в тему "прочее".
4. Каждый номер должен попасть ровно в одну тему.

Верни строго JSON без markdown:
{"topics":[{"name":"краткое название темы","items":[1,5,9]}]}`;

export interface Grouping {
  assignment: number[];
  names: string[];
  byModel: boolean;
}

/**
 * Группировка моделью. Один дешёвый запрос, но именно он определяет качество
 * статей: неверно сгруппированные обращения дают либо кашу, либо десятки
 * почти одинаковых текстов.
 */
export async function groupTopics(items: Groupable[], provider: AiProvider): Promise<Grouping> {
  const list = items
    .map((item, index) => `${index + 1}. ${item.question.replace(/\s+/g, ' ').slice(0, 180)}`)
    .join('\n');

  try {
    const raw = await provider.complete([
      { role: 'system', content: TOPIC_PROMPT },
      { role: 'user', content: list },
    ]);
    const block = extractJson(stripThinking(raw));
    if (!block) throw new Error('в ответе нет JSON');

    const parsed = JSON.parse(block) as {
      topics?: { name?: string; items?: number[] }[];
    };
    if (!Array.isArray(parsed.topics) || !parsed.topics.length) throw new Error('пустой список тем');

    const assignment: number[] = new Array(items.length).fill(-1);
    const names: string[] = [];

    parsed.topics.forEach((topic, index) => {
      names.push(topic.name?.trim() || `тема ${index + 1}`);
      for (const n of topic.items ?? []) {
        // Номер вне диапазона или повторный — молча игнорируем: модель
        // иногда выдумывает лишние индексы, ронять из-за этого весь проход глупо.
        if (Number.isInteger(n) && n >= 1 && n <= items.length && assignment[n - 1] === -1) {
          assignment[n - 1] = index;
        }
      }
    });

    // Всё, что модель не разнесла по темам, сваливаем в ОДИН кластер «без
    // темы», а не заводим по кластеру на каждое обращение: иначе майнинг
    // потратил бы отдельный запрос на каждую такую пару.
    let orphan = -1;
    for (let i = 0; i < assignment.length; i += 1) {
      if (assignment[i] === -1) {
        if (orphan === -1) { orphan = names.length; names.push('без темы'); }
        assignment[i] = orphan;
      }
    }
    return { assignment, names, byModel: true };
  } catch (err) {
    log.warn(`Группировка моделью не удалась: ${(err as Error).message}`);
    return { assignment: clusterLexically(items), names: [], byModel: false };
  }
}
