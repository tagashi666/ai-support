import type { FastifyInstance } from 'fastify';
import { log } from '../../config.js';
import { runtime } from '../../core/settings.js';
import { type Area, docVersion, freeName, listDocs, publishDraft, readDocMeta, removeDoc, slugFromTitle, writeDoc } from '../kbfiles.js';
import { effectiveInterfaceMode, loadInterfaceKnowledge } from '../../ai/interface-kb.js';
import { parseExportObject } from '../../integrations/tgexport.js';
import type { RouteContext } from '../context.js';
import { apiError } from '../errors.js';
import type { IdeaRejectReason, KbConflict, KbWriteResponse } from '../../shared/api-types.js';

const REJECT_REASONS: readonly IdeaRejectReason[] = ['wrong', 'duplicate', 'too_specific', 'not_needed'];

/**
 * Проверка версии и запись одного файла не должны переплетаться с такой же
 * парой из соседнего запроса: иначе оба увидят «свою» версию и второй молча
 * перезапишет первого (10.5 п.5). Очередь на имя в пределах процесса.
 */
const locks = new Map<string, Promise<unknown>>();
function exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
  const before = locks.get(key) ?? Promise.resolve();
  const next = before.catch(() => undefined).then(run);
  locks.set(key, next);
  void next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => undefined);
  return next;
}

/** expectedVersion: строка — версия, null — «файла ещё нет», undefined — без проверки (классика). */
const expectedOf = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' && /^[0-9a-f]{16}$/.test(value) ? value : undefined;

const writeDenied = (err: unknown): boolean => ['EACCES', 'EPERM'].includes(String((err as NodeJS.ErrnoException).code));

