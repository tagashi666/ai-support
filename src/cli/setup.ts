/**
 * Мастер первой настройки. Запускается ВНУТРИ образа (install.sh делает это
 * сам), чтобы сетевые проверки шли из той же docker-сети, что и бот:
 *
 *   docker compose run --rm --no-deps --user "$(id -u):$(id -g)" -v "$PWD:/setup" \
 *     ai-support node dist/cli/setup.js --dir /setup --facts /setup/.setup-facts.json
 *
 *   --check           только проверки по текущему .env, ничего не пишет
 *   --answers FILE    ответы из JSON вместо вопросов (тесты, автоматизация)
 *
 * Мастер трогает только свои ключи .env: остальные строки, комментарии и
 * порядок сохраняются, перед записью делается бэкап .env.bak-*.
 * config.ts здесь не импортируется: он требует заполненного .env.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { diagnoseError, explainError, probeUrl, type ProbeResult } from '../core/netdiag.js';
import {
  backupName, findBedolaga, findCloudflared, isOurOverride, joinableNetworks, mask, nearestFreePort,
  parseEnv, parseFacts, parseOurOverride, portOwner, renderOverride, renderOverrideBody, updateEnvText,
  type FactContainer, type HostFacts, type OverridePlan,
} from './setupfiles.js';

// Умолчания совпадают с src/config.ts и PROVIDERS.md.
const GROQ_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'qwen/qwen3.8-27b';
const DEFAULT_FALLBACK = 'openai/gpt-oss-120b';
const PROVIDERS = [
  { key: 'groq', label: 'Groq (есть бесплатный тариф)', url: GROQ_URL, model: DEFAULT_MODEL },
  { key: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-r1:free' },
  { key: 'custom', label: 'свой OpenAI-совместимый URL', url: '', model: '' },
] as const;
const AI_MODES = ['off', 'shadow', 'suggest', 'auto'];
const TELEGRAM_API = 'https://api.telegram.org';
const CONTAINER = 'ai-support';

// --- ввод ---------------------------------------------------------------

export interface Prompter {
  readonly interactive: boolean;
  ask(id: string, question: string, def?: string): Promise<string>;
  secret(id: string, question: string): Promise<string>;
  close(): void;
}

/** Ответы из JSON: ключ — id вопроса. Нет ответа — умолчание. */
export function answersPrompter(answers: Record<string, unknown>, out: (line: string) => void): Prompter {
  const pick = (id: string, def = ''): string => {
    const value = answers[id];
    if (value === undefined || value === null) return def;
    if (typeof value === 'boolean') return value ? 'y' : 'n';
    return String(value);
  };
  return {
    interactive: false,
    async ask(id, question, def) {
      const value = pick(id, def);
      out(`${question}${def ? ` [${def}]` : ''}: ${value}`);
      return value;
    },
    async secret(id, question) {
      const value = pick(id);
      out(`${question}: ${value ? mask(value) : ''}`);
      return value;
    },
    close() {},
  };
}

function terminalPrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  let closed = false;
  const closing = new Promise<string>((resolve) => rl.once('close', () => { closed = true; resolve(''); }));
  // Скрытый ввод: пока muted, readline ничего не печатает. Внутренний
  // _writeToOutput — общепринятый способ, другого в readline нет.
  let muted = false;
  const internal = rl as unknown as { _writeToOutput?: (text: string) => void };
  const original = internal._writeToOutput?.bind(rl);
  const canMask = Boolean(original && process.stdin.isTTY);
  if (original) internal._writeToOutput = (text: string) => { if (!muted) original(text); };

  const question = async (text: string): Promise<string> => {
    if (closed) return '';
    return (await Promise.race([rl.question(text), closing])).trim();
  };
  return {
    interactive: true,
    async ask(_id, text, def) {
      const value = await question(`${text}${def ? ` [${def}]` : ''}: `);
      return value || def || '';
    },
    async secret(_id, text) {
      if (!canMask) return question(`${text}: `);
      process.stdout.write(`${text} (ввод скрыт): `);
      muted = true;
      try {
        return await question('');
      } finally {
        muted = false;
        process.stdout.write('\n');
      }
    },
    close() { rl.close(); },
  };
}

const isYes = (value: string): boolean => /^(y|yes|д|да|1|true)$/i.test(value.trim());

async function yesNo(io: Prompter, id: string, text: string, def: boolean): Promise<boolean> {
  const value = await io.ask(id, `${text} (y/n)`, def ? 'y' : 'n');
  return value ? isYes(value) : def;
}

async function choose(io: Prompter, id: string, text: string, options: string[], def: number, out: Out): Promise<number> {
  out(text);
  options.forEach((label, index) => out(`  ${index + 1}) ${label}`));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = await io.ask(id, 'Номер', String(def));
    const number = Number(value);
    if (Number.isInteger(number) && number >= 1 && number <= options.length) return number;
    out(`  Введите число от 1 до ${options.length}.`);
    if (!io.interactive) break;
  }
  return def;
}

type Out = (line: string) => void;

// --- Telegram -----------------------------------------------------------

interface TgReply<T> { ok: boolean; result?: T; error_code?: number; description?: string }

