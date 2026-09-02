import { config, log } from '../config.js';

/**
 * Клиент панели Remnawave.
 *
 * В v3 схема разъехалась с v2: uuid у пользователя исчез, пути {uuid} стали
 * {userId} с числовыми id, а ручки /users/by-telegram-id и /by-id удалены.
 * Поэтому здесь не зашит один вариант — клиент пробует известные и запоминает
 * тот, что ответил. Возможности, которых на панели нет, просто выключаются:
 * оператор увидит карточку без кнопок, а не пятьсот ошибок в логе.
 */

export interface NodeState {
  /** UUID узла — по нему сопоставляем последний узел клиента. */
  uuid?: string;
  /** Внутреннее имя узла из Remnawave — ключ псевдонима, виден только оператору. */
  rawName: string;
  /** Имя для показа: псевдоним оператора либо очищенное внутреннее имя. */
  name: string;
  country?: string;
  online: boolean;
  disabled: boolean;
  usersOnline?: number;
  trafficUsedBytes?: number;
  /** Источник нужен только операторской панели при нескольких Remnawave. */
  sourceId?: string;
  sourceName?: string;
  /** Уникальный ключ псевдонима: одинаковые rawName могут быть в разных панелях. */
  aliasKey?: string;
}

/**
 * Публичное имя узла. Во внутренних названиях живут адреса, порты и
 * хостнеймы — в текст, который увидит клиент, они попадать не должны.
 */
export function publicNodeName(raw: string): string {
  const cleaned = raw
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '')
    // Домен снимаем целиком: посегментное правило оставляло хвост «.net».
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, '')
    .replace(/:\d{2,5}\b/g, '')
    .replace(/[_|]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned || 'узел';
}

/**
 * Имя узла для модели и клиента. Явный псевдоним оператора (по внутреннему
 * имени) сильнее всего — им и закрывают внутренние названия. Нет псевдонима —
 * падаем на очищенное от адресов имя.
 */
export function displayNodeName(rawName: string, aliases: Record<string, string> = {}): string {
  const alias = aliases[rawName]?.trim();
  return alias || publicNodeName(rawName);
}

export interface Device {
  id: string;
  hwid: string;
  platform?: string;
  model?: string;
  version?: string;
  seenAt?: string;
}

export interface SubscriptionProfile {
  userRef: string;
  username?: string;
  status?: string;
  expiresAt?: string;
  trafficUsed?: number;
  trafficLimit?: number;
  deviceLimit?: number;
  subscriptionUrl?: string;
  shortId?: string;
  /** Трафик за всё время (не сбрасывается) — для честного среднего в день. */
  lifetimeUsed?: number;
  /** UUID последнего узла, к которому подключался клиент. */
  lastNodeUuid?: string;
  /** Когда клиент впервые подключился — для «клиент с». */
  firstConnectedAt?: string;
  raw: Record<string, unknown>;
}

export interface Capabilities {
  profile: boolean;
  devices: boolean;
  deleteDevice: boolean;
  resetDevices: boolean;
  revoke: boolean;
}

const EMPTY_CAPS: Capabilities = {
  profile: false, devices: false, deleteDevice: false, resetDevices: false, revoke: false,
};

