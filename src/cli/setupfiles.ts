/**
 * Чистые функции мастера настройки: правка .env без потери чужих строк,
 * docker-compose.override.yml, разбор фактов хоста и выбор свободного порта.
 * Отдельно от диалога, чтобы тесты проверяли их без ввода.
 */

// --- .env ---------------------------------------------------------------

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const COMMENTED_LINE = /^\s*#\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function unquote(raw: string): string {
  const value = raw.trim().replace(/\r$/, '');
  return value.replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1');
}

/** Значения .env так же, как их читает config.ts: первое присваивание главнее. */
export function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = ENV_LINE.exec(trimmed);
    if (!match) continue;
    const [, name, value] = match as unknown as [string, string, string];
    if (!(name in result)) result[name] = unquote(value);
  }
  return result;
}

/** Значение в форме, которую одинаково понимают config.ts и docker compose. */
export function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_.:/@,+=%-]*$/.test(value)) return value;
  // Одинарные кавычки: compose не подставляет в них ${...}.
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return value;
}

/**
 * Обновляет и добавляет только переданные ключи. Остальные строки, комментарии
 * и порядок не трогаются. Ключ, уже присвоенный в файле, меняется на месте;
 * повторные присваивания того же ключа комментируются, чтобы не спорить с
 * первым. Значение null комментирует ключ. Ключ, который есть только закомментированным образцом из шаблона,
 * вписывается сразу под образцом. Остальные дописываются в конец.
 */
export function updateEnvText(text: string, updates: Record<string, string | null>, stamp = new Date().toISOString().slice(0, 10)): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.replace(/\r\n/g, '\n').split('\n') : [];
  // Хвостовой перевод строки даёт пустой последний элемент — снимаем и вернём.
  const trailing = lines.length > 0 && lines[lines.length - 1] === '';
  if (trailing) lines.pop();

  const pending = new Map(Object.entries(updates));
  const assigned = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const match = ENV_LINE.exec(lines[index]!);
    if (!match || lines[index]!.trim().startsWith('#')) continue;
    const name = match[1]!;
    if (!pending.has(name) && !assigned.has(name)) continue;
    if (assigned.has(name)) {
      lines[index] = `# ${lines[index]}  # повтор, отключён мастером настройки`;
      continue;
    }
    const value = pending.get(name);
    if (value === null) {
      // null — ключ не должен действовать: комментируем, но не удаляем.
      lines[index] = `# ${lines[index]}  # отключено мастером настройки`;
      continue;
    }
    lines[index] = `${name}=${formatEnvValue(value!)}`;
    pending.delete(name);
    assigned.add(name);
  }

  for (const [name, value] of [...pending]) {
    if (value === null) { pending.delete(name); continue; }
    const at = lines.findIndex((line) => COMMENTED_LINE.exec(line)?.[1] === name);
    if (at < 0) continue;
    lines.splice(at + 1, 0, `${name}=${formatEnvValue(value)}`);
    pending.delete(name);
  }

  if (pending.size) {
    if (lines.length && lines[lines.length - 1]!.trim() !== '') lines.push('');
    lines.push(`# --- мастер настройки ${stamp} ---`);
    for (const [name, value] of pending) lines.push(`${name}=${formatEnvValue(value ?? '')}`);
  }
  return lines.join(eol) + (trailing || pending.size || !text.length ? eol : '');
}