async function telegram<T>(token: string, method: string, params: Record<string, unknown> = {}): Promise<TgReply<T>> {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({})) as TgReply<T>;
  return { ...body, ok: Boolean(body.ok), error_code: body.error_code ?? (response.ok ? undefined : response.status) };
}

/** 409 от getUpdates человеческим текстом. */
export function explainConflict(description = ''): string {
  if (/webhook/i.test(description)) {
    return 'У бота включён webhook, поэтому getUpdates недоступен. ai-support работает без webhook. '
      + 'Если этот токен не используется другой программой, снимите webhook: '
      + 'curl "https://api.telegram.org/bot<ТОКЕН>/deleteWebhook" — и повторите.';
  }
  return 'Бот с этим токеном уже запущен где-то ещё (409 Conflict): Telegram отдаёт сообщения только одному процессу. '
    + 'Остановите работающий ai-support (docker compose stop ai-support) или другую программу с этим токеном '
    + 'и повторите, либо введите id чата вручную.';
}

export interface FoundChat { id: number; label: string }

interface TgChat { id: number; type: string; title?: string; first_name?: string; last_name?: string; username?: string }

function chatLabel(chat: TgChat): string {
  const name = chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(' ');
  const user = chat.username ? ` @${chat.username}` : '';
  const kind = chat.type === 'private' ? 'личка' : chat.type === 'channel' ? 'канал' : 'группа';
  return `${kind}: ${name || '—'}${user} (${chat.id})`;
}

/**
 * Чаты из getUpdates. offset не передаём: так обновления не подтверждаются,
 * и сообщения клиентов, пришедшие до запуска бота, бот потом всё равно увидит.
 */
