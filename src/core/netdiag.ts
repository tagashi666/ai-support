/**
 * Сетевая диагностика человеческим языком.
 *
 * Голое «fetch failed» ничего не говорит тому, кто ставит сервис на VPS:
 * причина лежит в `cause` (EAI_AGAIN, ECONNREFUSED…) или в статусе ответа.
 * Здесь она достаётся и превращается в короткий русский текст с подсказкой.
 * Модуль не зависит от config.ts: его использует мастер настройки, который
 * работает и без заполненного .env.
 */
import { promises as dnsPromises, Resolver } from 'node:dns';
import { isIP, connect as tcpConnect } from 'node:net';

export type NetKind =
  | 'ok'
  | 'dns'          // имя не резолвится вообще
  | 'dns-docker'   // системный DNS контейнера не отвечает, публичный резолвит
  | 'refused'      // порт закрыт
  | 'timeout'      // нет ответа: фильтр, неверный IP, порт не опубликован
  | 'unreachable'  // нет маршрута
  | 'reset'        // соединение оборвано
  | 'tls'          // сертификат или протокол
  | 'auth'         // 401/403
  | 'not-found'    // 404
  | 'conflict'     // 409 (Telegram: бот уже запущен)
  | 'html'         // ждали JSON, пришла страница
  | 'http'         // прочий HTTP-статус
  | 'unknown';

export interface Diagnosis {
  kind: NetKind;
  /** Одна строка: что случилось. */
  message: string;
  /** Что с этим делать. */
  hint?: string;
  code?: string;
  status?: number;
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'ENODATA', 'ESERVFAIL']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const TLS_CODE = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|EPROTO/;

/** Код ошибки из err, err.cause и AggregateError.errors (happy eyeballs). */
export function errorCode(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const record = item as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === 'string' && record.code && record.code !== 'ERR_INVALID_ARG_TYPE') return record.code;
    if (record.name === 'TimeoutError' || record.name === 'AbortError') return 'ETIMEDOUT';
    if (record.cause) queue.push(record.cause);
    if (Array.isArray(record.errors)) queue.push(...record.errors);
  }
  return undefined;
}

function hostOf(target?: string): string {
  if (!target) return 'сервер';
  try { return new URL(target).host; } catch { return target; }
}

/** Диагноз по HTTP-ответу. null — ответ годный. */
export function diagnoseResponse(
  status: number,
  contentType = '',
  body = '',
  expectJson = true,
): Diagnosis | null {
  if (status === 401 || status === 403) {
    return { kind: 'auth', status, message: `HTTP ${status}: токен не подходит`, hint: 'проверьте токен: скопируйте его заново без пробелов и кавычек' };
  }
  if (status === 404) {
    return { kind: 'not-found', status, message: 'HTTP 404: путь не найден', hint: 'проверьте адрес API: нужен корень API, без конечной ручки' };
  }
  if (status === 409) {
    return { kind: 'conflict', status, message: 'HTTP 409: конфликт' };
  }
  const looksHtml = /text\/html/i.test(contentType) || /^\s*<(!doctype|html|head|body)/i.test(body);
  if (status >= 400) {
    return {
      kind: 'http', status, message: `HTTP ${status}`,
      hint: status === 502 || status === 503 || status === 504
        ? 'прокси перед API отвечает, а сам сервис за ним — нет'
        : undefined,
    };
  }
  if (expectJson && looksHtml) {
    return {
      kind: 'html', status, message: 'вместо JSON пришла HTML-страница',
      hint: 'адрес ведёт на сайт или страницу входа, а не на API — проверьте путь (например, /api)',
    };
  }
  return null;
}

/**
 * Диагноз по исключению fetch/клиента. Понимает и сообщения наших клиентов
 * вида «GET /tickets → HTTP 401».
 */
export function diagnoseError(err: unknown, target?: string): Diagnosis {
  const host = hostOf(target);
  const code = errorCode(err);
  const text = err instanceof Error ? err.message : String(err);

  if (code && DNS_CODES.has(code)) {
    return code === 'ENOTFOUND' || code === 'EAI_NONAME'
      ? { kind: 'dns', code, message: `имя ${host} не найдено в DNS (${code})`, hint: 'проверьте написание домена и его DNS-запись' }
      : {
        kind: 'dns', code, message: `DNS не ответил для ${host} (${code})`,
        hint: 'внутри Docker на VPS часто не работает системный DNS — добавьте dns: [1.1.1.1, 8.8.8.8] в docker-compose.override.yml',
      };
  }
  if (code === 'ECONNREFUSED') {
    return { kind: 'refused', code, message: `${host}: соединение отклонено — порт закрыт или сервис не слушает`, hint: 'сервис не запущен или опубликован только на 127.0.0.1 своего сервера' };
  }
  if (code && TIMEOUT_CODES.has(code)) {
    return { kind: 'timeout', code, message: `${host}: нет ответа (таймаут)`, hint: 'порт закрыт фаерволом, не опубликован наружу или адрес неверный' };
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return { kind: 'unreachable', code, message: `${host}: нет маршрута (${code})`, hint: 'адрес недоступен из этой сети — проверьте IP' };
  }
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE') {
    return { kind: 'reset', code, message: `${host}: соединение оборвано (${code})`, hint: 'часто это HTTPS на HTTP-порт или наоборот — проверьте схему в адресе' };
  }
  if (code && TLS_CODE.test(code)) {
    return { kind: 'tls', code, message: `${host}: ошибка TLS (${code})`, hint: 'сертификат недействителен или адрес указан с https на порт без TLS' };
  }
  const httpStatus = /HTTP (\d{3})/.exec(text);
  if (httpStatus) {
    const diagnosis = diagnoseResponse(Number(httpStatus[1]), '', '', false);
    if (diagnosis) return diagnosis;
  }
  if (/Unexpected token '?<|is not valid JSON/.test(text)) {
    return { kind: 'html', message: 'вместо JSON пришла HTML-страница', hint: 'адрес ведёт не на API — проверьте путь' };
  }
  if (/Invalid URL|Failed to parse URL/i.test(text)) {
    return { kind: 'unknown', message: `неверный адрес: ${target ?? text}`, hint: 'нужен полный URL вида https://api.example.com' };
  }
  return { kind: 'unknown', ...(code ? { code } : {}), message: code ? `${text} (${code})` : text };
}

