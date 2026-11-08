import { config, log } from '../config.js';
import { runtime } from '../core/settings.js';
import { lenientParse, mergePairs, regexFields, stripFences } from './repair.js';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

/**
 * Убирает рассуждения модели.
 *
 * Reasoning-модели (DeepSeek R1, QwQ, gpt-oss) выдают ход мысли в тегах
 * перед ответом. Это не только мусор в глазах клиента: если в размышлении
 * попадётся фигурная скобка, наш разбор JSON цепляется за неё и весь ответ
 * теряется. Поэтому режем до любого парсинга.
 */
export function stripThinking(raw: string): string {
  let text = raw;
  for (const tag of ['think', 'thinking', 'reasoning', 'reflection', 'scratchpad']) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '');
    // Незакрытый тег означает, что модель не успела дойти до ответа:
    // всё после него — размышление, обрезанное лимитом токенов.
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'i'), '');
  }
  return text.trim();
}

/**
 * Находит первый цельный объект JSON. Наивный поиск от первой скобки до
 * последней ломается, когда рядом есть текст со скобками, поэтому считаем
 * вложенность и пропускаем содержимое строк.
 */
export function extractJson(raw: string): string | undefined {
  const text = stripFences(raw);
  const start = text.indexOf('{');
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

export class FallbackEligibleError extends Error {}

export class RateLimitedError extends FallbackEligibleError {
  constructor(detail: string) {
    super(`Лимит провайдера исчерпан: ${detail}`);
    this.name = 'RateLimitedError';
  }
}

export class ModelUnavailableError extends FallbackEligibleError {
  constructor(detail: string) {
    super(`Модель недоступна: ${detail}`);
    this.name = 'ModelUnavailableError';
  }
}

/** 4xx на запрос к конкретной модели: повторять ей бессмысленно, запасной — можно. */
export class ModelRequestError extends FallbackEligibleError {}

export class ProviderUnavailableError extends FallbackEligibleError {
  constructor(detail: string) {
    super(`Провайдер временно недоступен: ${detail}`);
    this.name = 'ProviderUnavailableError';
  }
}

/** Groq возвращает снятую модель как 400 с кодом в JSON, не как 404. */
function modelUnavailable(status: number, body: string): boolean {
  if ([404, 410].includes(status)) return true;
  if (![400, 422].includes(status)) return false;
  return /model[_ -]?(?:decommissioned|not[_ -]?found|unavailable|retired)|(?:model|модел\S*)[^\n]{0,100}(?:decommission|does not exist|not found|unsupported|unavailable|retired|снят|недоступ)/i.test(body);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const backoffMs = (attempt: number): number => Math.min(2000 * 2 ** attempt, 30_000);

export function hasImageInput(messages: ChatMessage[]): boolean {
  return messages.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part.type === 'image_url'));
}

export function supportsVision(model: string): boolean {
  return config.ai.visionModels.includes(model.trim());
}

/** Groq-модели принимают разные значения reasoning_effort. */
export function reasoningEffortFor(model: string): string | undefined {
  const configured = config.ai.reasoningEffort;
  if (!configured) return undefined;
  if (model === 'qwen/qwen3.8-27b') return configured;
  if (model.startsWith('openai/gpt-oss-')) return configured === 'none' ? 'low' : configured;
  return undefined;
}

/**
 * Рассуждения расходуют тот же max_tokens, что и ответ. На 700 токенах
 * reasoning-модель успевает подумать, но JSON обрывается — ответ теряется
 * как ai_unparsed. Поэтому при включённых рассуждениях потолок не ниже 1000.
 * Не заданный reasoning_effort считаем включённым: у Qwen 3 по умолчанию
 * рассуждения есть.
 */
export const REASONING_MIN_TOKENS = 1000;
export function effectiveMaxTokens(model: string, maxTokens: number): number {
  const effort = reasoningEffortFor(model);
  if (effort === 'none') return maxTokens;
  const reasoningCapable = model.startsWith('qwen/') || model.startsWith('openai/gpt-oss-')
    || /deepseek|qwq|r1|reason|think/i.test(model);
  return reasoningCapable ? Math.max(maxTokens, REASONING_MIN_TOKENS) : maxTokens;
}

