import type { FastifyInstance } from 'fastify';
import { log } from '../../config.js';
import { runtime } from '../../core/settings.js';
import { type Area, listDocs, publishDraft, readDoc, removeDoc, slugFromTitle, writeDoc } from '../kbfiles.js';
import { effectiveInterfaceMode, loadInterfaceKnowledge } from '../../ai/interface-kb.js';
import { parseExportObject } from '../../integrations/tgexport.js';
import type { RouteContext } from '../context.js';

/** База знаний: кандидаты обучения, статьи, черновики и майнинг. */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store, onKbChanged, operations, actorOf, runJob } = ctx;

  // Очередь обучения отделена от опубликованной базы. Диалоги создают
  // кандидатов; в рабочую KB они попадают только после решения lead/admin.
  app.get<{ Querystring: { status?: string } }>('/api/learning/candidates', async (request) => ({
    candidates: operations.candidates(request.query.status ?? 'pending'),
  }));

  app.post<{ Params: { id: string }; Body: { decision?: string } }>('/api/learning/candidates/:id', async (request, reply) => {
    const actor = actorOf(request);
    if (!operations.can(actor, 'knowledge:review')) return reply.code(403).send({ error: 'Недостаточно прав' });
    const candidate = operations.candidate(Number(request.params.id));
    if (!candidate) return reply.code(404).send({ error: 'Кандидат не найден' });
    if (candidate.status !== 'pending') return reply.code(409).send({ error: 'Кандидат уже рассмотрен' });
    const decision = request.body?.decision;
    if (decision !== 'approved' && decision !== 'rejected') return reply.code(400).send({ error: 'Нужно approved или rejected' });
    try {
      if (decision === 'approved') {
        await publishDraft(String(candidate.file_name));
        onKbChanged?.();
      }
      if (!operations.decideCandidate(Number(request.params.id), decision, actor)) {
        return reply.code(409).send({ error: 'Кандидат уже рассмотрен' });
      }
      return { ok: true, candidates: operations.candidates('pending') };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // --- база знаний -------------------------------------------------------

  app.get('/api/kb', async (request) => ({
    kb: await listDocs('kb'),
    drafts: operations.can(actorOf(request), 'knowledge:review') ? await listDocs('draft') : [],
    interfaceScreens: loadInterfaceKnowledge(undefined, effectiveInterfaceMode(runtime.bedolagaInterfaceMode))?.screens ?? [],
  }));

  app.get<{ Params: { area: string; name: string } }>('/api/kb/:area/:name', async (request, reply) => {
    const area = request.params.area === 'draft' ? 'draft' : 'kb';
    try {
      return { name: request.params.name, text: await readDoc(area as Area, request.params.name) };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.put<{ Params: { area: string; name: string }; Body: { text?: string } }>(
    '/api/kb/:area/:name',
    async (request, reply) => {
      const area = request.params.area === 'draft' ? 'draft' : 'kb';
      const text = request.body?.text;
      if (typeof text !== 'string' || !text.trim()) return reply.code(400).send({ error: 'Пустой текст' });
      try {
        await writeDoc(area as Area, request.params.name, text);
        if (area === 'kb') onKbChanged?.();
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Body: { title?: string; text?: string } }>('/api/kb', async (request, reply) => {
    const { title, text } = request.body ?? {};
    if (!title?.trim() || !text?.trim()) return reply.code(400).send({ error: 'Нужны заголовок и текст' });
    const name = slugFromTitle(title);
    await writeDoc('kb', name, `# ${title.trim()}\n\n${text.trim()}\n`);
    onKbChanged?.();
    return { ok: true, name };
  });

  app.delete<{ Params: { area: string; name: string } }>('/api/kb/:area/:name', async (request, reply) => {
    const area = request.params.area === 'draft' ? 'draft' : 'kb';
    try {
      await removeDoc(area as Area, request.params.name);
      if (area === 'kb') onKbChanged?.();
      return { ok: true };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { name: string } }>('/api/kb/publish/:name', async (request, reply) => {
    try {
      await publishDraft(request.params.name);
      onKbChanged?.();
      return { ok: true };
    } catch (err) {
      const message = (err as NodeJS.ErrnoException).code === 'EACCES'
        ? `Нет прав на запись в каталог базы знаний. На сервере: chown -R 1000:1000 kb`
        : (err as Error).message;
      log.error(`Публикация ${request.params.name} не удалась`, err);
      return reply.code(400).send({ error: message });
    }
  });

  /**
   * Выгрузка Telegram Desktop. Файл приходит сырым телом: экспорт бывает
   * в десятки мегабайт, и json-парсер Fastify с общим лимитом его не примет.
   */
  app.post<{ Querystring: { me?: string } }>(
    '/api/kb/mine/export',
    { bodyLimit: 96 * 1024 * 1024 },
    async (request, reply) => {
      const raw = request.body;
      if (!Buffer.isBuffer(raw) || !raw.length) return reply.code(400).send({ error: 'Пустой файл' });

      let parsed: { name?: string; messages?: unknown[] };
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'Это не JSON. Нужен result.json из экспорта Telegram Desktop.' });
      }
      if (!Array.isArray(parsed.messages)) {
        return reply.code(400).send({ error: 'В файле нет списка сообщений — похоже, это не выгрузка переписки.' });
      }

      const { chatName, participants, exchanges } = parseExportObject(parsed, request.query.me);
      if (!request.query.me) {
        return { needsMe: true, chatName, participants };
      }
      if (!exchanges.length) return reply.code(400).send({ error: 'Пар «вопрос-ответ» не нашлось' });

      const jobId = store.startJob('mine');
      if (jobId < 0) return reply.code(409).send({ error: 'Сбор уже идёт' });

      runJob(jobId, 'mine', { source: 'export', exchanges }, (report) => {
        if (!report.dryRun && report.articles.length) operations.registerCandidates(report.articles, 'telegram-export');
        if (report.articles.length) onKbChanged?.();
      });

      return { ok: true, chatName, pairs: exchanges.length };
    },
  );

  // --- майнинг как фоновая задача ----------------------------------------

  app.get('/api/kb/mine', async () => ({ job: store.latestJob('mine') ?? null }));

  app.post<{ Body: { source?: string; status?: string; limit?: number; dryRun?: boolean; all?: boolean } }>(
    '/api/kb/mine',
    async (request, reply) => {
      const jobId = store.startJob('mine');
      if (jobId < 0) return reply.code(409).send({ error: 'Сбор уже идёт' });

      const options = request.body ?? {};
      // Запускаем в фоне: проход с паузами против лимитов длится минуты,
      // держать ради него HTTP-соединение незачем.
      runJob(jobId, 'mine', {
        source: options.source === 'panel' ? 'panel' : 'archive',
        status: options.status,
        limit: options.limit,
        all: options.all,
        dryRun: options.dryRun,
      }, (report) => {
        if (!report.dryRun && report.articles.length) operations.registerCandidates(report.articles, String(options.source ?? 'archive'));
        if (!report.dryRun && report.articles.length) onKbChanged?.();
      });

      return { ok: true, jobId };
    },
  );
}