export async function findChats(token: string, waitMs = 60_000, pollMs = 2000): Promise<{ chats: FoundChat[]; error?: string }> {
  const chats = new Map<number, FoundChat>();
  const deadline = Date.now() + waitMs;
  let quietPolls = 0;
  for (;;) {
    let reply: TgReply<Array<Record<string, { chat?: TgChat }>>>;
    try {
      reply = await telegram(token, 'getUpdates', {
        timeout: 0, limit: 100,
        allowed_updates: ['message', 'channel_post', 'my_chat_member', 'business_message'],
      });
    } catch (err) {
      return { chats: [...chats.values()], error: explainError(err, TELEGRAM_API) };
    }
    if (reply.error_code === 409) return { chats: [...chats.values()], error: explainConflict(reply.description) };
    if (!reply.ok) return { chats: [...chats.values()], error: `Telegram: ${reply.description ?? `HTTP ${reply.error_code}`}` };
    const before = chats.size;
    for (const update of reply.result ?? []) {
      for (const part of Object.values(update)) {
        const chat = part && typeof part === 'object' ? (part as { chat?: TgChat }).chat : undefined;
        if (chat && typeof chat.id === 'number') chats.set(chat.id, { id: chat.id, label: chatLabel(chat) });
      }
    }
    // Нашли и следующий опрос ничего не добавил — человек, скорее всего, закончил.
    quietPolls = chats.size > before ? 0 : quietPolls + 1;
    if ((chats.size && quietPolls >= 1) || Date.now() + pollMs > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { chats: [...chats.values()] };
}

async function checkBotToken(token: string): Promise<{ ok: boolean; text: string }> {
  try {
    const reply = await telegram<{ username?: string }>(token, 'getMe');
    if (reply.ok) return { ok: true, text: `@${reply.result?.username ?? '?'}` };
    if (reply.error_code === 401 || reply.error_code === 404) {
      return { ok: false, text: 'Telegram не принял токен — скопируйте его заново из @BotFather' };
    }
    return { ok: false, text: `Telegram: ${reply.description ?? `HTTP ${reply.error_code}`}` };
  } catch (err) {
    return { ok: false, text: explainError(err, TELEGRAM_API) };
  }
}

// --- состояние мастера --------------------------------------------------

interface State {
  dir: string;
  envText: string;
  env: Record<string, string>;
  facts: HostFacts;
  updates: Record<string, string | null>;
  plan: OverridePlan;
  notes: string[];
  out: Out;
  io: Prompter;
  /** Порт, на котором панель будет на хосте. */
  port: number;
}

const current = (state: State, key: string): string => {
  const updated = state.updates[key];
  return updated === undefined ? state.env[key] ?? '' : updated ?? '';
};

function set(state: State, key: string, value: string | null): void {
  state.updates[key] = value;
}

function addNetwork(state: State, name: string, external: boolean): void {
  if (!state.plan.networks.some((net) => net.name === name)) state.plan.networks.push({ name, external });
}

/** Подключение к контейнеру по имени: общая сеть или (для bridge) своя сеть плюс docker network connect. */
function planNetworkTo(state: State, container: FactContainer, purpose: string): void {
  const nets = joinableNetworks(container);
  if (nets.length) {
    addNetwork(state, nets[0]!, true);
    state.out(`  ai-support будет подключён к сети ${nets[0]} (docker-compose.override.yml).`);
    return;
  }
  // В сети bridge по умолчанию имена контейнеров не резолвятся: нужна своя сеть.
  addNetwork(state, 'ai-support-shared', false);
  const command = `docker network connect ai-support-shared ${container.name}`;
  state.out(`  ${container.name} в сети bridge, где имена не резолвятся. Сеть ai-support-shared создаст наш compose;`);
  state.out(`  после запуска выполните: ${command}`);
  state.notes.push(`${purpose}: после запуска выполните ${command} (и добавьте эту сеть в compose ${container.name}, иначе после пересоздания связь пропадёт)`);
}

const SAVE_ANYWAY = 'Сохранить всё равно';

/** Печать результата пошаговой проверки и вердикт. */
function printProbe(out: Out, result: ProbeResult): void {
  for (const step of result.steps) out(`    ${step}`);
  if (result.ok) out('  ok  отвечает');
  else if (result.diagnosis) {
    out(`  !!  ${result.diagnosis.message}`);
    if (result.diagnosis.hint) out(`      ${result.diagnosis.hint}`);
  }
}

function bedolagaClosedPortHelp(out: Out, url: string): void {
  let port = '8080';
  try { port = new URL(url).port || port; } catch { /* оставим 8080 */ }
  out('      Частая причина: на сервере Бедолаги WEB_API_BIND=127.0.0.1 — API опубликован только локально.');
  out('      Варианты (выполняются на сервере Бедолаги):');
  out('       а) обратный прокси с HTTPS (рекомендуется), например Caddy:');
  out(`            api.example.com { reverse_proxy 127.0.0.1:${port} }`);
  out('          и BEDOLAGA_API_URL=https://api.example.com');
  out('       б) открыть порт только для этого сервера: в .env Бедолаги WEB_API_BIND=0.0.0.0,');
  out('          docker compose up -d, затем (203.0.113.10 — IP этого сервера):');
  out(`            iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport ${port} ! -s 203.0.113.10 -j DROP`);
  out('          правило сохраните (iptables-persistent), иначе оно пропадёт после перезагрузки.');
  out('       в) SSH-туннель с этого сервера (autossh -L) — если нет домена.');
}

/** Общий цикл для интеграций: проверить, при ошибке — повторить, сохранить или пропустить. */
async function verifyIntegration(
  state: State,
  idPrefix: string,
  probe: () => Promise<ProbeResult>,
  onFailure: (result: ProbeResult) => Promise<void>,
): Promise<'ok' | 'save' | 'retry' | 'skip'> {
  const result = await probe();
  printProbe(state.out, result);
  if (result.ok) return 'ok';
  await onFailure(result);
  // DNS чинится override-ом: после него адрес заработает, сохраняем.
  if (result.diagnosis?.kind === 'dns-docker' && state.plan.dns) return 'save';
  const options = ['Ввести адрес и токен заново', SAVE_ANYWAY, 'Пропустить (ничего не менять)'];
  const choice = await choose(state.io, `${idPrefix}OnError`, 'Что делаем?', options, state.io.interactive ? 1 : 2, state.out);
  return choice === 1 ? 'retry' : choice === 2 ? 'save' : 'skip';
}

// --- шаги ---------------------------------------------------------------

async function stepTelegram(state: State): Promise<void> {
  const { out, io } = state;
  out('\n[1/6] Telegram');
  if (state.env['TELEGRAM_BOTS_JSON']) {
    out('  Боты заданы через TELEGRAM_BOTS_JSON — этот шаг пропускаю, правьте .env вручную.');
    return;
  }
  const existing = state.env['BOT_TOKEN'] ?? '';
  let token = existing;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    out(existing
      ? `  Токен бота: сейчас ${mask(existing)}. Enter — оставить.`
      : '  Токен бота из @BotFather. Enter — пропустить (панель работает и без Telegram).');
    const entered = await io.secret('botToken', '  BOT_TOKEN');
    token = entered || existing;
    if (!token) { out('  Telegram пропущен.'); return; }
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
      out('  !!  Не похоже на токен Telegram. Формат: 1234567890:AA…');
      if (!io.interactive) return;
      continue;
    }
    const check = await checkBotToken(token);
    out(check.ok ? `  ok  бот ${check.text}` : `  !!  ${check.text}`);
    if (check.ok || !io.interactive) break;
  }
  if (token !== existing) set(state, 'BOT_TOKEN', token);

  const alert = state.env['ALERT_CHAT_ID'] ?? '';
  out('\n  Чат для уведомлений (просрочки, передачи человеку).');
  const choice = await choose(io, 'alertChatMode', '  Как указать ALERT_CHAT_ID?', [
    'Найти автоматически: напишите что-нибудь боту или добавьте его в группу и напишите там',
    'Ввести id вручную',
    alert ? `Оставить текущий (${alert})` : 'Пропустить',
  ], alert ? 3 : 1, out);
  if (choice === 3) return;
  if (choice === 1) {
    out('  Жду сообщение до 60 секунд…');
    const found = await findChats(token, Number(process.env['SETUP_CHAT_WAIT_MS'] ?? 60_000));
    if (found.error) out(`  !!  ${found.error}`);
    if (found.chats.length) {
      const options = [...found.chats.map((chat) => chat.label), 'Ввести вручную'];
      const picked = await choose(io, 'alertChatPick', '  Найденные чаты:', options, 1, out);
      if (picked <= found.chats.length) {
        set(state, 'ALERT_CHAT_ID', String(found.chats[picked - 1]!.id));
        return;
      }
    } else if (!found.error) {
      out('  Сообщений не пришло. Можно ввести id вручную (у группы он начинается с -100).');
    }
  }
  const manual = await io.ask('alertChatId', '  ALERT_CHAT_ID', alert);
  if (manual && !/^-?\d+$|^@[A-Za-z0-9_]{4,}$/.test(manual)) out('  !!  id чата — число (группы: -100…) или @имя канала; записываю как есть.');
  if (manual && manual !== alert) set(state, 'ALERT_CHAT_ID', manual);
}

