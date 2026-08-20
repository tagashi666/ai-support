import { config, log } from '../config.js';
import { runtime } from '../core/settings.js';

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
  const text = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
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

export class RateLimitedError extends Error {
  constructor(detail: string) {
    super(`Лимит провайдера исчерпан: ${detail}`);
    this.name = 'RateLimitedError';
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const backoffMs = (attempt: number): number => Math.min(2000 * 2 ** attempt, 30_000);

export interface AiDraft {
  reply: string;
  confidence: number;
  needsHuman: boolean;
  reason: string;
  /** В сообщениях нет вопроса: болтовня, благодарность, «ок». */
  noRequest: boolean;
  /** Номера выдержек, на которые модель реально опиралась. */
  used: number[];
}

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
  async complete(messages: ChatMessage[], retries = 3, maxTokens = config.ai.maxTokens): Promise<string> {
    try {
      const answer = await this.request(messages, this.model, retries, maxTokens);
      this.lastModel = this.model;
      return answer;
    } catch (err) {
      // Дневной лимит модели исчерпан — у запасной он свой собственный.
      if (!this.fallbackModel || !(err instanceof RateLimitedError)) throw err;
      log.warn(`Модель ${this.model} упёрлась в лимит, пробую ${this.fallbackModel}`);
      const answer = await this.request(messages, this.fallbackModel, 1, maxTokens);
      this.lastModel = this.fallbackModel;
      return answer;
    }
  }

  private async request(messages: ChatMessage[], model: string, retries: number, maxTokens: number): Promise<string> {
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
      try {
        response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.keys[this.keyIndex]}` },
          body: JSON.stringify({
            model,
            messages,
            temperature: config.ai.temperature,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' },
            ...(config.ai.reasoningEffort ? { reasoning_effort: config.ai.reasoningEffort } : {}),
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
        const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
        const content = body.choices?.[0]?.message?.content;
        if (!content) throw new Error('AI вернул пустой ответ');
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
      } else if (response.status < 500) {
        // Прочие 4xx повторять бессмысленно: неверная модель, лимит токенов.
        throw new Error(`AI ответил ${lastError}`);
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
    throw new Error(`AI ответил ${lastError}`);
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

/**
 * Модели периодически заворачивают JSON в ```json и добавляют пояснения.
 * Разбираем терпимо, но без выдумывания: не распарсилось — значит не распарсилось.
 */
export function parseDraft(raw: string): AiDraft | null {
  const block = extractJson(stripThinking(raw));
  if (!block) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(block) as Record<string, unknown>;
  } catch (err) {
    log.debug('Не удалось разобрать ответ модели', err);
    return null;
  }

  const reply = typeof parsed['reply'] === 'string' ? parsed['reply'].trim() : '';
  // При no_request текста ответа может не быть вовсе — это нормально.
  if (!reply && parsed['no_request'] !== true && parsed['noRequest'] !== true) return null;

  const rawConfidence = Number(parsed['confidence']);
  const confidence = Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0;

  return {
    reply,
    confidence,
    needsHuman: parsed['needs_human'] === true || parsed['needsHuman'] === true,
    reason: typeof parsed['reason'] === 'string' ? parsed['reason'] : '',
    noRequest: parsed['no_request'] === true || parsed['noRequest'] === true,
    used: Array.isArray(parsed['used'])
      ? (parsed['used'] as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [],
  };
}
