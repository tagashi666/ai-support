import { config, log, version } from '../config.js';
import type { Conversation, Store } from '../core/store.js';
import type { BedolagaClient } from '../channels/bedolaga.js';
import { displayNodeName, type RemnawaveClient } from './remnawave.js';
import { detectSubLink } from '../ai/sublink.js';

/**
 * Карточка клиента: кто он, что у него с подпиской и чем он пользуется.
 *
 * Источников три, и они дополняют друг друга: собственный Support API,
 * бедолага и панель Remnawave. Ищем по цепочке — telegram id, потом ник,
 * потом свободное описание в Remnawave: схема панели не хранит telegram id,
 * операторы обычно пишут его в description.
 */

export interface Profile {
  found: boolean;
  identity: { telegramId?: number; username?: string; name?: string };
  subscription?: {
    status?: string;
    expiresAt?: string;
    trafficUsed?: number;
    trafficLimit?: number;
    deviceLimit?: number;
    devices?: number;
    shortId?: string;
  };
  activity?: {
    firstSeen?: string;
    dailyAverageBytes?: number;
    topNodes?: { name: string; bytes: number }[];
    /** Последний узел, к которому подключался клиент (имя с псевдонимом). */
    lastNode?: string;
  };
  balance?: { amount?: number; currency?: string; payments?: number };
  remnawaveRef?: string;
  /** Версия сборки, собравшей профиль: чужой кэш переигрываем. */
  builtBy?: string;
  sources: string[];
  /** Почему не нашли — чтобы оператор не гадал, а видел место обрыва. */
  trace?: string[];
}

const num = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const str = (value: unknown): string | undefined =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;

function pick(source: Record<string, unknown> | undefined, ...names: string[]): unknown {
  if (!source) return undefined;
  for (const name of names) if (source[name] !== undefined && source[name] !== null) return source[name];
  return undefined;
}

export class CustomerDirectory {
  constructor(
    private readonly store: Store,
    private readonly bedolaga?: BedolagaClient,
    private readonly remnawave?: RemnawaveClient,
  ) {}