async function stepAi(state: State): Promise<void> {
  const { out, io } = state;
  out('\n[2/6] AI (необязательно)');
  const existingKey = state.env['AI_API_KEY'] ?? '';
  const options = [...PROVIDERS.map((item) => item.label), existingKey ? 'Оставить как есть' : 'Пропустить (AI выключен)'];
  const choice = await choose(io, 'aiProvider', '  Провайдер:', options, existingKey ? options.length : 1, out);
  if (choice === options.length) return;
  const provider = PROVIDERS[choice - 1]!;
  let base: string = provider.url;
  if (provider.key === 'custom') {
    base = (await io.ask('aiBaseUrl', '  Базовый URL (…/v1)', state.env['AI_BASE_URL'] ?? '')).replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) { out('  !!  Нужен полный URL. AI пропущен.'); return; }
  }
  const key = (await io.secret('aiKey', '  Ключ API (Enter — оставить текущий)')) || existingKey;
  if (!key) { out('  Ключ не задан — AI пропущен.'); return; }

  out('  Проверяю ключ…');
  const result = await probeUrl(`${base}/models`, { headers: { authorization: `Bearer ${key.split(',')[0]!.trim()}` } });
  printProbe(out, result);
  const models = result.ok
    ? ((result.body as { data?: Array<{ id?: string }> })?.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id)).sort()
    : [];
  if (!result.ok && !(await yesNo(io, 'aiSaveOnError', '  Сохранить ключ, несмотря на ошибку?', false))) return;

  const preferred = provider.model || state.env['AI_MODEL'] || '';
  const def = models.includes(preferred) ? preferred : preferred || models[0] || '';
  if (models.length) {
    const shown = [def, ...models.filter((id) => id !== def)].filter(Boolean).slice(0, 25);
    out(`  Доступно моделей: ${models.length}. Первые:`);
    shown.forEach((id, index) => out(`    ${index + 1}) ${id}`));
  }
  let model = await io.ask('aiModel', '  Модель (номер или имя)', def);
  const asNumber = Number(model);
  if (models.length && Number.isInteger(asNumber) && asNumber >= 1) {
    const shown = [def, ...models.filter((id) => id !== def)].filter(Boolean);
    model = shown[asNumber - 1] ?? def;
  }
  if (models.length && model && !models.includes(model)) out(`  !!  ${model} нет в списке провайдера — проверьте имя.`);

  const mode = (await io.ask('aiMode', `  Режим AI (${AI_MODES.join('/')}): suggest — черновик, отправляет человек`, state.env['AI_MODE'] || 'suggest')).toLowerCase();

  set(state, 'AI_API_KEY', key);
  if (base !== GROQ_URL || state.env['AI_BASE_URL']) set(state, 'AI_BASE_URL', base);
  if (model && (model !== DEFAULT_MODEL || state.env['AI_MODEL'])) set(state, 'AI_MODEL', model);
  if (model && model !== DEFAULT_MODEL && models.length && !models.includes(DEFAULT_FALLBACK)) {
    // Запасной модели по умолчанию у этого провайдера нет — пусть страхует та же.
    set(state, 'AI_MODEL_FALLBACK', model);
  }
  if (model && model !== DEFAULT_MODEL && !(state.env['AI_VISION_MODELS'] ?? '').includes(model)) {
    // Иначе selfcheck справедливо упадёт: основная модель не в списке vision.
    set(state, 'AI_VISION', 'false');
    state.notes.push('Распознавание фото выключено (AI_VISION=false): если модель понимает изображения, задайте AI_VISION_MODELS и уберите AI_VISION');
  }
  if (AI_MODES.includes(mode) && (mode !== 'suggest' || state.env['AI_MODE'])) set(state, 'AI_MODE', mode);
  if (mode === 'auto') out('  !!  auto отправляет ответы клиентам без подтверждения — начинать стоит с suggest.');
  state.notes.push('Модель и режим AI потом меняются в панели → Настройки; после сохранения там .env для них уже не главный');
}

