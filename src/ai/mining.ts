import { config, log } from '../config.js';
import { AiProvider, extractJson, stripThinking, type ChatMessage } from './provider.js';
import { groupTopics } from './cluster.js';
import { looksSensitive, scrub } from './scrub.js';
import { BedolagaClient, parseTimestamp } from '../channels/bedolaga.js';
import type { RawExchange } from '../integrations/tgexport.js';
import type { Store } from '../core/store.js';
import { slugFromTitle, writeDoc } from '../panel/kbfiles.js';

/** Кириллица укладывается примерно в 2.5 символа на токен. Оценка с запасом. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 2.5);

/** Темы-помойки, из которых статей не делают. */
const JUNK_TOPIC = /прочее|разное|другое|прочие|misc|other/i;

const PROMPT = `Ты составляешь базу знаний техподдержки сервиса {brand} (VPN по подписке).

На вход — реальные пары «вопрос клиента → ответ оператора», сгруппированные по темам.
Пары с одинаковой пометкой [тема N] относятся к одному вопросу.

Правила:
1. Одна тема — одна статья. Не размножай похожее.
2. Пиши инструкцию для оператора, а не пересказ диалога. Без приветствий,
   без «клиент написал», без «мы ответили».
3. Выбрасывай единичные случаи, которые не повторятся, и всё привязанное ко
   времени: акции, «сервер сейчас чинится», конкретные даты и суммы.
4. Никаких персональных данных, ключей, ссылок и номеров.
5. Если ответы оператора по одной теме противоречат друг другу — пропусти тему.
   Не выбирай сам, какой из них правильный.
6. Русский язык, деловой тон, без канцелярита. Сохраняй формулировки оператора
   там, где они удачные: это живой голос поддержки, его и надо закрепить.

Верни строго JSON без markdown:
{"articles":[{"title":"краткий заголовок","body":"текст статьи","sources":[номера пар],"confidence":0.0-1.0}]}

confidence — насколько ответ подтверждён несколькими независимыми случаями.
Одна пара без подтверждений — не выше 0.5.`;

export interface Article {
  title: string;
  body: string;
  sources: number[];
  confidence: number;
}

export interface Prepared extends RawExchange {
  n: number;
  cluster: number;
}

export interface MiningOptions {
  source: 'archive' | 'panel' | 'export';
  status?: string;
  limit?: number;
  all?: boolean;
  exchanges?: RawExchange[];
  dryRun?: boolean;
  /** Точный набор диалогов — для обучения после закрытия одного обращения. */
  conversationIds?: number[];
}

export interface MiningReport {
  pairs: number;
  topics: { name: string; size: number; skipped: boolean }[];
  skipped: number;
  requests: number;
  estimatedTokens: number;
  articles: { title: string; file: string; confidence: number }[];
  dryRun: boolean;
}

export type Progress = (message: string) => void;

// --- разбор ответа модели ---------------------------------------------------

export function parseArticles(raw: string): Article[] {
  const block = extractJson(stripThinking(raw));
  if (!block) return [];
  try {
    const parsed = JSON.parse(block) as { articles?: unknown };
    if (!Array.isArray(parsed.articles)) return [];
    return parsed.articles.flatMap((item) => {
      const article = item as Partial<Article>;
      if (typeof article.title !== 'string' || typeof article.body !== 'string') return [];
      if (!article.title.trim() || article.body.trim().length < 40) return [];
      return [{
        title: article.title.trim(),
        body: article.body.trim(),
        sources: Array.isArray(article.sources) ? article.sources.filter((n) => typeof n === 'number') : [],
        confidence: typeof article.confidence === 'number' ? article.confidence : 0,
      }];
    });
  } catch (err) {
    log.warn('Ответ модели не разобран', err);
    return [];
  }
}

/**
 * Раскладывает по запросам, стараясь не разрывать темы.
 *
 * Считаем токены, а не штуки: лимит провайдера измеряется в токенах в минуту,
 * и два десятка длинных обращений в одном запросе упираются в него целиком.
 * Тема, которая не влезает в бюджет, режется на части без потерь.
 */
