/**
 * Уверенность черновика помощника словами: «Уверен / Проверьте / Не уверен»
 * (план редизайна, 6.3.4). Все границы считаются от порога осторожности из
 * настроек (runtime.minConfidence, 0..1), а не от своих констант, поэтому
 * подпись не спорит с гейтом отправки.
 *
 * Чистый TypeScript без импортов: общий для сервера и новой панели.
 */
export type ConfidenceLevel = 'sure' | 'check' | 'unsure';

export interface ConfidenceInput {
  /** Оценка модели 0..1; null — оценки нет. */
  score: number | null;
  /** Порог осторожности 0..1. */
  threshold: number;
  /** У ответа есть источники (статьи, данные подписки). */
  hasSources: boolean;
  /** Помощник просил передать человеку. */
  askedHuman: boolean;
  /** Гейт пропустил ответ, несмотря на просьбу о человеке. */
  gatePassed: boolean;
  /** У черновика есть текст. */
  hasText: boolean;
}

/** Ширина полосы «Проверьте» под порогом. */
export const CHECK_BAND = 0.1;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export function confidenceLevel(input: ConfidenceInput): ConfidenceLevel {
  const threshold = clamp01(input.threshold);
  const floor = Math.max(0, threshold - CHECK_BAND);
  const score = input.score === null ? null : clamp01(input.score);
  if (!input.hasText) return 'unsure';
  if (input.askedHuman && !input.gatePassed) return 'unsure';
  if (score === null || score < floor) return 'unsure';
  if (score >= threshold && input.hasSources && !input.askedHuman) return 'sure';
  return 'check';
}