async function stepPanel(state: State): Promise<void> {
  const { out, io, facts } = state;
  out('\n[3/6] Панель оператора');
  const bind = state.env['PANEL_BIND'] || '127.0.0.1';
  const legacyPort = Number(state.env['PANEL_PORT']);
  if (state.env['PANEL_PORT'] || state.env['PANEL_HOST']) {
    out('  В .env заданы PANEL_PORT/PANEL_HOST — в Docker они не действуют (внутри всегда 8080).');
    out('  Внешний порт теперь PANEL_PUBLISH_PORT; старые ключи закомментирую.');
    if (state.env['PANEL_PORT']) set(state, 'PANEL_PORT', null);
    if (state.env['PANEL_HOST']) set(state, 'PANEL_HOST', null);
  }
  let wanted = Number(state.env['PANEL_PUBLISH_PORT']) || (legacyPort && legacyPort !== 8080 ? legacyPort : 8080);
  if (facts.missing) out('  Факты хоста не собраны (мастер запущен не через install.sh) — занятость порта не проверяю.');

  let port = wanted;
  let lastBusy = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const owner = facts.missing ? null : portOwner(facts, wanted, bind, CONTAINER);
    const suggestion = owner && !owner.ours ? nearestFreePort(facts, wanted + 1, bind, CONTAINER) : wanted;
    if (owner && !owner.ours) out(`  Порт ${wanted} на хосте занят: ${owner.owner}. Ближайший свободный: ${suggestion}.`);
    const entered = Number(await io.ask('panelPort', '  Порт панели на хосте', String(suggestion)));
    if (!Number.isInteger(entered) || entered < 1 || entered > 65535) { out('  Нужен номер порта 1–65535.'); continue; }
    const enteredOwner = facts.missing ? null : portOwner(facts, entered, bind, CONTAINER);
    port = entered;
    if (!enteredOwner || enteredOwner.ours) break;
    // Второй раз тот же занятый порт — человек знает, что делает.
    if (lastBusy === entered || !io.interactive) { out(`  !!  Порт ${entered} занят (${enteredOwner.owner}) — запуск упадёт, пока его не освободить.`); break; }
    lastBusy = entered;
    wanted = entered;
  }
  state.port = port;
  if (port !== 8080 || state.env['PANEL_PUBLISH_PORT']) set(state, 'PANEL_PUBLISH_PORT', String(port));

  const cloudflared = findCloudflared(facts);
  const access = await choose(io, 'panelAccess', '  Как будете открывать панель?', [
    'Только с сервера / через SSH-туннель',
    `Cloudflare Tunnel${cloudflared ? ` (нашёл контейнер ${cloudflared.name})` : ''}`,
    'Свой домен через nginx или Caddy',
  ], cloudflared ? 2 : 1, out);

  if (access === 1) {
    out('  С вашего компьютера:');
    out(`    ssh -N -L 8080:127.0.0.1:${port} root@<IP-сервера>`);
    out('  и откройте http://localhost:8080');
  } else if (access === 2) {
    if (cloudflared?.networkMode === 'host') {
      out(`  cloudflared работает с network_mode: host. В туннеле (Zero Trust → Networks → Tunnels → Public hostname)`);
      out(`  укажите Service: http://localhost:${port}`);
    } else if (cloudflared) {
      if (await yesNo(io, 'cloudflaredJoin', `  Подключить ai-support к сети ${cloudflared.name}, чтобы туннель ходил по имени?`, true)) {
        planNetworkTo(state, cloudflared, 'Cloudflare Tunnel');
        out('  В туннеле (Public hostname) укажите Service: http://ai-support:8080');
      } else {
        out(`  Тогда cloudflared должен видеть хост: network_mode: host и Service http://localhost:${port}.`);
      }
    } else {
      out('  Контейнер cloudflared не найден. Варианты:');
      out('    — cloudflared в docker на этом сервере в общей сети с ai-support: Service http://ai-support:8080');
      out(`    — cloudflared с network_mode: host или как служба systemd: Service http://localhost:${port}`);
    }
    out('  Панель защищена только токеном — включите Cloudflare Access (Zero Trust → Access → Applications)');
    out('  с политикой по вашей почте: тогда чужие не дойдут даже до формы входа.');
  } else {
    out('  Caddy (сертификат получит сам):');
    out(`    support.example.com { reverse_proxy 127.0.0.1:${port} }`);
    out('  nginx (нужны заголовки для WebSocket), полный пример — DEPLOY.md, раздел 5:');
    out(`    location / { proxy_pass http://127.0.0.1:${port}; proxy_http_version 1.1;`);
    out('      proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_set_header Host $host; }');
  }

  out('\n  PANEL_URL — внешний адрес ЭТОЙ панели (не Remnawave). По нему в уведомлениях');
  out('  будет ссылка прямо на диалог. Пример: https://support.example.com. Enter — без ссылок.');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const url = (await io.ask('panelUrl', '  PANEL_URL', state.env['PANEL_URL'] ?? '')).replace(/\/+$/, '');
    if (!url || /^https?:\/\/[^\s/]+/.test(url)) {
      if (url !== (state.env['PANEL_URL'] ?? '')) set(state, 'PANEL_URL', url);
      break;
    }
    out('  Нужен адрес вида https://support.example.com');
    if (!io.interactive) break;
  }

  const token = state.env['PANEL_TOKEN'] ?? '';
  if (token.length >= 16 && /^[\x21-\x7E]+$/.test(token)) {
    out(`  PANEL_TOKEN уже есть (${mask(token)}) — оставляю.`);
  } else {
    set(state, 'PANEL_TOKEN', randomBytes(32).toString('hex'));
    out('  PANEL_TOKEN сгенерирован (покажу в конце).');
  }
}