function pick(source: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (source[name] !== undefined && source[name] !== null) return source[name];
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function asNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Ответ панели бывает и голым объектом, и завёрнутым в {response}/{data}. */
function unwrap(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ['response', 'data', 'result']) {
    const inner = record[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>;
  }
  return record;
}

function unwrapList(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  const record = unwrap(body);
  if (!record) return [];
  for (const key of ['devices', 'items', 'response', 'data']) {
    const inner = record[key];
    if (Array.isArray(inner)) return inner as Record<string, unknown>[];
  }
  return [];
}

interface IndexEntry {
  ref: string;
  telegramId?: string;
  username?: string;
  shortUuid?: string;
  haystack: string;
}

export class RemnawaveClient {
  private caps: Capabilities = { ...EMPTY_CAPS };
  private index: IndexEntry[] = [];
  private indexedAt = 0;

  constructor(
    private readonly baseUrl = config.remnawave.url,
    private readonly token = config.remnawave.token,
    private readonly readOnly = config.remnawave.readOnly,
  ) {}

  capabilities(): Capabilities {
    return { ...this.caps };
  }

  private async call(
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: unknown }> {
    const response = await fetch(this.baseUrl.replace(/\/+$/, '') + path, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text().catch(() => '');
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  }

  /** Первый путь из списка, который ответил не 404. */
  private async firstWorking(paths: string[], init?: RequestInit) {
    for (const path of paths) {
      const result = await this.call(path, init);
      if (result.status !== 404 && result.status !== 405) return { ...result, path };
    }
    return undefined;
  }

  async profile(userRef: string): Promise<SubscriptionProfile | undefined> {
    const found = await this.firstWorking([
      `/api/users/${encodeURIComponent(userRef)}`,
      `/api/users/by-uuid/${encodeURIComponent(userRef)}`,
    ]);
    if (!found || found.status >= 400) return undefined;

    const user = unwrap(found.body);
    if (!user) return undefined;

    // Использованный трафик и данные о подключениях в свежих версиях панели
    // лежат во вложенном userTraffic, а не на верхнем уровне.
    const traffic = (pick(user, 'userTraffic') as Record<string, unknown> | undefined) ?? {};

    return {
      userRef,
      username: asString(pick(user, 'username', 'name', 'email')),
      status: asString(pick(user, 'status', 'state')),
      expiresAt: asString(pick(user, 'expireAt', 'expiresAt', 'expire_at', 'subscriptionEndDate')),
      trafficUsed: asNumber(pick(user, 'usedTrafficBytes', 'usedTraffic', 'used_traffic_bytes'))
        ?? asNumber(pick(traffic, 'usedTrafficBytes', 'lifetimeUsedTrafficBytes')),
      lifetimeUsed: asNumber(pick(traffic, 'lifetimeUsedTrafficBytes', 'usedTrafficBytes')),
      trafficLimit: asNumber(pick(user, 'trafficLimitBytes', 'trafficLimit', 'traffic_limit_bytes')),
      deviceLimit: asNumber(pick(user, 'hwidDeviceLimit', 'deviceLimit', 'hwid_device_limit')),
      subscriptionUrl: asString(pick(user, 'subscriptionUrl', 'subscription_url', 'happLink')),
      shortId: asString(pick(user, 'shortUuid', 'shortId', 'short_uuid')),
      lastNodeUuid: asString(pick(traffic, 'lastConnectedNodeUuid', 'lastConnectedNode')),
      firstConnectedAt: asString(pick(traffic, 'firstConnectedAt')),
      raw: user,
    };
  }

  async devices(userRef: string): Promise<Device[] | undefined> {
    const found = await this.firstWorking([
      `/api/hwid/devices/${encodeURIComponent(userRef)}`,
      `/api/hwid/devices?userId=${encodeURIComponent(userRef)}`,
      `/api/hwid/devices?userUuid=${encodeURIComponent(userRef)}`,
    ]);
    if (!found || found.status >= 400) return undefined;

    return unwrapList(found.body).map((item) => ({
      id: asString(pick(item, 'uuid', 'id', 'hwid')) ?? '',
      hwid: asString(pick(item, 'hwid')) ?? '',
      platform: asString(pick(item, 'platform', 'deviceOs', 'os')),
      model: asString(pick(item, 'deviceModel', 'model')),
      version: asString(pick(item, 'verOs', 'osVersion', 'version')),
      seenAt: asString(pick(item, 'updatedAt', 'lastSeenAt', 'createdAt')),
    }));
  }

  /**
   * Разрушающие действия можно запретить целиком через REMNAWAVE_READONLY.
   * Тогда даже доступ к панели не позволяет сбросить устройства или
   * перевыпустить подписку: отказ происходит до сетевого вызова.
   */
  private assertWritable(action: string): void {
    if (this.readOnly) {
      throw new Error(`Действие «${action}» запрещено: REMNAWAVE_READONLY=true`);
    }
  }

  async deleteDevice(userRef: string, hwid: string): Promise<boolean> {
    this.assertWritable('удаление устройства');
    const found = await this.firstWorking(
      [`/api/hwid/devices`, `/api/hwid/devices/${encodeURIComponent(userRef)}/${encodeURIComponent(hwid)}`],
      { method: 'DELETE', body: JSON.stringify({ userId: userRef, userUuid: userRef, hwid }) },
    );
    return !!found && found.status < 400;
  }

  async resetDevices(userRef: string): Promise<boolean> {
    this.assertWritable('сброс устройств');
    const found = await this.firstWorking(
      [
        `/api/hwid/devices/${encodeURIComponent(userRef)}`,
        `/api/hwid/devices/delete-all/${encodeURIComponent(userRef)}`,
      ],
      { method: 'DELETE' },
    );
    return !!found && found.status < 400;
  }

  async revoke(userRef: string): Promise<boolean> {
    this.assertWritable('перевыпуск подписки');
    const found = await this.firstWorking(
      [
        `/api/users/${encodeURIComponent(userRef)}/actions/revoke`,
        `/api/users/revoke/${encodeURIComponent(userRef)}`,
      ],
      { method: 'POST' },
    );
    return !!found && found.status < 400;
  }

  /**
   * Поиск пользователя по telegram id или нику. В Remnawave эти данные
   * часто лежат в свободном поле description, потому что схема их не
   * предусматривает — ищем и по нему.
   */
  /**
   * Полный список пользователей панели, страницами.
   *
   * Панель игнорирует параметр search: на запрос с ним она отдаёт всю базу
   * с начала. Проверено на живой панели — на поиск по telegram id вернулись
   * первые пятеро из 1550 с совершенно другими id. Поэтому индекс строим
   * сами: полторы тысячи записей — это три-четыре запроса, а результат
   * живёт в памяти час.
   */
  private async buildIndex(force = false, log_?: (m: string) => void): Promise<IndexEntry[]> {
    if (!force && this.index.length && Date.now() - this.indexedAt < 3_600_000) return this.index;
    const say = log_ ?? ((m: string) => log.debug(m));

    // Размер страницы подбираем: панели по-разному ограничивают size, и
    // отказ на большой странице раньше молча обрывал индекс на нуле.
    let PAGE = 0;
    for (const candidate of [500, 250, 100, 50, 25]) {
      const probe = await this.call(`/api/users?start=0&size=${candidate}`);
      if (probe.status < 400) { PAGE = candidate; break; }
      say(`size=${candidate} отклонён (HTTP ${probe.status})`);
    }
    if (!PAGE) {
      say('Панель не отдаёт список пользователей — индекс не построен');
      return this.index;
    }
    say(`Размер страницы: ${PAGE}`);

    const collected: IndexEntry[] = [];

    for (let page = 0; page < 200; page += 1) {
      const found = await this.firstWorking([
        `/api/users?start=${page * PAGE}&size=${PAGE}`,
        `/api/users?offset=${page * PAGE}&limit=${PAGE}`,
      ]);
      if (!found || found.status >= 400) {
        say(`Страница ${page} не прочиталась (HTTP ${found?.status ?? '—'})`);
        break;
      }

      const record = unwrap(found.body);
      const list = Array.isArray(found.body) ? (found.body as Record<string, unknown>[])
        : (['users', 'items', 'data'].map((k) => record?.[k]).find(Array.isArray) as Record<string, unknown>[] | undefined) ?? [];
      if (!list.length) break;

      for (const user of list) {
        const ref = asString(pick(user, 'uuid', 'id', 'userId'));
        if (!ref) continue;
        collected.push({
          ref,
          telegramId: asString(pick(user, 'telegramId', 'telegram_id')),
          username: asString(pick(user, 'username'))?.toLowerCase(),
          shortUuid: asString(pick(user, 'shortUuid', 'short_uuid')),
          haystack: [user['username'], user['description'], user['email'], user['tag']]
            .map((v) => String(v ?? '')).join(' ').toLowerCase(),
        });
      }

      const total = asNumber(pick(record ?? {}, 'total', 'count'));
      if (list.length < PAGE || (total !== undefined && collected.length >= total)) break;
    }

    if (collected.length) {
      this.index = collected;
      this.indexedAt = Date.now();
      say(`Индекс Remnawave: ${collected.length} записей`);
    } else {
      say('Индекс пуст — панель вернула список без пригодных записей');
    }
    return this.index;
  }

  /**
   * Подробный разбор поиска одного клиента. Нужен, чтобы не гадать, почему
   * связка не сработала: показывает, что искали, сколько записей в индексе
   * и какие из них хоть чем-то похожи.
   */
  async explain(telegramId?: number, username?: string, extra: string[] = []): Promise<{
    ref?: string; steps: string[]; indexSize: number; near: string[];
  }> {
    const steps: string[] = [];
    const nick = username?.replace(/^@/, '').toLowerCase();
    steps.push(`Ищем: telegram id ${telegramId ?? '—'}, ник ${nick ? '@' + nick : '—'}${extra.length ? `, зацепки ${extra.join(', ')}` : ''}`);

    if (telegramId) {
      const direct = await this.call(`/api/users/by-telegram-id/${telegramId}`);
      steps.push(`/api/users/by-telegram-id → HTTP ${direct.status}`);
    }
    if (nick) {
      const byName = await this.call(`/api/users/by-username/${encodeURIComponent(nick)}`);
      steps.push(`/api/users/by-username → HTTP ${byName.status}`);
    }

    const index = await this.buildIndex(true, (m) => steps.push(m));
    const tg = telegramId ? String(telegramId) : undefined;

    if (tg) {
      steps.push(`точное поле telegramId: ${index.some((i) => i.telegramId === tg) ? 'есть' : 'нет'}`);
      steps.push(`ник user_${tg}_*: ${index.some((i) => i.username?.startsWith(`user_${tg}_`)) ? 'есть' : 'нет'}`);
      steps.push(`id в описании: ${index.some((i) => i.haystack.includes(tg)) ? 'есть' : 'нет'}`);
    }
    if (nick) {
      steps.push(`ник совпадает: ${index.some((i) => i.username === nick) ? 'есть' : 'нет'}`);
      steps.push(`@ник в описании: ${index.some((i) => i.haystack.includes('@' + nick)) ? 'есть' : 'нет'}`);
    }

    // Похожие записи: помогают понять, под каким видом клиент лежит в панели.
    const needle = (tg ?? nick ?? '').slice(0, 6);
    const near = needle
      ? index.filter((i) => i.haystack.includes(needle) || i.telegramId?.includes(needle))
          .slice(0, 5)
          .map((i) => `${i.ref} · ${i.username ?? '—'} · tg ${i.telegramId ?? '—'}`)
      : [];

    const ref = await this.findUser(telegramId, username, extra);
    steps.push(ref ? `Найден: ${ref}` : 'Не найден ни одним способом');
    return { ref, steps, indexSize: index.length, near };
  }

  /** Сколько записей в индексе и когда он собран — для диагностики. */
  indexState(): { size: number; age: number } {
    return { size: this.index.length, age: this.indexedAt ? Date.now() - this.indexedAt : -1 };
  }

  async findUser(telegramId?: number, username?: string, extra: string[] = []): Promise<string | undefined> {
    const nick = username?.replace(/^@/, '').toLowerCase();

    // 1. Точные ручки, если панель их поддерживает.
    if (telegramId) {
      const direct = await this.firstWorking([`/api/users/by-telegram-id/${telegramId}`]);
      if (direct && direct.status < 400) {
        const body = unwrap(direct.body);
        const list = Array.isArray(direct.body) ? (direct.body as Record<string, unknown>[])
          : (['users', 'items'].map((k) => body?.[k]).find(Array.isArray) as Record<string, unknown>[] | undefined);
        const user = list?.[0] ?? body;
        const ref = asString(pick(user ?? {}, 'uuid', 'id', 'userId'));
        if (ref) return ref;
      }
    }
    if (nick) {
      const byName = await this.firstWorking([`/api/users/by-username/${encodeURIComponent(nick)}`]);
      if (byName && byName.status < 400) {
        const ref = asString(pick(unwrap(byName.body) ?? {}, 'uuid', 'id', 'userId'));
        if (ref) return ref;
      }
    }

    // 2. Свой индекс. Порядок проверок — от надёжного к вероятному.
    const index = await this.buildIndex();
    const tg = telegramId ? String(telegramId) : undefined;

    if (tg) {
      const exact = index.find((item) => item.telegramId === tg);
      if (exact) return exact.ref;
      // Бедолага заводит записи с ником user_{telegram_id}_{хеш} —
      // это самая частая связка между ботом и панелью.
      const byPattern = index.find((item) => item.username?.startsWith(`user_${tg}_`) || item.username === `user_${tg}`);
      if (byPattern) return byPattern.ref;
      // Последний рубеж: id, вписанный оператором в описание.
      const inText = index.find((item) => new RegExp(`(^|\\D)${tg}(\\D|$)`).test(item.haystack));
      if (inText) return inText.ref;
    }

    if (nick) {
      const byNick = index.find((item) => item.username === nick)
        ?? index.find((item) => new RegExp(`@${nick}(\\W|$)`).test(item.haystack));
      if (byNick) return byNick.ref;
    }

    for (const hint of extra) {
      const value = hint.toLowerCase();
      if (value.length < 6) continue;
      const byHint = index.find((item) => item.shortUuid?.toLowerCase() === value || item.ref.toLowerCase() === value)
        ?? index.find((item) => item.haystack.includes(value));
      if (byHint) return byHint.ref;
    }

    return undefined;
  }

  /**
   * Состояние узлов: включён, на связи, сколько людей и трафика.
   *
   * Имена чистим сразу здесь: во внутренних названиях сплошь и рядом стоят
   * адреса и хостнеймы, а этот текст уходит в модель и может доехать до
   * клиента. Наружу не должно попадать ничего, кроме страны и метки.
   */
  async nodes(): Promise<NodeState[] | undefined> {
    const found = await this.firstWorking(['/api/nodes', '/api/nodes/all']);
    if (!found || found.status >= 400) return undefined;

    const record = unwrap(found.body);
    const list = Array.isArray(found.body) ? (found.body as Record<string, unknown>[])
      : (['response', 'nodes', 'items', 'data'].map((k) => record?.[k]).find(Array.isArray) as Record<string, unknown>[] | undefined) ?? [];

    return list.map((node) => {
      const disabled = pick(node, 'isDisabled', 'disabled') === true;
      const connected = pick(node, 'isConnected', 'connected') === true;
      const rawName = asString(pick(node, 'name', 'nodeName')) ?? 'узел';
      return {
        uuid: asString(pick(node, 'uuid', 'id')),
        rawName,
        name: publicNodeName(rawName),
        country: asString(pick(node, 'countryCode', 'country')) ?? undefined,
        online: connected && !disabled,
        disabled,
        usersOnline: asNumber(pick(node, 'usersOnline', 'onlineUsers')) ?? undefined,
        trafficUsedBytes: asNumber(pick(node, 'trafficUsedBytes', 'usedTrafficBytes')) ?? undefined,
      };
    });
  }

  /** Узлы, к которым клиент подключался. Даёт понять, чем он реально пользуется. */
  async usage(userRef: string): Promise<{ nodes: { name: string; bytes: number }[]; sinceDays: number } | undefined> {
    const found = await this.firstWorking([
      `/api/users/stats/usage-by-range?uuid=${encodeURIComponent(userRef)}`,
      `/api/users/${encodeURIComponent(userRef)}/usage`,
      `/api/nodes/usage/by-user/${encodeURIComponent(userRef)}`,
    ]);
    if (!found || found.status >= 400) return undefined;

    const record = unwrap(found.body);
    const list = Array.isArray(found.body) ? (found.body as Record<string, unknown>[])
      : (['response', 'nodes', 'items', 'data'].map((k) => record?.[k]).find(Array.isArray) as Record<string, unknown>[] | undefined) ?? [];

    const nodes = list
      .map((item) => ({
        name: asString(pick(item, 'nodeName', 'name', 'node')) ?? '—',
        bytes: asNumber(pick(item, 'total', 'totalBytes', 'usedBytes', 'bytes')) ?? 0,
      }))
      .filter((item) => item.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 5);
    return nodes.length ? { nodes, sinceDays: 30 } : undefined;
  }

  /**
   * Проверяет, что панель отвечает и какие возможности на ней есть.
   * Разрушающие действия не пробуются — их наличие выводится из чтения.
   */
  async probe(sampleUserRef?: string): Promise<{ reachable: boolean; caps: Capabilities; note: string }> {
    const ping = await this.call('/api/users?size=1');
    if (ping.status === 401 || ping.status === 403) {
      this.caps = { ...EMPTY_CAPS };
      return { reachable: true, caps: this.caps, note: 'панель отвечает, но токен не принят' };
    }
    if (ping.status >= 500 || ping.status === 0) {
      this.caps = { ...EMPTY_CAPS };
      return { reachable: false, caps: this.caps, note: `панель ответила ${ping.status}` };
    }

    if (!sampleUserRef) {
      this.caps = { ...EMPTY_CAPS };
      return { reachable: true, caps: this.caps, note: 'нет клиента для проверки — возможности определятся при первом обращении' };
    }

    const profile = await this.profile(sampleUserRef);
    const devices = profile ? await this.devices(sampleUserRef) : undefined;
    this.caps = {
      profile: !!profile,
      devices: devices !== undefined,
      deleteDevice: devices !== undefined,
      resetDevices: devices !== undefined,
      revoke: !!profile,
    };
    return { reachable: true, caps: this.caps, note: profile ? 'клиент найден' : 'клиент не найден по этому идентификатору' };
  }
}