/** База знаний: кандидаты обучения, статьи, черновики и майнинг. */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store, onKbChanged, operations, actorOf, runJob } = ctx;

  // Очередь обучения отделена от опубликованной базы. Диалоги создают
  // кандидатов; в рабочую KB они попадают только после решения lead/admin.
  app.get<{ Querystring: { status?: string } }>('/api/learning/candidates', async (request) => ({
    candidates: operations.candidates(request.query.status ?? 'pending'),
  }));

  // Решение по идее (10.5 п.4, п.6): сначала атомарная запись решения, потом
  // публикация. Двое на одной идее: второй получает 409 с тем, кто и как решил,
  // и лишней публикации нет. Причина отклонения — в журнале event.
  app.post<{ Params: { id: string }; Body: { decision?: string; reason?: unknown; discardDraft?: unknown } }>('/api/learning/candidates/:id', async (request, reply) => {
    const actor = actorOf(request);
    if (!operations.can(actor, 'knowledge:review')) return reply.code(403).send({ error: 'Недостаточно прав' });
    const id = Number(request.params.id);
    const candidate = operations.candidate(id);
    if (!candidate) return reply.code(404).send({ error: 'Кандидат не найден' });
    const decided = () => {
      const row = operations.candidate(id);
      return {
        error: 'Кандидат уже рассмотрен', code: 'already_decided' as const,
        decision: (row?.status === 'rejected' ? 'rejected' : 'approved') as 'approved' | 'rejected',
        decided_by: row?.decided_by ? operations.actorName(String(row.decided_by)) : null,
      };
    };
    if (candidate.status !== 'pending') return reply.code(409).send(decided());
    const decision = request.body?.decision;
    if (decision !== 'approved' && decision !== 'rejected') return reply.code(400).send({ error: 'Нужно approved или rejected' });
    const reason = request.body?.reason;
    if (reason !== undefined && reason !== null && !REJECT_REASONS.includes(reason as IdeaRejectReason)) {
      return reply.code(400).send(apiError('bad_request', 'Причина — wrong, duplicate, too_specific или not_needed'));
    }
    if (!operations.decideCandidate(id, decision, actor)) return reply.code(409).send(decided());
    const file = String(candidate.file_name);
    try {
      if (decision === 'approved') {
        await publishDraft(file);
        operations.closeCandidatesFor(file, actor);
        onKbChanged?.();
      } else if (request.body?.discardDraft === true) {
        await removeDoc('draft', file).catch(() => undefined);
      }
    } catch (err) {
      operations.undoCandidateDecision(id, actor);
      return reply.code(400).send({ error: (err as Error).message, ...(writeDenied(err) ? { code: 'write_denied' } : {}) });
    }
    store.logEvent('kb_candidate_decided', null, {
      id, decision, ...(decision === 'rejected' && reason ? { reason } : {}), by: actor.key,
    });
    return { ok: true, candidates: operations.candidates('pending') };
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
      const meta = await readDocMeta(area as Area, request.params.name);
      if (!meta) return reply.code(404).send(apiError('not_found', 'Статья не найдена'));
      return { name: request.params.name, text: meta.text, version: meta.version, changed_at: meta.changedAt };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  /** 409 «Статью изменили, пока вы правили» с текущим текстом (10.5 п.5). */
  const conflict = (area: Area, name: string, current: { text: string; version: string; changedAt: number } | null): KbConflict => ({
    error: 'Статью изменили, пока вы правили', code: 'version_conflict',
    text: current?.text ?? null, version: current?.version ?? null, changed_at: current?.changedAt ?? null,
    changed_by: current ? operations.kbChangedBy(area, name, current.changedAt) : null,
  });

  app.put<{ Params: { area: string; name: string }; Body: { text?: string; expectedVersion?: unknown } }>(
    '/api/kb/:area/:name',
    async (request, reply) => {
      const area: Area = request.params.area === 'draft' ? 'draft' : 'kb';
      const name = request.params.name;
      const text = request.body?.text;
      if (typeof text !== 'string' || !text.trim()) return reply.code(400).send({ error: 'Пустой текст' });
      const expected = expectedOf(request.body?.expectedVersion);
      try {
        return await exclusive(`${area}/${name}`, async () => {
          const current = await readDocMeta(area, name);
          if (expected !== undefined && (current?.version ?? null) !== expected) return reply.code(409).send(conflict(area, name, current));
          await writeDoc(area, name, text);
          if (area === 'kb') onKbChanged?.();
          const result: KbWriteResponse = { ok: true, name, version: docVersion(text), previous: current?.text ?? null };
          return result;
        });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message, ...(writeDenied(err) ? { code: 'write_denied' } : {}) });
      }
    },
  );

  app.post<{ Body: { title?: string; text?: string; draft?: unknown } }>('/api/kb', async (request, reply) => {
    const { title, text } = request.body ?? {};
    if (!title?.trim() || !text?.trim()) return reply.code(400).send({ error: 'Нужны заголовок и текст' });
    // Новая панель: «Новая статья» — всегда черновик, помощник его не видит (10.5 п.1).
    // Без draft — по-старому, для классики.
    if (request.body?.draft === true) {
      try {
        const body = `# ${title.trim()}\n\n${text.trim()}\n`;
        const result = await exclusive('new', async () => {
          const fresh = await freeName(title);
          await writeDoc('draft', fresh, body);
          return fresh;
        });
        const created: KbWriteResponse = { ok: true, name: result, version: docVersion(body), previous: null };
        return { ...created, draft: true };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message, ...(writeDenied(err) ? { code: 'write_denied' } : {}) });
      }
    }
    const name = slugFromTitle(title);
    await writeDoc('kb', name, `# ${title.trim()}\n\n${text.trim()}\n`);
    onKbChanged?.();
    return { ok: true, name };
  });

  app.delete<{ Params: { area: string; name: string }; Body: { expectedVersion?: unknown } }>('/api/kb/:area/:name', async (request, reply) => {
    const area: Area = request.params.area === 'draft' ? 'draft' : 'kb';
    const name = request.params.name;
    const expected = expectedOf(request.body?.expectedVersion);
    try {
      return await exclusive(`${area}/${name}`, async () => {
        const current = expected !== undefined ? await readDocMeta(area, name) : null;
        if (expected !== undefined && (current?.version ?? null) !== expected) return reply.code(409).send(conflict(area, name, current));
        await removeDoc(area, name);
        if (area === 'kb') onKbChanged?.();
        return { ok: true, ...(current ? { previous: current.text } : {}) };
      });
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  // Публикация черновика (6.6): в ответе прежний опубликованный текст для
  // «Опубликовано · Отменить» (10.5 п.3); связанные идеи закрываются (п.2).
  app.post<{ Params: { name: string }; Body: { expectedVersion?: unknown } }>('/api/kb/publish/:name', async (request, reply) => {
    const name = request.params.name;
    const expected = expectedOf(request.body?.expectedVersion);
    try {
      return await exclusive(`draft/${name}`, () => exclusive(`kb/${name}`, async () => {
        const draft = await readDocMeta('draft', name);
        if (expected !== undefined && (draft?.version ?? null) !== expected) return reply.code(409).send(conflict('draft', name, draft));
        const before = await readDocMeta('kb', name);
        await publishDraft(name);
        const closed = operations.closeCandidatesFor(name, actorOf(request));
        onKbChanged?.();
        const result: KbWriteResponse = {
          ok: true, name, version: draft?.version ?? '', previous: before?.text ?? null, closed_ideas: closed,
        };
        return result;
      }));
    } catch (err) {
      const message = (err as NodeJS.ErrnoException).code === 'EACCES'
        ? `Нет прав на запись в каталог базы знаний. На сервере: chown -R 1000:1000 kb`
        : (err as Error).message;
      log.error(`Публикация ${request.params.name} не удалась`, err);
      return reply.code(400).send({ error: message, ...(writeDenied(err) ? { code: 'write_denied' } : {}) });
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