async function stepBedolaga(state: State): Promise<void> {
  const { out, io, facts } = state;
  out('\n[4/6] Bedolaga (необязательно)');
  const enabled = state.env['BEDOLAGA_ENABLED'] === 'true';
  if (!(await yesNo(io, 'bedolaga', '  Подключить тикеты Bedolaga?', enabled))) return;

  const container = findBedolaga(facts);
  let suggestion = state.env['BEDOLAGA_API_URL'] ?? '';
  if (container) {
    const port = container.exposed.includes(8080) ? 8080 : container.exposed[0] ?? 8080;
    const direct = `http://${container.name}:${port}`;
    out(`  На этом сервере есть контейнер ${container.name} (${container.image}).`);
    out(`  К нему можно ходить напрямую по docker-сети: ${direct} — без публикации порта и HTTPS.`);
    if (!suggestion) suggestion = direct;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const url = (await io.ask('bedolagaUrl', '  BEDOLAGA_API_URL', suggestion)).replace(/\/+$/, '');
    if (!url) { out('  Адрес не задан — Bedolaga пропущена.'); return; }
    const existingToken = state.env['BEDOLAGA_API_TOKEN'] ?? '';
    const token = (await io.secret('bedolagaToken', `  BEDOLAGA_API_TOKEN (ключ webapi${existingToken ? ', Enter — оставить текущий' : ''})`)) || existingToken;
    if (!token) { out('  Токен не задан — Bedolaga пропущена.'); return; }

    let host = '';
    try { host = new URL(url).hostname; } catch { /* проверит probe */ }
    let verdict: 'ok' | 'save' | 'retry' | 'skip';
    if (container && host === container.name) {
      planNetworkTo(state, container, 'Bedolaga');
      out('  Проверить сейчас нельзя: сеть подключится при запуске. После запуска: ./install.sh --check');
      verdict = 'save';
    } else {
      out('  Проверяю из контейнера…');
      verdict = await verifyIntegration(state, 'bedolaga',
        () => probeUrl(`${url}/tickets?status=open&limit=1&offset=0`, { headers: { 'X-API-Key': token } }),
        async (result) => {
          const kind = result.diagnosis?.kind;
          if (kind === 'dns-docker') {
            if (await yesNo(io, 'dnsOverride', '  Включить dns: [1.1.1.1, 8.8.8.8] для контейнера?', true)) state.plan.dns = true;
          } else if (kind === 'refused' || kind === 'timeout') {
            bedolagaClosedPortHelp(out, url);
          } else if (kind === 'auth') {
            out('      Нужен ключ webapi бота — он уходит в заголовке X-API-Key.');
          } else if (kind === 'html' || kind === 'not-found') {
            out('      Укажите корень webapi: адрес, к которому клиент допишет /tickets.');
          }
        });
    }
    if (verdict === 'retry') continue;
    if (verdict === 'skip') return;
    set(state, 'BEDOLAGA_ENABLED', 'true');
    set(state, 'BEDOLAGA_API_URL', url);
    if (token !== existingToken) set(state, 'BEDOLAGA_API_TOKEN', token);
    return;
  }
}

async function stepRemnawave(state: State): Promise<void> {
  const { out, io } = state;
  out('\n[5/6] Remnawave (необязательно)');
  if (state.env['REMNAWAVE_PANELS_JSON']) {
    out('  Панели заданы через REMNAWAVE_PANELS_JSON — шаг пропускаю, правьте .env вручную.');
    return;
  }
  const enabled = state.env['REMNAWAVE_ENABLED'] === 'true';
  if (!(await yesNo(io, 'remnawave', '  Подключить Remnawave (подписка и устройства клиента)?', enabled))) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const url = (await io.ask('remnawaveUrl', '  REMNAWAVE_URL (адрес панели Remnawave)', state.env['REMNAWAVE_URL'] ?? '')).replace(/\/+$/, '');
    if (!url) { out('  Адрес не задан — Remnawave пропущена.'); return; }
    const existingToken = state.env['REMNAWAVE_TOKEN'] ?? '';
    const token = (await io.secret('remnawaveToken', `  REMNAWAVE_TOKEN (API-токен панели${existingToken ? ', Enter — оставить текущий' : ''})`)) || existingToken;
    if (!token) { out('  Токен не задан — Remnawave пропущена.'); return; }
    out('  Проверяю из контейнера…');
    const verdict = await verifyIntegration(state, 'remnawave',
      () => probeUrl(`${url}/api/users?size=1`, { headers: { authorization: `Bearer ${token}` } }),
      async (result) => {
        if (result.diagnosis?.kind === 'dns-docker') {
          if (await yesNo(io, 'dnsOverride', '  Включить dns: [1.1.1.1, 8.8.8.8] для контейнера?', true)) state.plan.dns = true;
        } else if (result.diagnosis?.kind === 'auth') {
          out('      Токен создаётся в Remnawave: Настройки → API-токены.');
        }
      });
    if (verdict === 'retry') continue;
    if (verdict === 'skip') return;
    set(state, 'REMNAWAVE_ENABLED', 'true');
    set(state, 'REMNAWAVE_URL', url);
    if (token !== existingToken) set(state, 'REMNAWAVE_TOKEN', token);
    return;
  }
}

