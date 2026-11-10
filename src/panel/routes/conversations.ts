import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { type ConversationStatus, StatusSyncError } from '../../core/outbox.js';
import { runtime } from '../../core/settings.js';
import { queueAutoLearn, requeueAutoLearn } from '../../ai/mining.js';
import { channelAvailability, decorate, livePendingSuggestion } from '../helpers.js';
import type { RouteContext } from '../context.js';
import { apiError } from '../errors.js';
import { AUTHOR_EVENT, presenceOf } from '../thread.js';

/** Диалоги: список, папки, история, прочтение, присутствие, удержание, заметки и статус. */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store, outbox, notifier, customers, onOpened, operations, actorOf, runJob, live, pushV2 } = ctx;

  // Кадр presence (10.6 п.6) — только когда состав «кто смотрит / печатает» изменился,
  // а не на каждый heartbeat раз в 15 с. Истечение (90 с) панель считает сама по `at`.
  const lastPresence = new Map<number, string>();
  const pushPresence = (id: number): void => {
    const presence = presenceOf(operations, id);
    const signature = presence.map((entry) => `${entry.id}:${entry.state}`).sort().join(',');
    if (lastPresence.get(id) === signature) return;
    if (signature) lastPresence.set(id, signature); else lastPresence.delete(id);
    if (lastPresence.size > 2000) lastPresence.clear();
    pushV2({ type: 'thread', kind: 'presence', conversation_id: id, presence });
  };

  // --- диалоги ---------------------------------------------------------

  app.get('/api/conversations', async () => ({
    conversations: store.listConversations().map((item) => decorate(item, store, operations)),
    channels: channelAvailability(outbox),
    aiMode: runtime.aiMode,
  }));

  app.get('/api/inbox/meta', async () => ({
    sources: store.sourceAccounts().map(({ id, kind, name, enabled }) => ({ id, kind, name, enabled: Boolean(enabled) })),
    folders: store.folders(),
    serviceProfiles: store.serviceProfiles(),
  }));

  app.post<{ Body: { id?: number; name?: string; color?: string | null; sourceIds?: string[] } }>(
    '/api/inbox/folders',
    async (request, reply) => {
      try {
        const folder = store.saveFolder({
          id: request.body?.id ? Number(request.body.id) : undefined,
          name: request.body?.name ?? '',
          color: request.body?.color ?? null,
          sourceIds: Array.isArray(request.body?.sourceIds) ? request.body.sourceIds : [],
        });
        return { ok: true, folder, folders: store.folders() };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/inbox/folders/:id', async (request, reply) => {
    if (!store.deleteFolder(Number(request.params.id))) return reply.code(404).send({ error: 'Папка не найдена' });
    return { ok: true, folders: store.folders() };
  });

  // GET только читает. Отметка прочтения в Telegram живёт в POST /read: раньше
  // её дёргала каждая фоновая синхронизация открытого диалога.
  app.get<{ Params: { id: string }; Querystring: { after?: string; before?: string } }>('/api/conversations/:id', async (request, reply) => {
    const conversation = store.getConversation(Number(request.params.id));
    if (!conversation) return reply.code(404).send({ error: 'Диалог не найден' });

    if (request.query.before !== undefined) {
      // Подгрузка ранней истории: тред показывает последние 200 сообщений.
      const before = Number(request.query.before);
      if (!/^\d{1,15}$/.test(request.query.before) || !Number.isSafeInteger(before)) {
        return reply.code(400).send({ error: 'Некорректный параметр before' });
      }
      const page = store.listMessagesBefore(conversation.id, before, 100);
      return {
        messages: page,
        attachments: store.attachmentsFor(page.map((message) => message.id)),
        hasMore: page.length === 100,
      };
    }

    if (request.query.after !== undefined) {
      // Фоновая синхронизация: только сообщения новее известного клиенту.
      const after = Number(request.query.after);
      if (!/^\d{1,15}$/.test(request.query.after) || !Number.isSafeInteger(after)) {
        return reply.code(400).send({ error: 'Некорректный параметр after' });
      }
      const fresh = store.listMessagesAfter(conversation.id, after);
      return {
        conversation: decorate(conversation, store, operations),
        messages: fresh,
        attachments: store.attachmentsFor(fresh.map((message) => message.id)),
        suggestion: livePendingSuggestion(store, conversation),
        after,
      };
    }

    const messages = store.listMessages(conversation.id);

    return {
      conversation: decorate(conversation, store, operations),
      messages,
      hasMore: messages.length === 200,
      attachments: store.attachmentsFor(messages.map((message) => message.id)),
      suggestion: livePendingSuggestion(store, conversation),
      // Только кэш: за свежей карточкой панель сходит отдельным запросом,
      // уже показав переписку.
      ...(customers ? (({ profile, stale }) => ({ customer: profile, customerStale: stale }))(customers.peek(conversation)) : { customer: null, customerStale: false }),
    };
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/read', async (request, reply) => {
    const id = Number(request.params.id);
    const before = store.getConversation(id);
    if (!before) return reply.code(404).send({ error: 'Диалог не найден' });
    store.markRead(id);
    const conversation = store.getConversation(id)!;
    onOpened?.(conversation);
    return { ok: true, conversation: decorate(conversation, store, operations) };
  });

  /** Присутствие для совместной работы не означает, что оператор забрал ответ у AI. */
  app.post<{ Params: { id: string }; Body: { state?: string } }>('/api/conversations/:id/presence', async (request, reply) => {
    const id = Number(request.params.id);
    if (!store.getConversation(id)) return reply.code(404).send({ error: 'Диалог не найден' });
    operations.presence(id, actorOf(request), request.body?.state);
    pushPresence(id);
    return { ok: true, collaboration: operations.collaboration(id) };
  });

  /**
   * Lease не только останавливает AI, но и не даёт двум операторам ответить одновременно.
   * `typing: true` (новая панель, 10.2 п.6) — только «человек печатает»: помощник
   * молчит 45 с, а диалог не закрепляется, и коллега может его взять.
   */
  app.post<{ Params: { id: string }; Body: { state?: string; force?: boolean; typing?: boolean } }>('/api/conversations/:id/engage', async (request, reply) => {
    const id = Number(request.params.id);
    if (!store.getConversation(id)) return reply.code(404).send(apiError('not_found', 'Диалог не найден'));
    const actor = actorOf(request);
    if (request.body?.typing === true) {
      store.markOperatorActive(id);
      operations.presence(id, actor, 'typing');
      pushPresence(id);
      return { ok: true, collaboration: operations.collaboration(id) };
    }
    const force = request.body?.force === true && operations.can(actor, 'conversation:assign');
    const claimed = operations.claim(id, actor, force);
    if (!claimed.ok) {
      return reply.code(409).send({ ...apiError('locked_by_other', `Диалог уже ведёт ${claimed.owner}`), collaboration: operations.collaboration(id) });
    }
    // В общий журнал engage не пишется (это heartbeat), поэтому захват
    // диалога, особенно принудительный, фиксируем отдельно.
    if (claimed.acquired) operations.audit(actor, 'conversation.claim', 'conversations', id, { force }, request.ip);
    operations.presence(id, actor, request.body?.state);
    pushPresence(id);
    store.markOperatorActive(id);
    // Закрепление меняет секцию у всех, кто смотрит, а Store о нём не сообщает.
    if (claimed.acquired) live.touch([id]);
    return { ok: true, collaboration: operations.collaboration(id) };
  });

  app.post<{ Params: { id: string }; Body: { force?: boolean } }>('/api/conversations/:id/release', async (request, reply) => {
    const actor = actorOf(request);
    const force = request.body?.force === true && operations.can(actor, 'conversation:assign');
    const id = Number(request.params.id);
    if (!operations.release(id, actor, force)) return reply.code(409).send(apiError('locked_by_other', 'Диалог закреплён за другим оператором'));
    live.touch([id]);
    pushPresence(id);
    return { ok: true, collaboration: operations.collaboration(id) };
  });

  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    '/api/conversations/:id/note',
    async (request, reply) => {
      const text = request.body?.text?.trim();
      if (!text) return reply.code(400).send({ error: 'Пустая заметка' });
      const id = Number(request.params.id);
      if (!store.getConversation(id)) return reply.code(404).send({ error: 'Диалог не найден' });
      const added = store.addNote(id, text);
      // Автор заметки — подпись «Мария, 14:02» в ленте новой панели (без миграции, как у ответов).
      try { store.logEvent(AUTHOR_EVENT, id, { message_id: added.message.id, actor: actorOf(request).key }); } catch { /* подпись не обязательна */ }
      return { ok: true, message: added.message };
    },
  );

  app.post<{ Params: { id: string }; Body: { status?: string; aiMode?: string; escalated?: boolean; handoff?: boolean; hidden?: boolean } }>(
    '/api/conversations/:id/state',
    async (request, reply) => {
      const id = Number(request.params.id);
      const before = store.getConversation(id);
      if (!before) return reply.code(404).send(apiError('not_found', 'Диалог не найден'));
      const { status, aiMode, escalated, handoff, hidden } = request.body ?? {};
      if (hidden !== undefined && typeof hidden !== 'boolean') {
        return reply.code(400).send(apiError('bad_request', 'Некорректный флаг скрытия'));
      }
      if (status && !['open', 'pending', 'resolved'].includes(status)) {
        return reply.code(400).send(apiError('bad_request', 'Неизвестный статус диалога'));
      }
      if (aiMode !== undefined && !['inherit', 'off', 'shadow', 'suggest', 'auto'].includes(aiMode)) {
        return reply.code(400).send(apiError('bad_request', 'Неизвестный режим AI'));
      }
      if (status) {
        try {
          await outbox.syncStatus(before, status as ConversationStatus);
        } catch (err) {
          if (err instanceof StatusSyncError) {
            const code = err.statusCode === 502 ? 'upstream' : err.statusCode === 503 ? 'no_sender' : 'bad_request';
            return reply.code(err.statusCode).send(apiError(code, err.message));
          }
          throw err;
        }
      }
      if (typeof handoff === 'boolean') store.setHandoff(id, handoff ? Date.now() : null);
      if (hidden === true) {
        const conversation = store.hideConversation(id);
        store.logEvent('conversation_hidden', id, { actor: actorOf(request).key });
        return { ok: true, conversation };
      }
      if (hidden === false) {
        store.unhideConversation(id);
        store.logEvent('conversation_unhidden', id, { actor: actorOf(request).key });
      }
      if (status) store.setStatus(id, status);
      if (status === 'resolved' && before.status !== 'resolved' && before.status !== 'closed') {
        operations.recordActivity(actorOf(request), 'resolved', id);
      }
      if (aiMode === 'inherit' || aiMode === 'off' || aiMode === 'shadow' || aiMode === 'suggest' || aiMode === 'auto') store.setAiMode(id, aiMode);
      if (typeof escalated === 'boolean') {
        store.setEscalated(id, escalated, escalated ? 'high' : undefined);
        if (escalated) {
          const conversation = store.getConversation(id)!;
          void notifier?.notify('escalated', conversation, {
            excerpt: store.lastInboundMessage(id)?.text ?? undefined,
            reason: 'отмечен важным в панели',
          });
        }
      }
      // Один диалог — не материал для статьи: промпт майнинга требует
      // подтверждения несколькими случаями. Копим закрытые и разбираем пачкой.
      const batchIds = status === 'resolved' && before.status !== 'resolved' && runtime.autoLearn && config.ai.apiKeys.length
        ? queueAutoLearn(store, id) : null;
      if (batchIds) {
        const jobId = store.startJob('auto-learn');
        if (jobId <= 0) requeueAutoLearn(store, batchIds);
        if (jobId > 0) {
          runJob(jobId, 'auto-learn', { source: 'panel', conversationIds: batchIds, all: true, limit: batchIds.length }, (report) => {
            if (!report.dryRun && report.articles.length) operations.registerCandidates(report.articles, 'auto-learn');
          });
        }
      }
      // Кадр `conversation` шлёт само хранилище при настоящей смене режима,
      // передачи или важности — здесь второй кадр не нужен.
      const after = store.getConversation(id)!;
      return { ok: true, conversation: decorate(after, store, operations) };
    },
  );
}
