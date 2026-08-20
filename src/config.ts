import { readFileSync } from 'node:fs';

/**
 * Читает .env, если он есть рядом. Уже заданные переменные окружения не
 * трогает: в Docker их подставляет env_file, и файл там просто не нужен.
 * Терпим к тому, как строку могли записать руками — пробелы вокруг '=',
 * кавычки, необязательный export, CR из Windows.
 */
function loadEnvFile(path = process.env['ENV_FILE'] ?? '.env'): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim().replace(/\r$/, '');
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, name, rawValue] = match as unknown as [string, string, string];
    if (process.env[name] !== undefined) continue;
    const value = rawValue.trim().replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1');
    process.env[name] = value;
  }
}

loadEnvFile();

/** Версия из package.json. Печатается везде, где легко нарваться на старый образ. */
export const version: string = (() => {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

function env(name: string, fallback?: string): string {
  const raw = process.env[name]?.trim();
  if (raw) return raw;
  if (fallback !== undefined) return fallback;
  throw new Error(`Не задана обязательная переменная окружения ${name}`);
}

const optional = (name: string): string => process.env[name]?.trim() ?? '';

/**
 * Список ключей из одной переменной: через запятую, пробел или перенос.
 * У бесплатных тарифов лимит на ключ, а не на аккаунт — несколько ключей
 * дают ровно кратный запас без смены провайдера.
 */
const keyList = (name: string): string[] =>
  optional(name).split(/[\s,;]+/).map((key) => key.trim()).filter(Boolean);
const num = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} должно быть числом, а не "${raw}"`);
  return parsed;
};
const bool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on', 'да'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', 'нет'].includes(raw)) return false;
  throw new Error(`${name} должно быть true или false — получено "${raw}"`);
};
const megabytes = (name: string, fallback: number): number => {
  const value = num(name, fallback);
  if (value <= 0) throw new Error(`${name} должно быть больше нуля`);
  return Math.floor(value * 1024 * 1024);
};

export type AiMode = 'off' | 'suggest' | 'auto';

const aiMode = optional('AI_MODE') || 'suggest';
if (!['off', 'suggest', 'auto'].includes(aiMode)) {
  throw new Error(`AI_MODE должен быть off, suggest или auto — получено "${aiMode}"`);
}

export const config = {
  botToken: env('BOT_TOKEN'),
  alertChatId: optional('ALERT_CHAT_ID'),
  // Внешний адрес панели: нужен, чтобы из уведомления можно было сразу
  // открыть нужный диалог, а не искать его руками.
  panelUrl: optional('PANEL_URL'),
  // all — каждое сообщение и каждое действие AI, important — только то,
  // что требует вмешательства, minimal — передачи человеку и просрочки.
  notifyLevel: (['all', 'important', 'minimal'].includes(optional('NOTIFY_LEVEL'))
    ? optional('NOTIFY_LEVEL')
    : 'all') as 'all' | 'important' | 'minimal',

  dbPath: env('DB_PATH', './data/ai-support.db'),
  mediaDir: env('MEDIA_DIR', './data/media'),
  // Ограничения защищают память и диск от бесконечного потока вложений.
  mediaMaxFileBytes: megabytes('MEDIA_MAX_FILE_MB', 25),
  mediaMaxTotalBytes: megabytes('MEDIA_MAX_TOTAL_MB', 1024),
  kbDir: env('KB_DIR', './kb'),
  // Черновики намеренно лежат ВНЕ kb: опубликованные статьи и результаты
  // майнинга не должны смешиваться. Панель может писать в оба каталога, но
  // индексатор читает только корень kb и никогда не подхватывает черновики.
  draftDir: env('DRAFT_DIR', './data/kb-draft'),

  panelPort: num('PANEL_PORT', 8080),
  panelHost: env('PANEL_HOST', '127.0.0.1'),
  panelToken: env('PANEL_TOKEN'),

  bedolaga: {
    enabled: bool('BEDOLAGA_ENABLED', false),
    url: optional('BEDOLAGA_API_URL'),
    token: optional('BEDOLAGA_API_TOKEN'),
    pollSeconds: num('BEDOLAGA_POLL_SECONDS', 60),
    language: env('BEDOLAGA_FAQ_LANGUAGE', 'ru'),
  },

  supportApi: {
    enabled: bool('SUPPORT_API_ENABLED', false),
    url: optional('SUPPORT_API_URL'),
    token: optional('SUPPORT_API_TOKEN'),
    userPath: env('SUPPORT_API_USER_PATH', '/api/support/user_info'),
  },

  remnawave: {
    enabled: bool('REMNAWAVE_ENABLED', false),
    url: optional('REMNAWAVE_URL'),
    token: optional('REMNAWAVE_TOKEN'),
    // Запрет разрушающих действий на уровне кода. Даже получив доступ к
    // панели, сбросить устройства или перевыпустить подписку нельзя.
    readOnly: bool('REMNAWAVE_READONLY', true),
  },

  nodes: {
    // Состояние узлов для ответов вида «всё ли в порядке с Германией».
    enabled: bool('NODES_STATUS_ENABLED', false),
    pollSeconds: num('NODES_POLL_SECONDS', 120),
    // Слепок старше этого срока модель обязана считать отсутствующим.
    staleMinutes: num('NODES_STALE_MINUTES', 15),
  },

  ai: {
    mode: aiMode as AiMode,
    baseUrl: env('AI_BASE_URL', 'https://api.moonshot.ai/v1'),
    apiKeys: keyList('AI_API_KEY'),
    model: env('AI_MODEL', 'kimi-k2-0905-preview'),
    // Лимиты у провайдеров считаются на каждую модель отдельно, поэтому
    // запасная — это не только страховка, но и второй суточный бюджет.
    fallbackModel: optional('AI_MODEL_FALLBACK'),
    // 'none' у Qwen полностью выключает рассуждения. На бесплатных тарифах
    // это принципиально: токены размышлений тратят тот же дневной лимит.
    reasoningEffort: optional('AI_REASONING_EFFORT'),
    temperature: num('AI_TEMPERATURE', 0.3),
    maxTokens: num('AI_MAX_TOKENS', 700),
    timeoutMs: num('AI_TIMEOUT_MS', 45000),
    minConfidence: num('AI_MIN_CONFIDENCE', 0.75),
    // Предохранитель от зацикливания в одном диалоге, не общий лимит.
    // 0 — без предела.
    autoPerHour: num('AI_AUTO_PER_HOUR', 12),
    humanHoldMinutes: num('AI_HUMAN_HOLD_MINUTES', 30),
    kbLimit: num('AI_KB_LIMIT', 5),
    kbChars: num('AI_KB_CHARS', 1200),
    // Потолок содержимого одного запроса при майнинге. Считается против TPM
    // провайдера: у Groq на qwen это 8K токенов в минуту, и один жирный
    // запрос упирается в лимит целиком.
    mineBudgetTokens: num('AI_MINE_BUDGET_TOKENS', 4500),
    // Отдельный потолок ответа: 700 токенов хватает на одну реплику клиенту,
    // но не на пачку статей — модель начинает ужимать их до огрызков.
    mineMaxTokens: num('AI_MINE_MAX_TOKENS', 3500),
    minePaceMs: num('AI_MINE_PACE_MS', 20000),
    historyLimit: num('AI_HISTORY_LIMIT', 12),
    maxAgeMinutes: num('AI_MAX_AGE_MINUTES', 60),
    // Пауза перед разбором: клиент дописывает мысль в несколько сообщений.
    debounceSeconds: num('AI_DEBOUNCE_SECONDS', 12),
    handoffMessage: env('AI_HANDOFF_MESSAGE',
      'Передал ваш вопрос специалисту — он ответит здесь же. Пожалуйста, дождитесь ответа.'),
    handoffRepeatMinutes: num('AI_HANDOFF_REPEAT_MINUTES', 60),
    brand: env('AI_BRAND', 'Поддержка'),
    replyStyle: env('AI_REPLY_STYLE',
      'Пиши сплошным текстом в два-три предложения. Нумерованные и маркированные списки не используй: ' +
      'если шагов несколько, объедини их в связную фразу. Обращайся на «вы», без канцелярита и без извинений.'),
    // Нет опоры в базе знаний — ответ не уходит клиенту сам, ни в каком режиме.
    requireKb: bool('AI_REQUIRE_KB', true),
    vision: bool('AI_VISION', false),
    // Адреса, которые AI разрешено называть клиенту: сайт, страница подписки.
    allowedDomains: env('AI_ALLOWED_DOMAINS', '').split(/[\s,;]+/).filter(Boolean),
  },

  transcribe: {
    enabled: bool('TRANSCRIBE_ENABLED', false),
    baseUrl: optional('TRANSCRIBE_BASE_URL'),
    apiKeys: keyList('TRANSCRIBE_API_KEY'),
    model: env('TRANSCRIBE_MODEL', 'whisper-large-v3-turbo'),
  },

  sla: {
    firstResponseMinutes: num('SLA_FIRST_RESPONSE_MINUTES', 30),
    checkSeconds: num('SLA_CHECK_SECONDS', 120),
    maxAgeHours: num('SLA_MAX_AGE_HOURS', 24),
    maxAlertsPerCycle: num('SLA_MAX_ALERTS_PER_CYCLE', 5),
  },

  logLevel: (optional('LOG_LEVEL') || 'info') as Level,
};

if (config.panelToken.length < 16) {
  throw new Error('PANEL_TOKEN короче 16 символов — панель будет открыта наружу практически без защиты');
}

// Заголовок Authorization — ByteString: кириллица и эмодзи в нём физически
// не передаются, браузер упадёт на fetch. Ловим на старте, а не в проде.
if (!/^[\x21-\x7E]+$/.test(config.panelToken)) {
  throw new Error(
    'PANEL_TOKEN должен состоять только из ASCII без пробелов. Сгенерируй: openssl rand -hex 32',
  );
}

if (config.bedolaga.enabled && !(config.bedolaga.url && config.bedolaga.token)) {
  throw new Error('BEDOLAGA_ENABLED=true, но не заданы BEDOLAGA_API_URL и BEDOLAGA_API_TOKEN');
}

if (config.ai.mode !== 'off' && !config.ai.apiKeys.length) {
  throw new Error(`AI_MODE=${config.ai.mode}, но AI_API_KEY пуст`);
}

if (config.remnawave.enabled && !(config.remnawave.url && config.remnawave.token)) {
  throw new Error('REMNAWAVE_ENABLED=true, но не заданы REMNAWAVE_URL и REMNAWAVE_TOKEN');
}

if (config.transcribe.enabled && !(config.transcribe.baseUrl && config.transcribe.apiKeys.length)) {
  throw new Error('TRANSCRIBE_ENABLED=true, но не заданы TRANSCRIBE_BASE_URL и TRANSCRIBE_API_KEY');
}

if (config.supportApi.enabled && !(config.supportApi.url && config.supportApi.token)) {
  throw new Error('SUPPORT_API_ENABLED=true, но не заданы SUPPORT_API_URL и SUPPORT_API_TOKEN');
}

const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level: Level, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  extra === undefined ? out(line) : out(line, extra);
}

export const log = {
  debug: (m: string, e?: unknown) => emit('debug', m, e),
  info: (m: string, e?: unknown) => emit('info', m, e),
  warn: (m: string, e?: unknown) => emit('warn', m, e),
  error: (m: string, e?: unknown) => emit('error', m, e),
};