  async build(conversation: Conversation): Promise<Profile> {
    const linkRef = conversation.sub_link ? detectSubLink(conversation.sub_link)?.ref : undefined;
    const telegramId = conversation.tg_user_id ?? undefined;
    const username = conversation.username ?? undefined;

    const profile: Profile = {
      found: false,
      identity: { telegramId, username, name: conversation.display_name ?? undefined },
      sources: [],
      trace: [],
      builtBy: version,
    };

    // --- собственный Support API ---
    if (config.supportApi.enabled && telegramId) {
      const data = await this.fromSupportApi(telegramId);
      if (data) {
        profile.found = true;
        profile.sources.push('support api');
        profile.subscription = { ...profile.subscription, ...this.readSubscription(data) };
        profile.balance = this.readBalance(data);
      }
    }

    // --- бедолага: сначала по id, потом по нику ---
    let bedolagaUser: Record<string, unknown> | undefined;
    if (this.bedolaga) {
      try {
        if (telegramId) bedolagaUser = (await this.bedolaga.userByTelegramId(telegramId)) ?? undefined;
        if (!bedolagaUser && username) {
          const candidates = await this.bedolaga.searchUsers(username.replace(/^@/, ''));
          bedolagaUser = candidates.find((item) =>
            String(pick(item, 'username') ?? '').toLowerCase() === username.replace(/^@/, '').toLowerCase());
        }
      } catch (err) {
        log.debug('Бедолага не отдала клиента', err);
      }
    }

    if (!bedolagaUser && this.bedolaga) {
      profile.trace!.push(`в бедолаге не найден по ${telegramId ?? 'id'}${username ? ` и @${username.replace(/^@/, '')}` : ''}`);
    }

    if (bedolagaUser) {
      profile.found = true;
      profile.sources.push('бедолага');
      profile.identity.telegramId ??= num(pick(bedolagaUser, 'telegram_id', 'tg_id'));
      profile.identity.username ??= str(pick(bedolagaUser, 'username'));
      profile.identity.name ??= str(pick(bedolagaUser, 'first_name', 'full_name', 'name'));
      profile.subscription = { ...profile.subscription, ...this.readSubscription(bedolagaUser) };
      profile.balance = profile.balance ?? this.readBalance(bedolagaUser);
      profile.activity = {
        ...profile.activity,
        firstSeen: str(pick(bedolagaUser, 'created_at', 'registered_at', 'first_seen')),
      };

      const userId = num(pick(bedolagaUser, 'id'));
      if (userId) {
        try {
          const transactions = await this.bedolaga!.userTransactions(userId);
          if (transactions.length) {
            profile.balance = { ...profile.balance, payments: transactions.length };
            const earliest = transactions
              .map((t) => str(pick(t, 'created_at', 'date')))
              .filter((v): v is string => !!v)
              .sort()[0];
            if (earliest) profile.activity = { ...profile.activity, firstSeen: profile.activity?.firstSeen ?? earliest };
          }
        } catch (err) {
          log.debug('Транзакции недоступны', err);
        }
      }
    }

    // --- Remnawave: подписка, устройства, узлы ---
    if (this.remnawave) {
      // В бедолаге могут лежать ссылка на подписку, short uuid или email —
      // любое из этого встречается в записи Remnawave и годится как зацепка.
      const extra = [
        str(pick(bedolagaUser, 'subscription_url', 'subscriptionUrl')),
        str(pick(bedolagaUser, 'short_uuid', 'shortUuid')),
        str(pick(bedolagaUser, 'email')),
        profile.identity.name,
      ]
        .filter((v): v is string => !!v && v.length >= 4)
        .map((v) => {
          // Из ссылки подписки берём только хвост: он и есть short uuid.
          const tail = v.match(/\/([A-Za-z0-9_-]{8,})\/?$/);
          return tail?.[1] ?? v;
        });

      const ref =
        remnawaveRefFrom(bedolagaUser) ??
        (await this.remnawave.findUser(
          profile.identity.telegramId,
          profile.identity.username,
          [...(linkRef ? [linkRef] : []), ...extra],
        ));

      if (!ref) {
        profile.trace!.push(
          `в Remnawave не найден по ${[profile.identity.telegramId, profile.identity.username && '@' + profile.identity.username.replace(/^@/, '')].filter(Boolean).join(', ') || 'известным данным'}`,
        );
      }
      if (ref) {
        profile.remnawaveRef = ref;
        const panelProfile = await this.remnawave.profile(ref);
        if (panelProfile) {
          profile.found = true;
          profile.sources.push('remnawave');
          profile.subscription = {
            ...profile.subscription,
            status: panelProfile.status ?? profile.subscription?.status,
            expiresAt: panelProfile.expiresAt ?? profile.subscription?.expiresAt,
            trafficUsed: panelProfile.trafficUsed ?? profile.subscription?.trafficUsed,
            trafficLimit: panelProfile.trafficLimit ?? profile.subscription?.trafficLimit,
            deviceLimit: panelProfile.deviceLimit ?? profile.subscription?.deviceLimit,
            shortId: panelProfile.shortId ?? profile.subscription?.shortId,
          };
          const devices = await this.remnawave.devices(ref);
          if (devices) profile.subscription.devices = devices.length;

          // Первое подключение — «клиент с», если бедолага не дала точнее.
          if (panelProfile.firstConnectedAt) {
            profile.activity = { ...profile.activity, firstSeen: profile.activity?.firstSeen ?? panelProfile.firstConnectedAt };
            // Среднее в день считаем по трафику ЗА ВСЁ ВРЕМЯ: usedTrafficBytes
            // сбрасывается каждый расчётный период, и деление его на дни с
            // первого подключения занижало расход у давних клиентов.
            const lifetime = panelProfile.lifetimeUsed ?? panelProfile.trafficUsed;
            const firstMs = Date.parse(panelProfile.firstConnectedAt);
            if (lifetime && Number.isFinite(firstMs)) {
              const days = Math.max(1, (Date.now() - firstMs) / 86_400_000);
              profile.activity = { ...profile.activity, dailyAverageBytes: Math.round(lifetime / days) };
            }
          }

          const aliases = this.store.nodeAliases();

          // Разбивки трафика по узлам эта версия панели не отдаёт, зато знает
          // последний узел клиента — его и показываем, прогнав через псевдоним.
          const usage = await this.remnawave.usage(ref).catch(() => undefined);
          if (usage) {
            profile.activity = {
              ...profile.activity,
              topNodes: usage.nodes.map((n) => ({ ...n, name: displayNodeName(n.name, aliases) })),
            };
          } else if (panelProfile.lastNodeUuid) {
            const nodes = await this.remnawave.nodes().catch(() => undefined);
            const node = nodes?.find((n) => n.uuid === panelProfile.lastNodeUuid);
            if (node) {
              profile.activity = { ...profile.activity, lastNode: aliases[node.rawName]?.trim() || node.name };
            }
          }
        } else {
          profile.trace!.push(`запись ${ref} в Remnawave найдена, но профиль не читается`);
        }
      }
    }

    // Запасной расчёт среднего в день для источников без lifetime-трафика
    // (например, только бедолага). Если Remnawave уже посчитал по своему
    // lifetime выше — не перетираем.
    const used = profile.subscription?.trafficUsed;
    const since = profile.activity?.firstSeen ? Date.parse(profile.activity.firstSeen) : NaN;
    if (used && Number.isFinite(since) && profile.activity?.dailyAverageBytes === undefined) {
      const days = Math.max(1, (Date.now() - since) / 86_400_000);
      profile.activity = { ...profile.activity, dailyAverageBytes: Math.round(used / days) };
    }

    // Клиента нет ни в одной базе — это не эскалация, но отвечать вслепую
    // нельзя: так выглядят и чужие люди, и попытки выманить чужую подписку.
    this.store.setSuspicious(conversation.id, !profile.found);

    if (telegramId) this.store.saveCustomer(telegramId, profile.found ? profile : null);
    return profile;
  }

