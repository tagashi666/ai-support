import type { FastifyInstance } from 'fastify';
import { config, log } from '../../config.js';
import { NoSenderError, WindowClosedError } from '../../core/outbox.js';
import { linkSuggestionAnswer, syncExamples } from '../../ai/examples.js';
import { inspectUpload, readMediaFile, removeMediaFile, saveUploadedMedia } from '../../core/media.js';
import { limitUploadBytes, UploadTooLargeError } from '../helpers.js';
import type { RouteContext } from '../context.js';
import { apiError } from '../errors.js';

/** Ответ оператора: текст и загрузка файлов. */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store, outbox, operations, actorOf } = ctx;

  // Пачки загрузок оператора: `seen` — индексы, уже доставленные клиенту,
  // `pending` — те, что отправляются прямо сейчас. Повтор индекса после
  // ошибки разрешён, повтор доставленного или летящего — нет.
  const uploadBatches = new Map<string, { seen: Set<number>; pending: Set<number>; at: number }>();
  app.post<{ Params: { id: string }; Body: { text?: string; suggestionId?: number; edited?: boolean; replyTo?: string; replyExcerpt?: string } }>(
    '/api/conversations/:id/reply',
    async (request, reply) => {
      const text = request.body?.text?.trim();
      if (!text) return reply.code(400).send(apiError('bad_request', 'Пустое сообщение'));
      const conversationId = Number(request.params.id);
      const actor = actorOf(request);
      const claimed = operations.claim(conversationId, actor);
      if (!claimed.ok) return reply.code(409).send(apiError('locked_by_other', `Диалог уже ведёт ${claimed.owner}`));
      const responseMs = operations.pendingResponseMs(conversationId);
      const suggestionId = request.body?.suggestionId;
      if (suggestionId !== undefined) {
        const suggestion = store.getSuggestion(suggestionId);
        if (!suggestion || suggestion.conversation_id !== conversationId) {
          return reply.code(400).send(apiError('bad_request', 'Предложка не относится к этому диалогу'));
        }
      }
      try {
        const sent = await outbox.send(
          conversationId,
          { text, replyToExternalId: request.body?.replyTo, replyExcerpt: request.body?.replyExcerpt },
          'agent',
          request.body?.suggestionId,
        );
        if (request.body?.suggestionId) {
          store.decideSuggestion(request.body.suggestionId, request.body.edited ? 'edited' : 'sent');
          // Итог предложки — материал для разбора «AI → оператор».
          linkSuggestionAnswer(store, request.body.suggestionId, sent.message?.id, text);
        }
        try { syncExamples(store); } catch (err) { log.debug('Примеры ответов оператора не обновлены', err); }
        operations.recordActivity(actor, 'reply', conversationId, responseMs);
        return { ok: true, message: sent.message };
      } catch (err) {
        if (err instanceof WindowClosedError) return reply.code(409).send(apiError('window_closed', err.message));
        if (err instanceof NoSenderError) return reply.code(501).send(apiError('no_sender', err.message));
        log.error('Отправка не удалась', err);
        return reply.code(502).send(apiError('upstream', `Отправить не удалось: ${(err as Error).message}`));
      }
    },
  );

  app.post<{ Params: { id: string }; Body: AsyncIterable<Uint8Array> }>(
    '/api/conversations/:id/attachments',
    async (request, reply) => {
      const conversationId = Number(request.params.id);
      const conversation = store.getConversation(conversationId);
      if (!conversation) return reply.code(404).send(apiError('not_found', 'Диалог не найден'));
      if (!outbox.supportsAttachments(conversation.channel)) {
        return reply.code(501).send(apiError('bad_request', 'Этот канал принимает только текстовые ответы'));
      }
      const actor = actorOf(request);
      const claimed = operations.claim(conversationId, actor);
      if (!claimed.ok) return reply.code(409).send(apiError('locked_by_other', `Диалог уже ведёт ${claimed.owner}`));
      const responseMs = operations.pendingResponseMs(conversationId);

      const decodeHeader = (name: string, fallback = ''): string => {
        const raw = request.headers[name];
        if (typeof raw !== 'string') return fallback;
        try { return decodeURIComponent(raw); } catch { return fallback; }
      };
      const original = decodeHeader('x-file-name', 'attachment.bin')
        .replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, 160) || 'attachment.bin';
      const declaredMime = decodeHeader('x-file-type', 'application/octet-stream').slice(0, 120);
      const caption = decodeHeader('x-caption').trim().slice(0, 1024) || undefined;
      const batchId = String(request.headers['x-upload-batch'] ?? '').slice(0, 80);
      const batchSize = Number(request.headers['x-upload-batch-size']);
      const batchIndex = Number(request.headers['x-upload-index']);
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(batchId) || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10
          || !Number.isInteger(batchIndex) || batchIndex < 0 || batchIndex >= batchSize) {
        return reply.code(400).send(apiError('bad_request', 'В одной отправке разрешено от 1 до 10 файлов'));
      }
      const batchKey = `${actor.key}:${batchId}`;
      const now = Date.now();
      if (uploadBatches.size > 500) {
        for (const [key, value] of uploadBatches) if (now - value.at > 30 * 60_000) uploadBatches.delete(key);
      }
      const batch = uploadBatches.get(batchKey) ?? { seen: new Set<number>(), pending: new Set<number>(), at: now };
      if (batch.seen.has(batchIndex) || batch.pending.has(batchIndex)) {
        return reply.code(409).send(apiError('bad_request', 'Этот файл уже был принят'));
      }
      batch.at = now; uploadBatches.set(batchKey, batch);

      const declaredBytes = Number(request.headers['content-length']);
      if (Number.isFinite(declaredBytes) && declaredBytes > config.mediaMaxFileBytes) {
        return reply.code(413).send(apiError('bad_request', 'Максимальный размер файла — 45 МБ'));
      }
      if (store.mediaBytes() >= config.mediaMaxTotalBytes) {
        return reply.code(507).send(apiError('bad_request', 'Хранилище вложений заполнено'));
      }

      let saved: Awaited<ReturnType<typeof saveUploadedMedia>> | undefined;
      batch.pending.add(batchIndex);
      try {
        saved = await saveUploadedMedia(limitUploadBytes(request.body, config.mediaMaxFileBytes), config.mediaMaxFileBytes);
        if (store.mediaBytes() + saved.bytes > config.mediaMaxTotalBytes) {
          await removeMediaFile(saved.fileRef);
          return reply.code(507).send(apiError('bad_request', 'Хранилище вложений заполнено'));
        }
        const inspected = inspectUpload(saved.prefix, declaredMime, original);
        if (inspected.dangerous && request.headers['x-dangerous-confirmed'] !== 'yes') {
          await removeMediaFile(saved.fileRef);
          return reply.code(409).send(apiError('bad_request', 'Для потенциально исполняемого файла требуется явное подтверждение'));
        }
        const bytes = await readMediaFile(saved.fileRef);
        const sent = await outbox.sendAttachment(
          conversationId,
          { bytes, fileName: original, mimeType: inspected.mimeType, mediaType: inspected.mediaType,
            caption, replyToExternalId: decodeHeader('x-reply-to') || undefined },
          saved,
        );
        // Индекс считается принятым только после доставки: повтор после
        // 409/413/507/502 должен дойти до отправки, а не упереться в «уже принят».
        batch.seen.add(batchIndex);
        // Файл уже у клиента: сбой журнала не должен удалять вложение и
        // превращаться в 502, иначе оператор отправит дубль.
        try {
          store.logEvent('attachment_sent', conversationId, {
            actor: actor.name, name: original, bytes: saved.bytes, mime: inspected.mimeType,
            sha256: saved.sha256, dangerous: inspected.dangerous,
          });
          operations.recordActivity(actor, 'reply', conversationId, responseMs);
        } catch (err) {
          log.error('Вложение отправлено, но журнал не записан', err);
        }
        return { ok: true, message: sent.message };
      } catch (err) {
        if (saved) await removeMediaFile(saved.fileRef);
        if (err instanceof WindowClosedError) return reply.code(409).send(apiError('window_closed', err.message));
        if (err instanceof UploadTooLargeError) return reply.code(413).send(apiError('bad_request', err.message));
        log.error('Отправка вложения не удалась', err);
        return reply.code(502).send(apiError('upstream', `Файл не отправлен: ${(err as Error).message}`));
      } finally {
        batch.pending.delete(batchIndex);
      }
    },
  );
}
