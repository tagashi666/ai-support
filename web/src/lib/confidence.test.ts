/** Уверенность словами (6.3.4) на порогах 0,40 и 0,90. */
import { describe, expect, it } from 'vitest';
import { confidenceLevel, type ConfidenceInput } from '@shared/confidence';

const base: Omit<ConfidenceInput, 'score' | 'threshold'> = { hasSources: true, askedHuman: false, gatePassed: false, hasText: true };

describe('уверенность', () => {
  it.each([
    [0.9, 0.95, 'sure'], [0.9, 0.9, 'sure'], [0.9, 0.85, 'check'], [0.9, 0.8, 'check'], [0.9, 0.79, 'unsure'],
    [0.4, 0.45, 'sure'], [0.4, 0.35, 'check'], [0.4, 0.29, 'unsure'],
  ] as const)('порог %s, оценка %s → %s', (threshold, score, level) => {
    expect(confidenceLevel({ ...base, threshold, score })).toBe(level);
  });

  it('без источников — не выше «Проверьте»', () => {
    expect(confidenceLevel({ ...base, hasSources: false, threshold: 0.9, score: 0.99 })).toBe('check');
  });

  it('просьба о человеке: гейт не пропустил — «Не уверен», пропустил — «Проверьте»', () => {
    expect(confidenceLevel({ ...base, askedHuman: true, threshold: 0.9, score: 0.95 })).toBe('unsure');
    expect(confidenceLevel({ ...base, askedHuman: true, gatePassed: true, threshold: 0.9, score: 0.95 })).toBe('check');
  });

  it('нет текста или оценки — «Не уверен»', () => {
    expect(confidenceLevel({ ...base, hasText: false, threshold: 0.4, score: 0.99 })).toBe('unsure');
    expect(confidenceLevel({ ...base, threshold: 0.4, score: null })).toBe('unsure');
  });
});