/** Имя бэкапа: .env.bak-YYYYMMDD-HHMMSS. */
export function backupName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `.env.bak-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Токен для показа: 1234…abcd. */
export function mask(value: string): string {
  if (!value) return '—';
  return value.length <= 8 ? '•'.repeat(value.length) : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

// --- docker-compose.override.yml ----------------------------------------

export const OVERRIDE_MARKER = '# ai-support setup: создано мастером настройки, при повторной настройке перезаписывается.';

export interface OverrideNetwork {
  /** Настоящее имя docker-сети. */
  name: string;
  /** true — сеть уже существует (сеть чужого compose-проекта). false — её создаст наш compose. */
  external: boolean;
}

export interface OverridePlan {
  dns: boolean;
  networks: OverrideNetwork[];
}

const DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];

function networkKey(name: string, index: number): string {
  const key = name.replace(/[^A-Za-z0-9_-]/g, '_');
  return /^[A-Za-z]/.test(key) ? key : `net${index}_${key}`;
}

/** YAML-фрагмент без маркера: его же показываем, когда override чужой. */
export function renderOverrideBody(plan: OverridePlan): string {
  const service: string[] = [];
  if (plan.dns) service.push(`    dns: [${DNS_SERVERS.join(', ')}]`);
  const unique = plan.networks.filter((net, index, all) => all.findIndex((other) => other.name === net.name) === index);
  if (unique.length) {
    // Без default контейнер потерял бы свою сеть compose-проекта.
    service.push('    networks:', '      - default', ...unique.map((net, index) => `      - ${networkKey(net.name, index)}`));
  }
  const lines = ['services:', service.length ? '  ai-support:' : '  ai-support: {}', ...service];
  if (unique.length) {
    lines.push('networks:');
    unique.forEach((net, index) => {
      lines.push(`  ${networkKey(net.name, index)}:`, `    name: ${net.name}`);
      if (net.external) lines.push('    external: true');
    });
  }
  return lines.join('\n') + '\n';
}

export function renderOverride(plan: OverridePlan): string {
  return `${OVERRIDE_MARKER}\n# Своё добавляйте в другой файл: этот мастер перепишет.\n${renderOverrideBody(plan)}`;
}

export function isOurOverride(text: string): boolean {
  return text.startsWith(OVERRIDE_MARKER);
}

/** Что уже включено в нашем override — чтобы повторный запуск не терял сети и dns. */
export function parseOurOverride(text: string): OverridePlan {
  const plan: OverridePlan = { dns: /^\s*dns:/m.test(text), networks: [] };
  const section = text.split(/^networks:\s*$/m)[1] ?? '';
  const blocks = section.split(/^ {2}[^\s].*:\s*$/m).slice(1);
  for (const block of blocks) {
    const name = /^\s+name:\s*(\S+)/m.exec(block)?.[1];
    if (name) plan.networks.push({ name, external: /^\s+external:\s*true/m.test(block) });
  }
  return plan;
}

// --- факты хоста ---------------------------------------------------------

export interface FactContainer {
  name: string;
  image: string;
  networkMode: string;
  networks: string[];
  /** Опубликованные порты: хост → контейнер. */
  published: Array<{ hostIp: string; hostPort: number; containerPort: number }>;
  /** Порты, которые контейнер слушает внутри (EXPOSE и опубликованные). */
  exposed: number[];
  composeService?: string;
}

export interface Listener {
  address: string;
  port: number;
  process?: string;
  pid?: number;
}

export interface HostFacts {
  listeners: Listener[];
  containers: FactContainer[];
  /** Факты не собраны (мастер запущен не через install.sh). */
  missing: boolean;
}

/** Строка `ss -ltnpH`: LISTEN 0 4096 127.0.0.1:9090 0.0.0.0:* users:(("mtg",pid=12,fd=3)) */
export function parseSsLine(line: string): Listener | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 4) return null;
  // Колонка локального адреса — четвёртая (State Recv-Q Send-Q Local Peer [Process]).
  const local = parts[0] === 'LISTEN' ? parts[3]! : parts.find((part) => /:\d+$/.test(part)) ?? '';
  const match = /^(.*):(\d+)$/.exec(local);
  if (!match) return null;
  const users = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
  return {
    address: match[1]!.replace(/^\[|\]$/g, '').replace(/%.*$/, ''),
    port: Number(match[2]),
    ...(users ? { process: users[1], pid: Number(users[2]) } : {}),
  };
}

interface RawContainer {
  name?: string;
  image?: string;
  networkMode?: string;
  networks?: Record<string, unknown> | null;
  ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | null;
  exposed?: Record<string, unknown> | null;
  labels?: Record<string, string> | null;
}