function stepMinishop(state: State): void {
  state.out('\n[6/6] MiniShop');
  state.out(state.env['MINISHOP_ENABLED'] === 'true'
    ? '  Уже включён в .env — мастер его не трогает.'
    : '  Настраивается в .env, см. DEPLOY.md, раздел «Канал MiniShop».');
}

// --- запись -------------------------------------------------------------

const SECRET_KEY = /TOKEN|KEY|SECRET/;

function summary(state: State): void {
  const { out } = state;
  out('\n=== Итог ===');
  const entries = Object.entries(state.updates);
  if (!entries.length) out('  .env: без изменений');
  for (const [key, value] of entries) {
    out(`  ${key.padEnd(20)} ${value === null ? '(закомментировать)' : SECRET_KEY.test(key) ? mask(value) : value || '(пусто)'}`);
  }
  if (state.plan.dns || state.plan.networks.length) {
    out('  docker-compose.override.yml:');
    if (state.plan.dns) out('    dns: 1.1.1.1, 8.8.8.8');
    for (const net of state.plan.networks) out(`    сеть ${net.name}${net.external ? '' : ' (создаст compose)'}`);
  }
}

function writeFiles(state: State, now: Date): void {
  const { out, dir } = state;
  const envPath = join(dir, '.env');
  if (Object.keys(state.updates).length) {
    if (existsSync(envPath)) {
      const backup = join(dir, backupName(now));
      copyFileSync(envPath, backup);
      chmodSync(backup, 0o600);
      out(`  Бэкап: ${backup}`);
    }
    writeFileSync(envPath, updateEnvText(state.envText, state.updates, now.toISOString().slice(0, 10)), { mode: 0o600 });
    chmodSync(envPath, 0o600);
    out(`  Записан ${envPath}`);
  }

  const overridePath = join(dir, 'docker-compose.override.yml');
  const need = state.plan.dns || state.plan.networks.length > 0;
  const existing = existsSync(overridePath) ? readFileSync(overridePath, 'utf8') : undefined;
  if (existing !== undefined && !isOurOverride(existing)) {
    if (need) {
      out(`  ${overridePath} уже есть и создан не мастером — не трогаю. Добавьте в него вручную:`);
      for (const line of renderOverrideBody(state.plan).trimEnd().split('\n')) out(`    ${line}`);
    }
    return;
  }
  if (need || existing !== undefined) {
    writeFileSync(overridePath, renderOverride(state.plan));
    out(`  Записан ${overridePath}`);
  }
}

// --- проверка (--check) -------------------------------------------------

async function runCheck(state: State): Promise<number> {
  const { out, env, facts } = state;
  let failures = 0;
  const bad = (text: string) => { failures += 1; out(` FAIL ${text}`); };
  const good = (text: string) => out(`  ok  ${text}`);
  const warn = (text: string) => out(` warn ${text}`);
  out('\n=== Проверка настроек (ничего не меняю) ===\n');

  if (env['PANEL_PORT'] && env['PANEL_PORT'] !== '8080') warn(`PANEL_PORT=${env['PANEL_PORT']} в .env не действует в Docker — внешний порт задаёт PANEL_PUBLISH_PORT`);
  if (env['PANEL_HOST']) warn('PANEL_HOST в .env не действует в Docker — адрес публикации задаёт PANEL_BIND');
  const port = Number(env['PANEL_PUBLISH_PORT']) || 8080;
  if (!facts.missing) {
    const owner = portOwner(facts, port, env['PANEL_BIND'] || '127.0.0.1', CONTAINER);
    if (owner && !owner.ours) bad(`порт панели ${port} занят: ${owner.owner}. Свободный рядом: ${nearestFreePort(facts, port + 1)} (PANEL_PUBLISH_PORT)`);
    else good(`порт панели ${port}${owner?.ours ? ' — занят нашим контейнером' : ' свободен'}`);
  }
  const panelToken = env['PANEL_TOKEN'] ?? '';
  if (panelToken.length >= 16 && /^[\x21-\x7E]+$/.test(panelToken)) good('PANEL_TOKEN задан');
  else bad('PANEL_TOKEN пуст, короче 16 символов или не ASCII');
  if (!env['PANEL_URL']) warn('PANEL_URL не задан — в уведомлениях не будет ссылок на диалог');

  if (env['BOT_TOKEN']) {
    const check = await checkBotToken(env['BOT_TOKEN']);
    if (check.ok) good(`бот ${check.text}`); else bad(`BOT_TOKEN: ${check.text}`);
    if (check.ok && env['ALERT_CHAT_ID']) {
      try {
        const chat = await telegram<{ title?: string; first_name?: string }>(env['BOT_TOKEN'], 'getChat', { chat_id: env['ALERT_CHAT_ID'] });
        if (chat.ok) good(`чат уведомлений: ${chat.result?.title ?? chat.result?.first_name ?? env['ALERT_CHAT_ID']}`);
        else bad(`ALERT_CHAT_ID: бот не видит чат (${chat.description ?? chat.error_code}) — напишите боту /start или добавьте его в группу`);
      } catch (err) {
        bad(`ALERT_CHAT_ID: ${explainError(err, TELEGRAM_API)}`);
      }
    } else if (!env['ALERT_CHAT_ID']) warn('ALERT_CHAT_ID не задан — уведомления никуда не уйдут');
  } else warn('BOT_TOKEN не задан — Telegram выключен');

  const probeAndReport = async (label: string, url: string, headers: Record<string, string>): Promise<void> => {
    const result = await probeUrl(url, { headers });
    for (const step of result.steps) out(`       ${step}`);
    if (result.ok) good(label);
    else {
      bad(`${label}: ${result.diagnosis?.message ?? 'не отвечает'}`);
      if (result.diagnosis?.hint) out(`       ${result.diagnosis.hint}`);
      if (label.startsWith('Bedolaga') && (result.diagnosis?.kind === 'refused' || result.diagnosis?.kind === 'timeout')) bedolagaClosedPortHelp(out, url);
    }
  };

  const aiKey = (env['AI_API_KEY'] ?? '').split(',')[0]?.trim();
  if (aiKey && env['AI_MODE'] !== 'off') {
    await probeAndReport('AI провайдер', `${(env['AI_BASE_URL'] || GROQ_URL).replace(/\/+$/, '')}/models`, { authorization: `Bearer ${aiKey}` });
  }
  if (env['BEDOLAGA_ENABLED'] === 'true') {
    const base = (env['BEDOLAGA_API_URL'] ?? '').replace(/\/+$/, '');
    await probeAndReport('Bedolaga API', `${base}/tickets?status=open&limit=1&offset=0`, { 'X-API-Key': env['BEDOLAGA_API_TOKEN'] ?? '' });
  }
  if (env['REMNAWAVE_ENABLED'] === 'true' && !env['REMNAWAVE_PANELS_JSON']) {
    const base = (env['REMNAWAVE_URL'] ?? '').replace(/\/+$/, '');
    await probeAndReport('Remnawave', `${base}/api/users?size=1`, { authorization: `Bearer ${env['REMNAWAVE_TOKEN'] ?? ''}` });
  }
  out(failures ? `\nПроблем: ${failures}. Исправьте .env (или ./install.sh --setup) и проверьте снова.\n` : '\nВсё в порядке.\n');
  return failures ? 1 : 0;
}