export function batch(items: Prepared[], budget: number): Prepared[][] {
  const byCluster = new Map<number, Prepared[]>();
  for (const item of items) {
    const list = byCluster.get(item.cluster) ?? [];
    list.push(item);
    byCluster.set(item.cluster, list);
  }
  const groups = [...byCluster.values()].sort((a, b) => b.length - a.length);
  const cost = (item: Prepared): number => estimateTokens(item.question) + estimateTokens(item.answer) + 30;

  const batches: Prepared[][] = [];
  let current: Prepared[] = [];
  let currentCost = 0;
  const flush = (): void => {
    if (current.length) batches.push(current);
    current = [];
    currentCost = 0;
  };

  for (const group of groups) {
    const groupCost = group.reduce((sum, item) => sum + cost(item), 0);
    if (groupCost > budget) {
      flush();
      let chunk: Prepared[] = [];
      let chunkCost = 0;
      for (const item of group) {
        if (chunk.length && chunkCost + cost(item) > budget) {
          batches.push(chunk);
          chunk = [];
          chunkCost = 0;
        }
        chunk.push(item);
        chunkCost += cost(item);
      }
      if (chunk.length) batches.push(chunk);
      continue;
    }
    if (current.length && currentCost + groupCost > budget) flush();
    current.push(...group);
    currentCost += groupCost;
  }
  flush();
  return batches;
}

// --- источники --------------------------------------------------------------