export interface AiDraft {
  reply: string;
  confidence: number;
  needsHuman: boolean;
  /** Одна короткая фраза: почему такое решение. Обрезается до REASON_MAX. */
  reason: string;
  /** Подсказка оператору. Клиенту не уходит никогда. */
  operatorNote?: string;
  /** В сообщениях нет вопроса: болтовня, благодарность, «ок». */
  noRequest: boolean;
  /** Номера выдержек, на которые модель реально опиралась; 0 — блок «Клиент». */
  used: number[];
  /** Ответ — один короткий уточняющий вопрос, а не совет. */
  clarify?: boolean;
}

export interface CompleteOptions {
  /** Строго эта модель, без перехода на запасную. */
  model?: string;
  /** Черновик ответа клиенту: при AI_JSON_SCHEMA=true просим json_schema. */
  schema?: boolean;
  /** Назначение запроса — для учёта токенов. */
  purpose?: AiPurpose;
}

/** На что ушли токены: ответ клиенту, починка JSON, майнинг, песочница, прогон. */
export type AiPurpose = 'reply' | 'repair' | 'mining' | 'try' | 'eval' | 'other';

export interface AiUsage {
  purpose: AiPurpose;
  model: string;
  prompt: number;
  completion: number;
  /** Токены входа из кэша префикса — у провайдеров, которые это сообщают. */
  cached: number;
}

/**
 * Получатели учёта токенов. Провайдер не знает о базе: index.ts вешает
 * сюда запись в журнал событий. Глобально, потому что AiProvider создают
 * в нескольких местах (ответы, песочница, майнинг).
 */
const usageSinks = new Set<(usage: AiUsage) => void>();
export function onAiUsage(sink: (usage: AiUsage) => void): () => void {
  usageSinks.add(sink);
  return () => usageSinks.delete(sink);
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
}

export function readUsage(raw: RawUsage | undefined, purpose: AiPurpose, model: string): AiUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const n = (value: unknown): number => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);
  const usage: AiUsage = {
    purpose,
    model,
    prompt: n(raw.prompt_tokens),
    completion: n(raw.completion_tokens),
    cached: n(raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens),
  };
  return usage.prompt || usage.completion ? usage : undefined;
}

function reportUsage(usage: AiUsage | undefined): void {
  if (!usage) return;
  for (const sink of usageSinks) {
    try { sink(usage); } catch (err) { log.debug('Учёт токенов не записан', err); }
  }
}

/** Компактный образец контракта — один на промпт и на повтор разбора. */
export const DRAFT_EXAMPLE = '{"reply":"","operator_note":"","reason":"","needs_human":false,"no_request":false,"clarify":false,"used":[],"confidence":0.0}';

/** Схема для response_format=json_schema (только при AI_JSON_SCHEMA=true). */
export const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    operator_note: { type: 'string' },
    reason: { type: 'string' },
    needs_human: { type: 'boolean' },
    no_request: { type: 'boolean' },
    clarify: { type: 'boolean' },
    used: { type: 'array', items: { type: 'integer' } },
    confidence: { type: 'number' },
  },
  required: ['reply', 'needs_human', 'confidence'],
  additionalProperties: false,
} as const;

export class AiProvider {
  private readonly keys: string[];
  private keyIndex = 0;
  /** Ключи, отвергнутые сервером: 401 не лечится ожиданием. */
  private readonly dead = new Set<number>();

  constructor(
    private readonly baseUrl = config.ai.baseUrl,
    keys: string | string[] = config.ai.apiKeys,
    private readonly modelOverride?: string,
    private readonly fallbackOverride?: string,
  ) {
    this.keys = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
    this.lastModel = this.model;
  }

  /** Модель берём из настроек: её меняют из панели без перезапуска. */
  private get model(): string {
    return this.modelOverride ?? runtime.model;
  }

  private get fallbackModel(): string {
    return this.fallbackOverride ?? runtime.fallbackModel;
  }