export function parseFacts(raw: unknown): HostFacts {
  if (!raw || typeof raw !== 'object') return { listeners: [], containers: [], missing: true };
  const record = raw as { ss?: unknown; containers?: unknown };
  const listeners = (Array.isArray(record.ss) ? record.ss : [])
    .map((line) => (typeof line === 'string' ? parseSsLine(line) : null))
    .filter((item): item is Listener => item !== null);
  const containers = (Array.isArray(record.containers) ? record.containers as RawContainer[] : []).map((item) => {
    const published: FactContainer['published'] = [];
    const exposed = new Set<number>();
    for (const [key, bindings] of Object.entries(item.ports ?? {})) {
      const containerPort = Number.parseInt(key, 10);
      if (!key.endsWith('/tcp') || !Number.isFinite(containerPort)) continue;
      exposed.add(containerPort);
      for (const binding of bindings ?? []) {
        const hostPort = Number(binding.HostPort);
        if (hostPort) published.push({ hostIp: binding.HostIp || '0.0.0.0', hostPort, containerPort });
      }
    }
    for (const key of Object.keys(item.exposed ?? {})) {
      const port = Number.parseInt(key, 10);
      if (key.endsWith('/tcp') && Number.isFinite(port)) exposed.add(port);
    }
    const service = item.labels?.['com.docker.compose.service'];
    return {
      name: String(item.name ?? '').replace(/^\//, ''),
      image: String(item.image ?? ''),
      networkMode: String(item.networkMode ?? ''),
      networks: Object.keys(item.networks ?? {}),
      published,
      exposed: [...exposed].sort((a, b) => a - b),
      ...(service ? { composeService: service } : {}),
    };
  }).filter((item) => item.name);
  return { listeners, containers, missing: false };
}

const ANY = new Set(['0.0.0.0', '::', '*', '']);

export interface PortOwner {
  port: number;
  /** Кто держит порт, по-человечески. */
  owner: string;
  /** Порт держит наш же контейнер ai-support — это не конфликт. */
  ours: boolean;
}

/** Кто слушает порт на этом адресе. null — свободен. */
export function portOwner(facts: HostFacts, port: number, bind = '127.0.0.1', ourContainer = 'ai-support'): PortOwner | null {
  const container = facts.containers.find((item) => item.published.some((binding) => binding.hostPort === port
    && (ANY.has(binding.hostIp) || ANY.has(bind) || binding.hostIp === bind)));
  if (container) {
    return { port, owner: `контейнер ${container.name} (${container.image})`, ours: container.name === ourContainer };
  }
  const listener = facts.listeners.find((item) => item.port === port
    && (ANY.has(item.address) || ANY.has(bind) || item.address === bind));
  if (!listener) return null;
  const owner = listener.process
    ? `${listener.process}${listener.pid ? ` (pid ${listener.pid})` : ''} на ${listener.address || '*'}:${port}`
    : `процесс на ${listener.address || '*'}:${port} (имя видно только root)`;
  // docker-proxy — это опубликованный порт контейнера, который почему-то не
  // нашёлся в фактах; считаем чужим, но так и пишем.
  return { port, owner, ours: false };
}

/** Ближайший свободный порт вверх от желаемого. */
export function nearestFreePort(facts: HostFacts, from: number, bind = '127.0.0.1', ourContainer = 'ai-support'): number {
  for (let port = from; port < Math.min(from + 200, 65535); port += 1) {
    const owner = portOwner(facts, port, bind, ourContainer);
    if (!owner || owner.ours) return port;
  }
  return from;
}

export function findCloudflared(facts: HostFacts): FactContainer | undefined {
  return facts.containers.find((item) => /cloudflared/i.test(item.image) || /cloudflared|cf-?tunnel/i.test(item.name));
}

export function findBedolaga(facts: HostFacts): FactContainer | undefined {
  return facts.containers.find((item) => /bedolaga/i.test(item.image) || /bedolaga/i.test(item.name));
}

/** Сети контейнера, к которым можно подключиться по имени (не bridge/host/none). */
export function joinableNetworks(container: FactContainer): string[] {
  return container.networks.filter((name) => !['bridge', 'host', 'none'].includes(name));
}