export async function fromArchive(status: string, limit: number, progress: Progress): Promise<RawExchange[]> {
  if (!config.bedolaga.enabled) throw new Error('BEDOLAGA_ENABLED=false — архив тикетов брать неоткуда');
  const client = new BedolagaClient(config.bedolaga.url, config.bedolaga.token);
  const tickets = await client.ticketsByStatus(status, limit);
  progress(`Тикетов в статусе ${status}: ${tickets.length}`);

  const exchanges: RawExchange[] = [];
  let processed = 0;

  for (const summary of tickets) {
    const ticket = summary.messages?.length ? summary : await client.ticket(summary.id);
    const messages = (ticket.messages ?? []).slice().sort((a, b) => parseTimestamp(a, 0) - parseTimestamp(b, 0));

    let question: string | null = null;
    for (const message of messages) {
      const text = (message.message_text ?? '').trim();
      if (!text) continue;
      if (!message.is_from_admin) {
        question = question ? `${question}\n${text}` : text;
        continue;
      }
      if (question && text.length >= 40 && question.length >= 10) {
        exchanges.push({ source: 'bedolaga', reference: `тикет #${ticket.id}`, question, answer: text });
      }
      question = null;
    }
    processed += 1;
    if (processed % 10 === 0 || processed === tickets.length) {
      progress(`Обработано тикетов: ${processed}/${tickets.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return exchanges;
}

export function fromPanel(store: Store, all: boolean, limit: number, conversationIds?: number[]): RawExchange[] {
  const ids = conversationIds?.length
    ? conversationIds.slice(0, limit)
    : all ? store.answeredConversations(limit) : store.gapConversations(limit);
  return store.exchanges(ids).map((item) => ({
    source: 'panel',
    reference: `диалог ${item.conversationId}`,
    question: item.question,
    answer: item.answer,
  }));
}

// --- главный проход ---------------------------------------------------------

export async function runMining(
  store: Store,
  options: MiningOptions,
  progress: Progress = () => {},
): Promise<MiningReport> {
  const limit = options.limit ?? 200;

  const raw =
    options.source === 'archive'
      ? await fromArchive(options.status ?? 'closed', limit, progress)
      : options.source === 'export'
        ? (options.exchanges ?? [])
        : fromPanel(store, options.all === true, limit, options.conversationIds);

  if (!raw.length) {
    return { pairs: 0, topics: [], skipped: 0, requests: 0, estimatedTokens: 0, articles: [], dryRun: !!options.dryRun };
  }

  // Чистим ДО отправки: наружу уходит пачка чужой переписки, а не одно сообщение.
  const scrubbed = raw.map((item) => ({
    ...item,
    question: scrub(item.question).slice(0, 800),
    answer: scrub(item.answer).slice(0, 1500),
  }));
  const safe = scrubbed.filter((item) => !looksSensitive(item.question) && !looksSensitive(item.answer));
  const droppedForSecrets = scrubbed.length - safe.length;
  if (droppedForSecrets) progress(`Отброшено как подозрительное на секреты: ${droppedForSecrets}`);

  if (!config.ai.apiKeys.length) throw new Error('AI_API_KEY не задан — майнить нечем');
  const provider = new AiProvider();

  progress(`Пар после чистки: ${safe.length}. Группирую по темам…`);
  const { assignment, names, byModel } = await groupTopics(safe, provider);
  if (!byModel) progress('Модель не справилась — группирую лексически, темы будут грубее.');

  const all = safe.map((item, index) => ({ ...item, n: index + 1, cluster: assignment[index]! }));
  const junk = new Set(names.map((name, index) => (JUNK_TOPIC.test(name) ? index : -1)).filter((i) => i !== -1));
  const items = all.filter((item) => !junk.has(item.cluster));

  const batches = batch(items, config.ai.mineBudgetTokens);
  const sizes = new Map<number, number>();
  for (const c of assignment) sizes.set(c, (sizes.get(c) ?? 0) + 1);

  const topics = [...sizes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, size]) => ({
      name: names[id] ?? all.find((item) => item.cluster === id)?.question.slice(0, 60) ?? `тема ${id}`,
      size,
      skipped: junk.has(id),
    }));

  const estimatedTokens = batches.reduce(
    (sum, group) => sum + group.reduce((s, item) => s + estimateTokens(item.question) + estimateTokens(item.answer), 0),
    0,
  );

  const report: MiningReport = {
    pairs: items.length,
    topics,
    skipped: all.length - items.length,
    requests: batches.length,
    estimatedTokens,
    articles: [],
    dryRun: !!options.dryRun,
  };

  if (options.dryRun) return report;

  const articles: Article[] = [];
  for (const [index, group] of batches.entries()) {
    // Пауза против TPM: лимит считается в минуту, без неё второй запрос упрётся в 429.
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, config.ai.minePaceMs));

    const body = group
      .map((item) => `[${item.n}] [тема ${item.cluster}]\nВопрос: ${item.question}\nОтвет: ${item.answer}`)
      .join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: PROMPT.replace('{brand}', config.ai.brand) },
      { role: 'user', content: body },
    ];
    try {
      const parsed = parseArticles(await provider.complete(messages, 3, config.ai.mineMaxTokens));
      articles.push(...parsed);
      progress(`Запрос ${index + 1}/${batches.length}: ${group.length} пар → ${parsed.length} статей`);
    } catch (err) {
      progress(`Запрос ${index + 1}/${batches.length} не прошёл: ${(err as Error).message}`);
    }
  }

  const used = new Set<string>();
  for (const article of articles) {
    // Суффикс вешаем на уже обрезанный слаг, а не переслагиваем заголовок:
    // slugFromTitle режет до 60 символов, и на длинном заголовке номер «2»
    // просто отрезался бы — все варианты давали один слаг, а цикл ниже
    // крутился бы вечно и вешал фоновую задачу майнинга.
    const base = slugFromTitle(article.title);
    let file = base;
    let suffix = 1;
    while (used.has(file)) file = base.replace(/\.md$/, `-${++suffix}.md`);
    used.add(file);

    const refs = [...new Set(article.sources.map((n) => items.find((item) => item.n === n)?.reference).filter(Boolean))];
    const content = [
      `# ${article.title}`, '', article.body, '',
      '<!--',
      `черновик, собран ${new Date().toISOString().slice(0, 10)}`,
      `уверенность модели: ${article.confidence.toFixed(2)}`,
      `источники: ${refs.length ? refs.join(', ') : 'не указаны'}`,
      '-->', '',
    ].join('\n');

    await writeDoc('draft', file, content);
    report.articles.push({ title: article.title, file, confidence: article.confidence });
  }

  progress(`Готово: ${report.articles.length} статей`);
  return report;
}
