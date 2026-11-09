/**
 * «Человек печатает» (план, 6.3.1 и 10.2 п.6): `engage {typing:true}` уходит
 * с первой клавиши и повторяется раз в 15 с, пока вы печатаете. Помощник
 * молчит 45 с после каждого сигнала, а диалог не закрепляется. Печать
 * заметки сигнала не шлёт.
 */
export const TYPING_REPEAT_MS = 15_000;

export class TypingSignal {
  private lastSent = -Infinity;

  /** Нажата клавиша в поле ответа: true — пора отправить сигнал. */
  keystroke(now: number): boolean {
    if (now - this.lastSent < TYPING_REPEAT_MS) return false;
    this.lastSent = now;
    return true;
  }

  /** Сигнал ушёл другим путём (отправка черновика сразу шлёт typing, ещё до окна отмены). */
  sent(now: number): void { this.lastSent = now; }

  /** Новый диалог или отправка: следующий ввод снова сигналит сразу. */
  reset(): void { this.lastSent = -Infinity; }
}
