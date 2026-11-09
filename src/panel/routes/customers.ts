import type { FastifyInstance } from 'fastify';
import { log } from '../../config.js';
import type { Conversation } from '../../core/store.js';
import {
  bedolagaSubscriptionRecords, collectBedolagaPages, loadBedolagaCustomer, normalizeBedolagaSubscription,
  resolveVerifiedBedolagaUser,
} from '../../integrations/bedolaga-customer.js';
import type { RemnawaveClient } from '../../integrations/remnawave.js';
import type { RouteContext } from '../context.js';

/** Карточка клиента: источники, Bedolaga (просмотр и продление), профиль, подписка Remnawave. */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store, customers, remnawave, remnawaves, bedolaga, operations, actorOf } = ctx;

  const bedolagaExtensionLocks = new Set<string>();
  // Журнал операций продления живёт в БД, а не в памяти: продление
  // необратимо, и повтор того же operationId после рестарта процесса не
  // должен превратиться во второе начисление.
  type ExtensionOperation = {
    actorKey: string;
    conversationId: number;
    subscriptionId: number;
    days: number;
    state: 'pending' | 'confirmed' | 'unknown';
    response?: Record<string, unknown>;
    updatedAt: number;
  };
  const EXTENSION_STATE = 'bedolaga:extend-op:';
  const bedolagaExtensionOperations = {
    get(operationId: string): ExtensionOperation | undefined {
      const raw = store.getState(EXTENSION_STATE + operationId);
      if (!raw) return undefined;
      try { return JSON.parse(raw) as ExtensionOperation; } catch { return undefined; }
    },
    set(operationId: string, value: ExtensionOperation): void {
      store.setState(EXTENSION_STATE + operationId, JSON.stringify(value));
    },
    prune(olderThanMs: number): void {
      store.pruneState(EXTENSION_STATE, olderThanMs);
    },
  };
  /** Карточка со всеми источниками. Может ходить в сеть — вызывается фоном. */
  app.get<{ Params: { id: string } }>('/api/conversations/:id/customer', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    if (!customers) return reply.code(501).send({ error: 'Источники карточки не настроены' });
    const customer = await customers.get(conversation).catch(() => null);
    return { customer, checkedAt: customers.checkedAt(conversation) };
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/customer/refresh', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    if (!customers) return reply.code(501).send({ error: 'Источники карточки не настроены' });
    const customer = await customers.build(conversation);
    return { ok: true, customer, checkedAt: customers.checkedAt(conversation) ?? Date.now() };
  });

  /**
   * Расширенная карточка Bedolaga содержит баланс, платежи и рефералов,
   * поэтому доступна только оператору, который вправе отвечать в диалоге.
   * Секретные URL подписок и внешние ID платежей отсекаются нормализатором.
   */
  app.get<{ Params: { id: string } }>('/api/conversations/:id/bedolaga/customer', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    if (!bedolaga) return reply.code(501).send({ error: 'Bedolaga не настроена' });
    try {
      const customer = await loadBedolagaCustomer(bedolaga, conversation);
      if (!customer) return reply.code(404).send({ error: 'Клиент Bedolaga не найден' });
      return {
        customer,
        capabilities: {
          canExtendSubscription: customer.identityVerified
            && operations.can(actorOf(request), 'bedolaga:extend'),
        },
      };
    } catch (err) {
      log.error('Не удалось загрузить карточку клиента Bedolaga', err);
      return reply.code(502).send({ error: 'Bedolaga временно не отдала карточку клиента' });
    }
  });

  /**
   * Нейдемпотентное продление подписки. Перед POST обязательно заново
   * получаем список подписок клиента: это одновременно защита от подмены
   * subscription id и от продления устаревшей/чужой карточки.
   */
  app.post<{
    Params: { id: string; subscriptionId: string };
    Body: { days?: unknown; operationId?: unknown };
  }>('/api/conversations/:id/bedolaga/subscriptions/:subscriptionId/extend', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    if (!bedolaga) return reply.code(501).send({ error: 'Bedolaga не настроена' });
    const subscriptionId = Number(request.params.subscriptionId);
    const days = Number(request.body?.days);
    const operationId = typeof request.body?.operationId === 'string' ? request.body.operationId.trim() : '';
    if (!Number.isSafeInteger(subscriptionId) || subscriptionId <= 0) {
      return reply.code(400).send({ error: 'Некорректный ID подписки' });
    }
    if (!Number.isSafeInteger(days) || days <= 0 || days > 36_500) {
      return reply.code(400).send({ error: 'Количество дней должно быть целым числом от 1 до 36500' });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId)) {
      return reply.code(400).send({ error: 'Некорректный ключ операции' });
    }
    try {
      const actor = actorOf(request);
      const user = await resolveVerifiedBedolagaUser(bedolaga, conversation);
      const userId = Number(user?.['id']);
      if (!user || !Number.isSafeInteger(userId) || userId <= 0) {
        return reply.code(404).send({ error: 'Клиент Bedolaga не найден' });
      }

      const remote = await collectBedolagaPages((limit, offset) => bedolaga.subscriptions(userId, limit, offset));
      const owned = bedolagaSubscriptionRecords(user, remote.items).find((item) => {
        if (Number(item['id']) !== subscriptionId) return false;
        const ownerId = Number(item['user_id']);
        return Number.isSafeInteger(ownerId) && ownerId > 0 && ownerId === userId;
      });
      if (!owned) return reply.code(404).send({ error: 'Подписка этого клиента не найдена' });

      const now = Date.now();
      bedolagaExtensionOperations.prune(86_400_000);
      const prior = bedolagaExtensionOperations.get(operationId);
      if (prior) {
        const sameOperation = prior.actorKey === actor.key
          && prior.conversationId === conversation.id
          && prior.subscriptionId === subscriptionId
          && prior.days === days;
        if (!sameOperation) return reply.code(409).send({ error: 'Ключ операции уже использован для другого продления' });
        if (prior.state === 'confirmed' && prior.response) return prior.response;
        if (prior.state === 'unknown') {
          return reply.code(202).send({
            ok: false,
            outcome: 'unknown',
            warning: 'Исход запроса Bedolaga неизвестен. Проверьте срок подписки перед новой операцией.',
          });
        }
        return reply.code(409).send({ error: 'Эта операция продления уже выполняется' });
      }

      // Один subscription может быть виден в нескольких диалогах/папках.
      // Блокируем его глобально в рамках этой Bedolaga-интеграции.
      const lockKey = String(subscriptionId);
      if (bedolagaExtensionLocks.has(lockKey)) {
        return reply.code(409).send({ error: 'Продление этой подписки уже выполняется' });
      }
      bedolagaExtensionLocks.add(lockKey);
      bedolagaExtensionOperations.set(operationId, {
        actorKey: actor.key,
        conversationId: conversation.id,
        subscriptionId,
        days,
        state: 'pending',
        updatedAt: now,
      });
      try {
        // Ровно один вызов: автоматический retry здесь удвоил бы начисление.
        const result = await bedolaga.extendSubscription(subscriptionId, days);
        const resultId = Number(result['id']);
        const resultOwnerId = Number(result['user_id']);
        const responseMatchesOwned = Number.isSafeInteger(resultId)
          && resultId === subscriptionId
          && Number.isSafeInteger(resultOwnerId)
          && resultOwnerId === userId;
        const warning = responseMatchesOwned
          ? undefined
          : 'Bedolaga приняла продление, но вернула неполный ответ. Карточка будет обновлена из Bedolaga.';
        if (!responseMatchesOwned) {
          // Путь и владение были проверены до POST. После 2xx нельзя
          // возвращать failure и провоцировать повторное начисление. Поля
          // неверной/пустой модели наружу не отдаём.
          log.warn(`Bedolaga вернула неполный ответ для подписки #${subscriptionId}`);
        }
        const subscription = normalizeBedolagaSubscription({
          ...owned,
          ...(responseMatchesOwned ? result : {}),
          id: subscriptionId,
          user_id: userId,
        });
        try {
          store.addNote(
            conversation.id,
            `Bedolaga: оператор ${actor.name} продлил подписку #${subscriptionId} на ${days} дн.`,
          );
        } catch (err) {
          // Ошибка локальной заметки не отменяет уже принятый Bedolaga POST.
          log.warn('Продление Bedolaga выполнено, но локальная заметка не сохранена', err);
        }
        void customers?.build(conversation).catch((err) => log.warn('Не удалось обновить сводную карточку после продления', err));
        const response = { ok: true, subscription, warning };
        bedolagaExtensionOperations.set(operationId, {
          actorKey: actor.key,
          conversationId: conversation.id,
          subscriptionId,
          days,
          state: 'confirmed',
          response,
          updatedAt: Date.now(),
        });
        return response;
      } catch (err) {
        // После начала неидемпотентного POST сетевой сбой не доказывает, что
        // Bedolaga отклонила запрос. Помечаем исход неопределённым и не даём
        // повторить тот же ключ операции как новый POST.
        bedolagaExtensionOperations.set(operationId, {
          actorKey: actor.key,
          conversationId: conversation.id,
          subscriptionId,
          days,
          state: 'unknown',
          updatedAt: Date.now(),
        });
        log.error('Исход продления подписки Bedolaga неизвестен', err);
        return reply.code(202).send({
          ok: false,
          outcome: 'unknown',
          warning: 'Исход запроса Bedolaga неизвестен. Проверьте срок подписки перед новой операцией.',
        });
      } finally {
        bedolagaExtensionLocks.delete(lockKey);
      }
    } catch (err) {
      log.error('Не удалось продлить подписку Bedolaga', err);
      return reply.code(502).send({ error: 'Bedolaga не подтвердила продление подписки' });
    }
  });

  // --- единый клиент и совместная работа -------------------------------

  app.get<{ Params: { id: string } }>('/api/conversations/:id/profile', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    return { profile: operations.profile(conversation) };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/conversations/:id/profile', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    return { ok: true, profile: operations.updateProfile(conversation, request.body ?? {}) };
  });

  app.post<{ Params: { id: string }; Body: { text?: string } }>('/api/conversations/:id/profile/notes', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    try {
      return { ok: true, note: operations.addProfileNote(conversation, actorOf(request), request.body?.text) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // --- подписка клиента --------------------------------------------------

  /**
   * Идентификатор в Remnawave ищется тем же путём, что и карточка клиента:
   * поле в данных бедолаги, затем поиск по telegram id и нику, включая
   * свободное описание. Отдельная упрощённая логика здесь уже приводила
   * к «нет идентификатора» на клиентах, которые в панели есть.
   */
  const resolveTarget = async (conversation: Conversation): Promise<{
    ref?: string;
    client?: RemnawaveClient;
    panel?: { id: string; name: string; client: RemnawaveClient; readOnly: boolean };
  }> => {
    if (!customers) return {};
    const profile = await customers.get(conversation).catch(() => null);
    const linked = new Set(store.conversationSourceIds(conversation.id));
    const match = profile?.remnawaveRefs?.find((candidate) => linked.has(candidate.sourceId))
      ?? profile?.remnawaveRefs?.[0];
    const panel = remnawaves.find((candidate) => candidate.id === match?.sourceId)
      ?? remnawaves.find((candidate) => linked.has(candidate.id))
      ?? remnawaves[0];
    return { ref: match?.ref ?? profile?.remnawaveRef, client: panel?.client ?? remnawave, panel };
  };

  /** Разбор связки с Remnawave: показывает, что искали и что нашли. */
  app.get<{ Params: { id: string } }>('/api/conversations/:id/subscription/explain', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    const profile = customers ? await customers.build(conversation).catch(() => null) : null;
    const target = await resolveTarget(conversation);
    if (!target.client) return reply.code(501).send({ error: 'Панель Remnawave не подключена' });
    return target.client.explain(
      profile?.identity?.telegramId ?? conversation.tg_user_id ?? undefined,
      profile?.identity?.username ?? conversation.username ?? undefined,
    );
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/subscription', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
    const target = await resolveTarget(conversation);
    if (!target.client) return reply.code(501).send({ error: 'Панель Remnawave не подключена' });
    const ref = target.ref;
    if (!ref) {
      return reply.code(404).send({
        error: `Клиент не найден в Remnawave ни по telegram id, ни по нику. Проверьте, что он есть в панели — при необходимости впишите ${conversation.tg_user_id ?? 'telegram id'} в поле «Описание» его записи.`,
      });
    }

    const profile = await target.client.profile(ref);
    const devices = await target.client.devices(ref);
    return {
      ref,
      panel: target.panel ? { id: target.panel.id, name: target.panel.name } : null,
      profile: profile ?? null,
      devices: devices ?? null,
      capabilities: target.client.capabilities(),
    };
  });

  /**
   * Разрушающие действия. Оператор подтверждает их в панели, а не AI —
   * сброс устройств и перевыпуск ключа клиент почувствует немедленно.
   */
  app.post<{ Params: { id: string }; Body: { action?: string; hwid?: string } }>(
    '/api/conversations/:id/subscription/action',
    async (request, reply) => {
      const conversation = store.getConversation(Number(request.params.id));
      if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });
      const target = await resolveTarget(conversation);
      if (!target.client) return reply.code(501).send({ error: 'Панель Remnawave не подключена' });
      const ref = target.ref;
      if (!ref) return reply.code(404).send({ error: 'Клиент не найден в Remnawave' });

      const { action, hwid } = request.body ?? {};
      let ok = false;
      if (action === 'reset-devices') ok = await target.client.resetDevices(ref);
      else if (action === 'revoke') ok = await target.client.revoke(ref);
      else if (action === 'delete-device' && hwid) ok = await target.client.deleteDevice(ref, hwid);
      else return reply.code(400).send({ error: 'Неизвестное действие' });

      store.logEvent(`remnawave_${action}`, conversation.id, { ref, hwid, ok });
      if (!ok) return reply.code(502).send({ error: 'Панель Remnawave отклонила операцию' });

      // След в переписке: через неделю никто не вспомнит, кто сбросил устройства.
      const label = action === 'reset-devices' ? 'сброшены все устройства'
        : action === 'revoke' ? 'подписка перевыпущена'
        : `удалено устройство ${hwid}`;
      store.addNote(conversation.id, `Оператор: ${label}`);
      return { ok: true };
    },
  );
}