  /** Замаскированные ключи для панели: показывать целиком нельзя. */
  maskedKeys(): string[] {
    return this.keys.map((key) =>
      key.length <= 10 ? '••••' : `${key.slice(0, 6)}…${key.slice(-4)}`);
  }

  /**
   * Ключ под конкретную модель. У провайдеров лимит считается то на модель,
   * то на аккаунт: если запасная модель ходит тем же ключом, при аккаунтном
   * лимите она не спасает. Поэтому модель можно закрепить за своим ключом.
   */
  private keyFor(model: string): number {
    const bound = model === this.fallbackModel ? runtime.fallbackKey : runtime.modelKey;
    if (bound >= 0 && bound < this.keys.length && !this.dead.has(bound)) return bound;
    return this.keyIndex;
  }

  /** Список моделей у провайдера — для выбора в панели. */
  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${this.keys[this.keyIndex] ?? ''}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { data?: { id?: string }[] };
    return (body.data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string')
      .sort();
  }

  /** Сколько ключей загружено и какой сейчас в работе — для диагностики. */
  keyState(): { total: number; active: number; dead: number } {
    return { total: this.keys.length, active: this.keyIndex + 1, dead: this.dead.size };
  }

  /** Следующий живой ключ. Возвращает false, когда все перебраны. */
  private rotateKey(reason: string): boolean {
    const start = this.keyIndex;
    for (let step = 1; step <= this.keys.length; step += 1) {
      const next = (start + step) % this.keys.length;
      if (this.dead.has(next)) continue;
      if (next === start) break;
      this.keyIndex = next;
      log.warn(`Ключ #${start + 1} ${reason}, перехожу на #${next + 1} из ${this.keys.length}`);
      return true;
    }
    return false;
  }

  /** Какая модель ответила в прошлый раз — нужно для записи в предложку. */
  lastModel: string;

  /**
   * Сырой вызов chat completions. Любой OpenAI-совместимый эндпоинт.
   *
   * 429 на бесплатных тарифах — норма, а не исключение: лимиты там измеряются
   * единицами запросов в минуту. Без повтора предложка молча терялась бы,
   * поэтому ждём столько, сколько просит Retry-After, и пробуем снова.
   */
  async complete(
    messages: ChatMessage[],
    retries = 3,
    maxTokens = config.ai.maxTokens,
    options: CompleteOptions = {},
  ): Promise<string> {
    const primary = this.model;
    const backup = this.fallbackModel;
    const needsVision = hasImageInput(messages);
    const schema = options.schema === true;
    const purpose = options.purpose ?? 'other';

    // Явно названная модель — без цепочки запасных: так делают повтор
    // разбора и переход на запасную, когда основная прислала мусор.
    if (options.model) {
      const answer = await this.request(messages, options.model, retries, maxTokens, schema, purpose);
      this.lastModel = options.model;
      return answer;
    }

    // Позволяет безопасно сделать текстовую модель основной вручную:
    // изображение сразу уйдёт на vision-резерв, если он настроен.
    if (needsVision && !supportsVision(primary)) {
      if (!backup || backup === primary || !supportsVision(backup)) {
        throw new Error(`Ни одна настроенная модель не умеет обрабатывать изображения: ${primary}`);
      }
      const answer = await this.request(messages, backup, retries, maxTokens, schema, purpose);
      this.lastModel = backup;
      return answer;
    }

    try {
      const answer = await this.request(messages, primary, retries, maxTokens, schema, purpose);
      this.lastModel = primary;
      return answer;
    } catch (err) {
      // Запасная страхует лимит, снятие модели, отказ модели принять запрос
      // (4xx) и временный сбой провайдера. Отвергнутый ключ (401/403) — нет:
      // это ошибка настройки, её не маскируем.
      if (!backup || backup === primary || !(err instanceof FallbackEligibleError)) throw err;
      if (needsVision && !supportsVision(backup)) {
        log.warn(`Не отправляю изображение в текстовую запасную модель ${backup}`);
        throw err;
      }
      log.warn(`Основная модель ${primary} недоступна, пробую ${backup}: ${(err as Error).message}`);
      const answer = await this.request(messages, backup, 1, maxTokens, schema, purpose);
      this.lastModel = backup;
      return answer;
    }
  }