/** Одна строка для лога: «что случилось — что делать». */
export function explainError(err: unknown, target?: string): string {
  const diagnosis = diagnoseError(err, target);
  return diagnosis.hint ? `${diagnosis.message} — ${diagnosis.hint}` : diagnosis.message;
}

// --- пошаговая проверка адреса ------------------------------------------

/** Подменяемые зависимости: тесты ставят сюда заглушки. */
export const netDeps = {
  lookup: async (host: string): Promise<string> => (await dnsPromises.lookup(host)).address,
  /** Резолв через публичный DNS в обход системного. */
  lookupPublic: async (host: string): Promise<string> => {
    const resolver = new Resolver({ timeout: 3000, tries: 1 });
    resolver.setServers(['1.1.1.1', '8.8.8.8']);
    return await new Promise<string>((resolve, reject) => {
      resolver.resolve4(host, (err, addresses) => (err ? reject(err) : resolve(addresses[0] ?? '')));
    });
  },
  connect: (host: string, port: number, timeoutMs: number): Promise<void> => new Promise((resolve, reject) => {
    const socket = tcpConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.end(); resolve(); });
    socket.once('error', (err) => { clearTimeout(timer); reject(err); });
  }),
};

export interface ProbeOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  expectJson?: boolean;
}

export interface ProbeResult {
  ok: boolean;
  /** Пройденные шаги: «DNS: ok», «TCP: ok»… */
  steps: string[];
  diagnosis?: Diagnosis;
  status?: number;
  body?: unknown;
  /** Системный DNS не резолвит, а 1.1.1.1 резолвит. */
  publicDnsWorks?: boolean;
}

/**
 * Проверка адреса по шагам: DNS → TCP → HTTP. Первый проваленный шаг даёт
 * диагноз, чтобы человек видел, на каком уровне проблема.
 */
export async function probeUrl(target: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const steps: string[] = [];
  const timeoutMs = options.timeoutMs ?? 10_000;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { ok: false, steps, diagnosis: { kind: 'unknown', message: `неверный адрес: ${target}`, hint: 'нужен полный URL вида https://api.example.com' } };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);

  let address = host;
  if (!isIP(host)) {
    try {
      address = await netDeps.lookup(host);
      steps.push(`DNS: ${host} → ${address}`);
    } catch (err) {
      const diagnosis = diagnoseError(err, target);
      let publicDnsWorks = false;
      if (diagnosis.kind === 'dns') {
        try {
          const viaPublic = await netDeps.lookupPublic(host);
          publicDnsWorks = Boolean(viaPublic);
        } catch { /* публичный тоже не знает имя */ }
      }
      if (publicDnsWorks) {
        steps.push(`DNS: системный не резолвит ${host}, 1.1.1.1 — резолвит`);
        return {
          ok: false, steps, publicDnsWorks,
          diagnosis: {
            kind: 'dns-docker', code: diagnosis.code,
            message: `DNS внутри контейнера не резолвит ${host}, а публичный 1.1.1.1 — резолвит`,
            hint: 'включите dns: [1.1.1.1, 8.8.8.8] в docker-compose.override.yml',
          },
        };
      }
      steps.push(`DNS: ${diagnosis.message}`);
      return { ok: false, steps, diagnosis };
    }
  }

  try {
    await netDeps.connect(address, port, Math.min(timeoutMs, 8000));
    steps.push(`TCP: порт ${port} открыт`);
  } catch (err) {
    const diagnosis = diagnoseError(err, target);
    steps.push(`TCP: ${diagnosis.message}`);
    return { ok: false, steps, diagnosis };
  }

  let response: Response;
  try {
    response = await fetch(url, { headers: options.headers ?? {}, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const diagnosis = diagnoseError(err, target);
    steps.push(`HTTP: ${diagnosis.message}`);
    return { ok: false, steps, diagnosis };
  }
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text().catch(() => '');
  const diagnosis = diagnoseResponse(response.status, contentType, text.slice(0, 200), options.expectJson ?? true);
  if (diagnosis) {
    steps.push(`HTTP: ${diagnosis.message}`);
    return { ok: false, steps, diagnosis, status: response.status };
  }
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch {
    if (options.expectJson ?? true) {
      const html = { kind: 'html' as const, status: response.status, message: 'ответ не JSON', hint: 'адрес ведёт не на API — проверьте путь' };
      steps.push(`HTTP: ${html.message}`);
      return { ok: false, steps, diagnosis: html, status: response.status };
    }
  }
  steps.push(`HTTP: ${response.status}`);
  return { ok: true, steps, status: response.status, body };
}
