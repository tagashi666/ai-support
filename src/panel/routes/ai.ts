import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import type { Conversation } from '../../core/store.js';
import { runtime } from '../../core/settings.js';
import { AiProvider } from '../../ai/provider.js';
import { decide } from '../../ai/gate.js';
import { tryDraft } from '../../ai/responder.js';
import { activeInterfaceKnowledge, effectiveInterfaceMode } from '../../ai/interface-kb.js';
import type { RouteContext } from '../context.js';

/** AI: ключи, модели, проверка связи и песочница. */
export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { store } = ctx;

  // --- AI: связь, модели, песочница --------------------------------------

  app.get('/api/ai/keys', async () => {
    const provider = new AiProvider();
    return { keys: provider.maskedKeys(), bound: { model: runtime.modelKey, fallback: runtime.fallbackKey } };
  });

  app.get('/api/ai/models', async (_request, reply) => {
    if (!config.ai.apiKeys.length) return reply.code(501).send({ error: 'AI_API_KEY не задан' });
    try {
      return { models: await new AiProvider().listModels() };
    } catch (err) {
      return reply.code(502).send({ error: `Список моделей недоступен: ${(err as Error).message}` });
    }
  });

  app.post('/api/ai/ping', async (_request, reply) => {
    if (!config.ai.apiKeys.length) return reply.code(501).send({ error: 'AI_API_KEY не задан' });
    const provider = new AiProvider();
    const started = Date.now();
    try {
      await provider.ping();
      return { ok: true, ms: Date.now() - started, model: provider.lastModel, keys: provider.keyState() };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message, keys: provider.keyState() });
    }
  });

  /**
   * Песочница: тот же путь, что и для клиента, но без диалога и без отправки.
   * Нужна, чтобы проверять правки промпта и базы знаний на реальных вопросах,
   * а не на живых людях.
   */
  // assume: 'auto' — «Как бы он ответил» и «Попробовать» в новой панели (6.7): вердикт
  // режима «Отвечает сам» при любом общем режиме и паузе. Без поля — как раньше.
  app.post<{ Body: { text?: string; assume?: string } }>('/api/ai/try', async (request, reply) => {
    const text = request.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: 'Пустой вопрос' });
    if (!config.ai.apiKeys.length) return reply.code(501).send({ error: 'AI_API_KEY не задан' });

    const hits = store.searchKb(text, config.ai.kbLimit);
    const interfaceHits = activeInterfaceKnowledge(
      text, runtime.bedolagaInterfaceKb, undefined, effectiveInterfaceMode(runtime.bedolagaInterfaceMode));
    const sources = [
      ...hits.map((hit) => hit.title),
      ...interfaceHits.map((screen) => `Интерфейс Бедолаги: ${screen.title}`),
    ];
    const started = Date.now();
    try {
      const draft = await tryDraft(text, hits, undefined, store);
      if (!draft) return reply.code(502).send({ error: 'Модель вернула ответ, который не разобрался' });

      // Показываем и вердикт ворот: почему такой ответ ушёл бы или не ушёл.
      const probe: Conversation = {
        ...(store.listConversations(1)[0] ?? ({} as Conversation)),
        id: -1, channel: 'tg_dm', escalated: 0, handoff_at: null,
        ai_mode: 'auto', last_inbound_at: Date.now(),
      } as Conversation;
      const grounded = draft.used.filter((n) => n >= 1 && n <= sources.length).length;
      const verdict = decide(store, probe, text, draft, grounded, { assumeAuto: request.body?.assume === 'auto' });

      return {
        draft,
        ms: Date.now() - started,
        model: runtime.model,
        sources,
        usedSources: draft.used
          .filter((n) => n >= 1 && n <= sources.length)
          .map((n) => sources[n - 1]),
        verdict,
      };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