  /**
   * Карточка только из кэша, без единого сетевого запроса.
   *
   * Открытие диалога не должно ждать бедолагу и Remnawave: там бывает и
   * пересборка индекса на полторы тысячи записей. Оператор получает тред
   * мгновенно, а карточка догружается следом.
   */
  peek(conversation: Conversation): { profile: Profile | null; stale: boolean } {
    if (!conversation.tg_user_id) return { profile: null, stale: true };
    const cached = this.store.getCustomer(conversation.tg_user_id);
    const profile = (cached?.snapshot as Profile | undefined) ?? null;
    const fresh = !!cached?.snapshot_at
      && Date.now() - cached.snapshot_at < 3_600_000
      && profile?.builtBy === version;
    // Отдаём кэш для показа СРАЗУ, даже устаревший: при переключении карточка
    // должна мгновенно показать последнее известное, а не мигать в пустое,
    // пока идёт пересборка. Флаг stale заставит панель обновить её фоном.
    return { profile, stale: !fresh };
  }

  /** Кэш живёт час: оператору нужна карточка сразу, а не идеально свежая. */
  async get(conversation: Conversation, maxAgeMs = 3_600_000): Promise<Profile> {
    if (conversation.tg_user_id) {
      const cached = this.store.getCustomer(conversation.tg_user_id);
      const snapshot = cached?.snapshot as Profile | undefined;
      const fresh = cached?.snapshot_at && Date.now() - cached.snapshot_at < maxAgeMs;
      // Профиль, собранный другой версией, мог не знать про нынешние способы
      // поиска — держать его час значит чинить код и не видеть результата.
      if (snapshot && fresh && snapshot.builtBy === version) return snapshot;
    }
    return this.build(conversation);
  }

  private async fromSupportApi(telegramId: number): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await fetch(config.supportApi.url.replace(/\/+$/, '') + config.supportApi.userPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.supportApi.token}` },
        body: JSON.stringify({ telegram_id: telegramId }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as Record<string, unknown>;
      if (body['ok'] === false) return undefined;
      return (body['user'] as Record<string, unknown>) ?? body;
    } catch (err) {
      log.debug('Support API недоступен', err);
      return undefined;
    }
  }

  private readSubscription(source: Record<string, unknown>): Profile['subscription'] {
    const sub = (source['subscription'] as Record<string, unknown>) ?? source;
    return {
      status: str(pick(sub, 'status', 'state', 'subscription_status')),
      expiresAt: str(pick(sub, 'expire_at', 'expires_at', 'end_date', 'valid_until')),
      trafficUsed: num(pick(sub, 'used_traffic', 'traffic_used', 'used_traffic_bytes')),
      trafficLimit: num(pick(sub, 'traffic_limit', 'traffic_limit_bytes')),
      deviceLimit: num(pick(sub, 'device_limit', 'devices_limit', 'hwid_device_limit')),
    };
  }

  private readBalance(source: Record<string, unknown>): Profile['balance'] {
    const amount = num(pick(source, 'balance', 'balance_kopeks', 'balance_rub'));
    if (amount === undefined) return undefined;
    // Бедолага хранит баланс в копейках — приводим к рублям для человека.
    const isKopeks = pick(source, 'balance_kopeks') !== undefined;
    return { amount: isKopeks ? amount / 100 : amount, currency: '₽' };
  }
}

/** Ищет идентификатор Remnawave в данных клиента от бедолаги. */
export function remnawaveRefFrom(source: Record<string, unknown> | undefined): string | undefined {
  if (!source) return undefined;
  const roots = [source, source['subscription'] as Record<string, unknown> | undefined].filter(Boolean) as Record<string, unknown>[];
  for (const root of roots) {
    const found = str(pick(root, 'remnawave_uuid', 'remnawaveUuid', 'remnawave_user_id',
      'panel_uuid', 'subscription_uuid', 'short_uuid', 'shortUuid'));
    if (found) return found;
  }
  return undefined;
}
