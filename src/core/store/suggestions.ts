import type { Store } from '../store.js';
import type { SuggestionStatus, Suggestion } from './types.js';

/** Предложения AI и признаки участия человека в диалоге. */
export class SuggestionRepo {
  createSuggestion(this: Store, input: {
    conversationId: number;
    messageId?: number;
    text: string;
    confidence?: number;
    needsHuman?: boolean;
    reason?: string;
    /** Подсказка оператору: клиенту не уходит. */
    operatorNote?: string;
    model?: string;
    sources?: string[];
  }): Suggestion {
    const result = this.db
      .prepare(
        `INSERT INTO ai_suggestion
           (conversation_id, message_id, text, confidence, needs_human, reason, model, sources, created_at, operator_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.conversationId,
        input.messageId ?? null,
        input.text,
        input.confidence ?? null,
        input.needsHuman ? 1 : 0,
        input.reason ?? null,
        input.model ?? null,
        input.sources ? JSON.stringify(input.sources) : null,
        Date.now(),
        input.operatorNote || null,
      );
    const suggestion = this.getSuggestion(Number(result.lastInsertRowid))!;
    const conversation = this.getConversation(input.conversationId)!;
    this.emit('suggestion', { conversation, suggestion });
    return suggestion;
  }

  getSuggestion(this: Store, id: number): Suggestion | undefined {
    return this.db.prepare('SELECT * FROM ai_suggestion WHERE id = ?').get(id) as Suggestion | undefined;
  }

  pendingSuggestion(this: Store, conversationId: number): Suggestion | undefined {
    return this.db
      .prepare(`SELECT * FROM ai_suggestion WHERE conversation_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`)
      .get(conversationId) as Suggestion | undefined;
  }

  decideSuggestion(this: Store, id: number, status: SuggestionStatus): void {
    this.db.prepare('UPDATE ai_suggestion SET status = ?, decided_at = ? WHERE id = ?').run(status, Date.now(), id);
  }

  aiRepliesSince(this: Store, conversationId: number, since: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM message WHERE conversation_id = ? AND author = 'ai' AND created_at > ?`)
      .get(conversationId, since) as { n: number };
    return row.n;
  }

  lastHumanReplyAt(this: Store, conversationId: number): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(created_at) AS at FROM message
          WHERE conversation_id = ? AND author = 'agent' AND direction = 'out'`,
      )
      .get(conversationId) as { at: number | null };
    return row.at;
  }

  /**
   * Пауза после видимого клиенту ответа оператора. Внутренние заметки сюда
   * намеренно не входят: раньше служебная запись о handoff принималась за
   * человеческий ответ и могла заблокировать само уведомление клиента.
   */
  humanHoldActive(this: Store, conversationId: number, minutes: number, now = Date.now()): boolean {
    if (minutes <= 0) return false;
    const lastHuman = this.lastHumanReplyAt(conversationId);
    return lastHuman !== null && now - lastHuman < minutes * 60_000;
  }
}