// --- точка входа --------------------------------------------------------

export interface SetupOptions {
  dir: string;
  factsPath?: string;
  answers?: Record<string, unknown>;
  check?: boolean;
  out?: Out;
  now?: Date;
}

function loadFacts(path: string | undefined): HostFacts {
  if (!path || !existsSync(path)) return parseFacts(null);
  try {
    return parseFacts(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return parseFacts(null);
  }
}

/** 0 — готово, 1 — проверки не прошли, 3 — запись отменена. */
export async function runSetup(options: SetupOptions): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line));
  const envPath = join(options.dir, '.env');
  const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const overridePath = join(options.dir, 'docker-compose.override.yml');
  const overrideText = existsSync(overridePath) ? readFileSync(overridePath, 'utf8') : '';
  const io = options.answers ? answersPrompter(options.answers, out) : terminalPrompter();
  const state: State = {
    dir: options.dir,
    envText,
    env: parseEnv(envText),
    facts: loadFacts(options.factsPath),
    updates: {},
    // Повторная настройка не должна молча снимать ранее подключённые сети и dns.
    plan: isOurOverride(overrideText) ? parseOurOverride(overrideText) : { dns: false, networks: [] },
    notes: [],
    out,
    io,
    port: 8080,
  };
  try {
    if (options.check) return await runCheck(state);

    out('\n=== Мастер настройки ai-support ===');
    out('Умолчания — в [скобках], Enter их принимает. Необязательное можно пропустить.');
    await stepTelegram(state);
    await stepAi(state);
    await stepPanel(state);
    await stepBedolaga(state);
    await stepRemnawave(state);
    stepMinishop(state);
    summary(state);
    if (!(await yesNo(io, 'confirm', '\nЗаписать?', true))) {
      out('Ничего не записано.');
      return 3;
    }
    writeFiles(state, options.now ?? new Date());
    if (state.updates['PANEL_TOKEN']) out(`\nТокен входа в панель: ${state.updates['PANEL_TOKEN']}\n(он же в .env: grep PANEL_TOKEN .env)`);
    for (const note of state.notes) out(`  * ${note}`);
    return 0;
  } finally {
    io.close();
  }
}

function parseArgs(argv: string[]): SetupOptions & { answersPath?: string } {
  const options: SetupOptions & { answersPath?: string } = { dir: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] ?? '';
    if (arg === '--dir') options.dir = next();
    else if (arg === '--facts') options.factsPath = next();
    else if (arg === '--answers') options.answersPath = next();
    else if (arg === '--check') options.check = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('node dist/cli/setup.js [--dir DIR] [--facts FILE] [--answers FILE] [--check]');
      process.exit(0);
    }
  }
  if (!options.factsPath) options.factsPath = join(options.dir, '.setup-facts.json');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  if (options.answersPath) options.answers = JSON.parse(readFileSync(options.answersPath, 'utf8')) as Record<string, unknown>;
  runSetup(options).then((code) => process.exit(code), (err) => {
    console.error('Мастер упал:', diagnoseError(err).message);
    process.exit(1);
  });
}
