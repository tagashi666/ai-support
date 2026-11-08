import type { Store } from '../store.js';
import { isMeaningfulAnswer } from '../../ai/examples.js';

/** Добыча знаний из переписки: пары вопрос-ответ для KB. */
export class MiningRepo {
  /**
   * Диалоги, где база знаний подвела: предложку отклонили или переписали.
   * Это самая ценная выборка — рядом лежит правильный ответ человека.
   */
  gapConversations(this: Store, limit = 100): number[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT conversation_id FROM ai_suggestion
            WHERE status IN ('rejected','edited')
            ORDER BY conversation_id DESC LIMIT ?`,
        )
        .all(limit) as { conversation_id: number }[]
    ).map((row) => row.conversation_id);
  }

  /** Диалоги, где человек вообще что-то отвечал. */
  answeredConversations(this: Store, limit = 200): number[] {
    return (
      this.db
        .prepare(
          `SELECT conversation_id, MAX(created_at) AS last
             FROM message WHERE direction = 'out' AND author = 'agent'
            GROUP BY conversation_id ORDER BY last DESC LIMIT ?`,
        )
        .all(limit) as { conversation_id: number }[]
    ).map((row) => row.conversation_id);
  }

  /**
   * Пары «вопрос клиента → ответ человека». Берём последнее входящее перед
   * ответом: промежуточные уточнения только зашумляют статью.
   */
  exchanges(this: Store, conversationIds: number[]): { conversationId: number; subject: string | null; question: string; answer: string }[] {
    const found: { conversationId: number; subject: string | null; question: string; answer: string }[] = [];

    for (const id of conversationIds) {
      const conversation = this.getConversation(id);
      if (!conversation) continue;
      const messages = this.listMessages(id, 100);

      // Клиент пишет мысль частями — склеиваем реплики до ответа человека.
      let parts: string[] = [];
      for (const message of messages) {
        if (message.direction === 'in' && message.text?.trim()) {
          parts.push(message.text.trim());
          if (parts.length > 3) parts = parts.slice(-3);
          continue;
        }
        if (message.direction === 'out' && message.author === 'agent' && message.text?.trim() && parts.length) {
          const answer = message.text.trim();
          const question = parts.join(' / ');
          // Односложные «ок» и «принял» ничему не учат, но короткий ответ по
          // делу («Обновите подписку в приложении») — учит. Отсекаем по смыслу.
          if (isMeaningfulAnswer(answer) && question.length >= 10) {
            found.push({ conversationId: id, subject: conversation.subject, question, answer });
            parts = [];
          }
        }
      }
    }
    return found;
  }
}
