import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { runtime } from '../../core/settings.js';
import {
  detectedInterfaceMode, effectiveInterfaceMode, INTERFACE_MODES, loadInterfaceOverrides, loadShippedManifest,
  MAX_INTERFACE_IMAGE_BYTES, parseInterfaceKnowledge, readInterfaceImage, saveInterfaceImage, saveInterfaceOverrides,
} from '../../ai/interface-kb.js';
import { inspectUpload } from '../../core/media.js';
import { etagMatches, IMMUTABLE_PRIVATE } from '../helpers.js';
import type { RouteContext } from '../context.js';

/** Справочник интерфейса Bedolaga: режим, правки и картинки. */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store, operations, actorOf } = ctx;

  // --- справочник интерфейса Bedolaga ------------------------------------

  const interfaceKbState = () => {
    const shipped = loadShippedManifest();
    const overrides = loadInterfaceOverrides();
    const screensFor = (mode: 'full' | 'lite') => (shipped ? parseInterfaceKnowledge(shipped, mode, overrides)?.screens : null) ?? [];
    const detected = detectedInterfaceMode();
    return {
      enabled: runtime.bedolagaInterfaceKb,
      setting: runtime.bedolagaInterfaceMode,
      effectiveMode: effectiveInterfaceMode(runtime.bedolagaInterfaceMode),
      detected: detected ?? null,
      modes: INTERFACE_MODES,
      shipped,
      overrides,
      resolved: { full: screensFor('full'), lite: screensFor('lite') },
    };
  };

  app.get('/api/interface-kb', async () => interfaceKbState());

  app.put<{ Body: unknown }>('/api/interface-kb/overrides', async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply.code(400).send({ error: 'Ожидался объект с правками' });
    const overrides = await saveInterfaceOverrides(body);
    store.logEvent('interface_kb_updated', null, {
      actor: actorOf(request).key, edited: Object.keys(overrides.screens).length, added: overrides.added.length,
    });
    return { ok: true, overrides };
  });

  // Картинка приходит сырым телом. Тип определяется по сигнатуре, а не по
  // заголовкам и имени файла; имя на диске выбирает сервер.
  app.post<{ Body: AsyncIterable<Uint8Array> }>('/api/interface-kb/images', async (request, reply) => {
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_INTERFACE_IMAGE_BYTES) {
      return reply.code(413).send({ error: 'Картинка больше 8 МБ' });
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const raw of request.body) {
      const chunk = Buffer.from(raw);
      total += chunk.byteLength;
      if (total > MAX_INTERFACE_IMAGE_BYTES) return reply.code(413).send({ error: 'Картинка больше 8 МБ' });
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (!bytes.length) return reply.code(400).send({ error: 'Пустой файл' });
    const mime = inspectUpload(bytes.subarray(0, 512), '', '').mimeType;
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const)[mime as 'image/png'];
    if (!ext) return reply.code(400).send({ error: 'Нужна картинка PNG, JPEG или WebP' });
    try {
      return { image: await saveInterfaceImage(bytes, ext) };
    } catch (err) {
      return reply.code(507).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { '*': string } }>('/api/interface-kb/images/*', async (request, reply) => {
    // Cookie-билет проходит onRequest без проверки прав, поэтому право читать
    // справочник проверяем здесь.
    if (!operations.can(actorOf(request), 'knowledge:read')) {
      return reply.code(403).send({ error: 'Недостаточно прав для этого действия' });
    }
    const image = request.params['*'];
    const segments = image.split('/');
    if (!/^[A-Za-z0-9._\/-]{1,240}$/.test(image) || segments.some((part) => !part || part === '.' || part === '..')) {
      return reply.code(404).send({ error: 'Картинка не найдена' });
    }
    const bytes = await readInterfaceImage(image);
    const mime = bytes ? inspectUpload(bytes.subarray(0, 512), '', '').mimeType : '';
    if (!bytes || !/^image\/(?:png|jpeg|webp)$/.test(mime)) return reply.code(404).send({ error: 'Картинка не найдена' });
    const local = image.startsWith('local/');
    const etag = `"ikb-${createHash('sha1').update(bytes).digest('hex').slice(0, 20)}"`;
    const cache = local ? IMMUTABLE_PRIVATE : 'private, no-cache';
    if (etagMatches(request.headers['if-none-match'], etag)) {
      return reply.code(304).header('etag', etag).header('cache-control', cache).send();
    }
    return reply
      .header('cache-control', cache)
      .header('etag', etag)
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'inline')
      .type(mime)
      .send(bytes);
  });
}