  /** Запасная модель, если настроена, — для перехода при неразобранном ответе. */
  fallbackName(): string | undefined {
    return this.fallbackModel || undefined;
  }

  /** Модели, отвергшие json_schema (400): им дальше шлём json_object. */
  private readonly schemaRejected = new Set<string>();

  private async request(
    messages: ChatMessage[],
    model: string,
    retries: number,
    maxTokens: number,
    schema = false,
    purpose: AiPurpose = 'other',
  ): Promise<string> {
    let lastError = 'AI недоступен';
    let rateLimited = false;
    if (!this.keys.length) throw new Error('Ключи AI не заданы');

    // Модель может быть закреплена за своим ключом — начинаем с него.
    this.keyIndex = this.keyFor(model);

    // Ключей может быть несколько: у бесплатных тарифов лимит считается
    // на ключ, и перебрать их быстрее, чем ждать сброса окна.
    const budget = retries + this.keys.length;

    for (let attempt = 0; attempt <= budget; attempt += 1) {
      let response: Response;
      // json_schema поддерживают не все: включается только AI_JSON_SCHEMA=true
      // и только для черновиков ответа (майнинг ждёт другую схему).
      const useSchema = schema && config.ai.jsonSchema && !this.schemaRejected.has(model);
      try {
        const reasoningEffort = reasoningEffortFor(model);
        response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.keys[this.keyIndex]}` },
          body: JSON.stringify({
            model,
            messages,
            temperature: config.ai.temperature,
            max_tokens: effectiveMaxTokens(model, maxTokens),
            response_format: useSchema
              ? { type: 'json_schema', json_schema: { name: 'support_reply', strict: false, schema: DRAFT_SCHEMA } }
              : { type: 'json_object' },
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          }),
          signal: AbortSignal.timeout(config.ai.timeoutMs),
        });
      } catch (err) {
        lastError = `сеть: ${(err as Error).message}`;
        if (attempt === budget) break;
        await delay(backoffMs(attempt));
        continue;
      }

      if (response.ok) {
        const body = (await response.json()) as {
          choices?: { message?: { content?: string }; finish_reason?: string }[];
          usage?: RawUsage;
        };
        reportUsage(readUsage(body.usage, purpose, model));
        const content = body.choices?.[0]?.message?.content;
        // Обрезка по лимиту видна только здесь: дальше это просто «не разобрано».
        if (body.choices?.[0]?.finish_reason === 'length') {
          log.warn(`AI ${model}: ответ обрезан лимитом max_tokens=${effectiveMaxTokens(model, maxTokens)}`);
        }
        if (!content) throw new ProviderUnavailableError('AI вернул пустой ответ');
        return content;
      }

      const text = await response.text().catch(() => '');
      lastError = `HTTP ${response.status}: ${text.slice(0, 300)}`;

      // Ключ отвергнут — ожиданием это не лечится, только заменой.
      if (response.status === 401 || response.status === 403) {
        this.dead.add(this.keyIndex);
        if (this.rotateKey('отвергнут сервером')) continue;
        throw new Error(`AI ответил ${lastError}`);
      }

      if (response.status === 429) {
        rateLimited = true;
        // Пока есть живой запасной ключ, сменить его быстрее, чем ждать окна.
        if (this.keys.length > 1 && this.rotateKey('упёрся в лимит')) continue;
      } else if (useSchema && response.status === 400) {
        // Провайдер не знает json_schema — та же модель, но json_object.
        this.schemaRejected.add(model);
        log.warn(`AI ${model}: json_schema не принят (400), повторяю с json_object`);
        attempt -= 1;
        continue;
      } else if (modelUnavailable(response.status, text)) {
        throw new ModelUnavailableError(lastError);
      } else if (response.status < 500) {
        // Прочие 4xx той же модели повторять бессмысленно. Но причина часто в
        // самой модели (не поддерживает параметр, не справилась с JSON, мал
        // контекст) — поэтому запасная модель получает свою попытку.
        throw new ModelRequestError(`AI ответил ${lastError}`);
      }

      if (attempt === budget) break;

      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 60_000)
        : backoffMs(attempt);
      log.debug(`AI вернул ${response.status}, повтор через ${Math.round(waitMs / 1000)} с`);
      await delay(waitMs);
    }

    if (rateLimited) throw new RateLimitedError(lastError);
    throw new ProviderUnavailableError(lastError);
  }

  /** Расшифровка голосового. Совместимо с /audio/transcriptions у OpenAI и Groq. */
  async transcribe(audio: Buffer, filename: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)]), filename);
    form.append('model', config.transcribe.model);
    form.append('response_format', 'json');

    const response = await fetch(`${config.transcribe.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.transcribe.apiKeys[0]}` },
      body: form,
      signal: AbortSignal.timeout(config.ai.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Расшифровка вернула HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const body = (await response.json()) as { text?: string };
    return body.text?.trim() ?? '';
  }

  /** Проверка доступности провайдера для selfcheck. */
  async ping(): Promise<string> {
    const raw = await this.complete([
      { role: 'system', content: 'Ответь строго JSON: {"ok":true}' },
      { role: 'user', content: 'ping' },
    ]);
    return raw.slice(0, 120);
  }
}

/** reason — служебная фраза для панели, не сочинение. */
export const REASON_MAX = 140;
const OPERATOR_NOTE_MAX = 400;

function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export interface ParsedDraft {
  draft: AiDraft | null;
  /** Строгий JSON.parse не справился, помог терпимый разбор. */
  repaired: boolean;
}

/**
 * Разбор ответа модели. Сначала строго, затем терпимо (repair.ts): кавычки
 * внутри текста, повторённые ключи, висячие запятые, обрыв хвоста. Ничего
 * не выдумываем: обрезанный reply клиенту не годится — тогда null.
 */
export function parseDraftDetailed(raw: string): ParsedDraft {
  const text = stripFences(stripThinking(raw));
  if (!text) return { draft: null, repaired: false };

  let fields: Record<string, unknown> | undefined;
  let truncated = new Set<string>();
  let repaired = false;

  const block = extractJson(text);
  if (block) {
    try {
      const parsed = JSON.parse(block) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
    } catch (err) {
      log.debug('Строгий разбор ответа модели не удался', err);
    }
  }
  // JSON.parse при повторе ключа берёт последнее значение. Если оно пустое,
  // а раньше модель уже написала ответ, — достаём его терпимым разбором.
  const strictEmptyReply = fields && !(typeof fields['reply'] === 'string' && fields['reply'].trim());
  if (!fields || strictEmptyReply) {
    const lenient = lenientParse(text);
    const pairs = lenient?.pairs.length ? lenient.pairs : regexFields(text);
    if (pairs.length) {
      const merged = mergePairs(pairs);
      const replyFound = typeof merged.fields['reply'] === 'string' && (merged.fields['reply'] as string).trim();
      if (!fields || (replyFound && !merged.truncated.has('reply'))) {
        fields = merged.fields;
        truncated = merged.truncated;
        repaired = true;
      }
    }
  }
  if (!fields) return { draft: null, repaired: false };

  const flag = (...names: string[]): boolean => names.some((name) => fields![name] === true || fields![name] === 'true');
  const noRequest = flag('no_request', 'noRequest');
  const needsHuman = flag('needs_human', 'needsHuman');
  // Обрезанный лимитом токенов текст клиенту отправлять нельзя.
  const reply = typeof fields['reply'] === 'string' && !truncated.has('reply') ? fields['reply'].trim() : '';
  if (truncated.has('reply')) return { draft: null, repaired };
  // Пустой reply законен, только когда модель сказала, почему: «обращения
  // нет» или «нужен человек». Иначе это не ответ.
  if (!reply && !noRequest && !needsHuman) return { draft: null, repaired };

  const rawConfidence = Number(fields['confidence']);
  const confidence = Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0;
  const operatorNote = oneLine(fields['operator_note'] ?? fields['operatorNote'], OPERATOR_NOTE_MAX);

  return {
    draft: {
      reply,
      confidence,
      needsHuman,
      reason: oneLine(fields['reason'], REASON_MAX),
      ...(operatorNote ? { operatorNote } : {}),
      noRequest,
      used: Array.isArray(fields['used'])
        ? [...new Set((fields['used'] as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n >= 0))]
        : [],
      clarify: flag('clarify'),
    },
    repaired,
  };
}

export function parseDraft(raw: string): AiDraft | null {
  return parseDraftDetailed(raw).draft;
}

/** Чем закончился разбор: для журнала событий и метрик. */
export type DraftOutcome = 'ok' | 'repaired' | 'retry' | 'fallback' | 'failed';

export interface DraftResult {
  draft: AiDraft | null;
  outcome: DraftOutcome;
  /** Делался ли дополнительный запрос из-за неразобранного ответа. */
  retried: boolean;
}

/** Достаточно для заглушек в тестах: настоящий AiProvider подходит целиком. */
export interface DraftClient {
  lastModel: string;
  complete(messages: ChatMessage[], retries?: number, maxTokens?: number, options?: CompleteOptions): Promise<string>;
  fallbackName?(): string | undefined;
}

/** Сколько сломанного вывода отдаём на починку: бюджет токенов маленький. */
const REPAIR_INPUT_CHARS = 1500;
const REPAIR_MAX_TOKENS = 400;

export function repairMessages(broken: string): ChatMessage[] {
  const cut = stripThinking(broken).slice(0, REPAIR_INPUT_CHARS);
  return [
    {
      role: 'system',
      content: `Перепиши текст ниже в один валидный JSON-объект по схеме ${DRAFT_EXAMPLE}. `
        + 'Каждый ключ один раз, кавычки внутри строк экранируй, reason — одна короткая фраза, '
        + 'смысл и текст reply не меняй. Верни только JSON.',
    },
    { role: 'user', content: cut },
  ];
}

/** Фрагмент сломанного ответа для журнала: коротко в warn, полнее в debug. */
function logBroken(model: string, raw: string): void {
  log.warn(`AI ${model}: ответ не разобран: ${raw.slice(0, 200).replace(/\s+/g, ' ')}`);
  log.debug(`AI ${model}: неразобранный ответ целиком`, raw.slice(0, 4000));
}

/**
 * Запрос черновика с восстановлением. Не разобрали ответ — сначала чиним
 * терпимым разбором, затем ОДИН короткий запрос той же модели «верни
 * валидный JSON», затем запасная модель (если она есть и другая). Только
 * после этого — «не разобрано», и решает человек.
 */
export async function completeDraft(
  provider: DraftClient,
  messages: ChatMessage[],
  purpose: AiPurpose = 'reply',
): Promise<DraftResult> {
  const raw = await provider.complete(messages, undefined, undefined, { schema: true, purpose });
  const first = parseDraftDetailed(raw);
  if (first.draft) return { draft: first.draft, outcome: first.repaired ? 'repaired' : 'ok', retried: false };

  const model = provider.lastModel;
  logBroken(model, raw);

  try {
    const fixed = await provider.complete(repairMessages(raw), 1, REPAIR_MAX_TOKENS, { model, schema: true, purpose: 'repair' });
    const draft = parseDraft(fixed);
    if (draft) return { draft, outcome: 'retry', retried: true };
    logBroken(model, fixed);
  } catch (err) {
    log.warn(`AI ${model}: повтор разбора не удался: ${(err as Error).message}`);
  }

  const backup = provider.fallbackName?.();
  if (backup && backup !== model && (!hasImageInput(messages) || supportsVision(backup))) {
    try {
      const other = await provider.complete(messages, 1, undefined, { model: backup, schema: true, purpose });
      const parsed = parseDraftDetailed(other);
      if (parsed.draft) return { draft: parsed.draft, outcome: 'fallback', retried: true };
      logBroken(backup, other);
    } catch (err) {
      log.warn(`AI ${backup}: запасная модель не ответила: ${(err as Error).message}`);
    }
  }
  return { draft: null, outcome: 'failed', retried: true };
}
