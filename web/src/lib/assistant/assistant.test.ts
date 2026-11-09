/** Помощник (6.7, 6.1): режимы, осторожность, пауза, «было → станет», «Вернуть как было», ссылки, лента, вердикт. */
import { describe, expect, it } from 'vitest';
import { t } from '@/i18n/ru';
import {
  awaySince, cautionIndex, changedKeys, changedSince, diffLines, filterActivity, isBolder, linkKey, pauseActive, pauseUntil,
  periodSince, readRevert, REVERT_MS, saveRevert, tryOutcome, validLinkUrl, verdictLines,
} from './model';

const at = (h: number, m = 0): number => new Date(2026, 10, 10, h, m).getTime();

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); },
    clear: () => data.clear(), key: () => null, get length() { return data.size; },
  };
}

describe('режимы и осторожность', () => {
  it('смелее — только вверх по лестнице Выключен → Наблюдает → Подсказывает → Отвечает сам', () => {
    expect(isBolder('suggest', 'auto')).toBe(true);
    expect(isBolder('off', 'shadow')).toBe(true);
    expect(isBolder('auto', 'suggest')).toBe(false);
    expect(isBolder('suggest', 'off')).toBe(false);
  });
  it('порог → ближайшее деление шкалы', () => {
    expect(cautionIndex(0.4)).toBe(0);
    expect(cautionIndex(0.7)).toBe(2);
    expect(cautionIndex(0.72)).toBe(2);
    expect(cautionIndex(0.88)).toBe(4);
    expect(cautionIndex(0.99)).toBe(4);
  });
});

describe('пауза', () => {
  it('на 1 час, до утра, пока не включу', () => {
    expect(pauseUntil('hour', at(14))).toBe(at(15));
    expect(pauseUntil('forever', at(14))).toBeNull();
    expect(pauseUntil('morning', at(23))).toBe(new Date(2026, 10, 11, 9).getTime());
    expect(pauseUntil('morning', at(14))).toBe(new Date(2026, 10, 11, 9).getTime());
    // Ночью «до утра» — сегодняшнее утро.
    expect(pauseUntil('morning', at(3))).toBe(at(9));
  });
  it('истёкшая пауза не действует, «пока не включу» — действует', () => {
    expect(pauseActive({ until: at(15) }, at(14))).toBe(true);
    expect(pauseActive({ until: at(15) }, at(15))).toBe(false);
    expect(pauseActive({ until: null }, at(15))).toBe(true);
    expect(pauseActive(null, at(15))).toBe(false);
  });
});

describe('было → станет', () => {
  const saved = { aiMode: 'suggest' as const, minConfidence: 0.7, humanHoldMinutes: 15, requireKb: true, autoPerHour: 20 };
  it('только изменённые ключи', () => {
    expect(changedKeys(saved, { minConfidence: 0.7 })).toEqual([]);
    expect(changedKeys(saved, { minConfidence: 0.9, humanHoldMinutes: 15 })).toEqual(['minConfidence']);
  });
  it('словами, без чисел порога и сырых значений', () => {
    expect(diffLines(saved, { humanHoldMinutes: 30, minConfidence: 0.9, autoPerHour: 0, aiMode: 'auto' }, t)).toEqual([
      'После вашего ответа молчит: 15 мин → 30 мин',
      'Осторожность: Обычно → Осторожно',
      'Не больше автоответов в одном диалоге за час: 20 → без предела',
      'Кто отвечает клиентам: Подсказывает → Отвечает сам',
    ]);
  });
});

describe('«Вернуть как было»', () => {
  it('помнит сутки на устройстве', () => {
    const storage = memoryStorage();
    const memo = { at: at(14), before: { aiMode: 'auto' as const }, after: { aiMode: 'suggest' as const } };
    saveRevert(memo, storage);
    expect(readRevert(at(20), storage)).toEqual(memo);
    expect(readRevert(at(14) + REVERT_MS + 1, storage)).toBeNull();
    expect(readRevert(at(14), memoryStorage())).toBeNull();
  });
  it('видит, что ключи с тех пор менял кто-то ещё', () => {
    const memo = { at: at(14), before: { aiMode: 'auto' as const }, after: { aiMode: 'suggest' as const } };
    expect(changedSince(memo, { aiMode: 'suggest' })).toEqual([]);
    expect(changedSince(memo, { aiMode: 'off' })).toEqual(['aiMode']);
  });
});

describe('ссылки для клиентов', () => {
  it('метка из названия: латиница, уникальная', () => {
    expect(linkKey('Прокси для Telegram', new Set())).toBe('proksi-dlya-telegram');
    expect(linkKey('Инструкция iOS', new Set(['instrukciya-ios']))).toBe('instrukciya-ios-2');
    expect(linkKey('!!!', new Set())).toBe('link');
  });
  it('адрес — веб или tg', () => {
    expect(validLinkUrl('https://example.com/ios')).toBe(true);
    expect(validLinkUrl('tg://proxy?server=x')).toBe(true);
    expect(validLinkUrl('example.com')).toBe(false);
  });
});

describe('лента и проверка', () => {
  it('вердикт ворот словами', () => {
    expect(tryOutcome({ action: 'auto' }, false)).toBe('send');
    expect(tryOutcome({ action: 'suggest' }, false)).toBe('draft');
    expect(tryOutcome({ action: 'suggest' }, true)).toBe('handoff');
    expect(tryOutcome({ action: 'skip' }, false)).toBe('skip');
    expect(tryOutcome(undefined, false)).toBe('skip');
  });
  it('фильтр «ответил сам» и «передал вам»', () => {
    const items = [{ kind: 'auto' as const }, { kind: 'handoff' as const }, { kind: 'draft' as const }];
    expect(filterActivity(items, 'all')).toHaveLength(3);
    expect(filterActivity(items, 'auto')).toEqual([{ kind: 'auto' }]);
    expect(filterActivity(items, 'handoff')).toEqual([{ kind: 'handoff' }]);
  });
  it('«Сегодня» — с полуночи, 7 дней — назад от сейчас', () => {
    expect(periodSince('today', at(14))).toBe(at(0));
    expect(periodSince('week', at(14))).toBe(at(14) - 7 * 86_400_000);
  });
});

describe('«Сегодня»', () => {
  it('«Пока вас не было» — только после 30 минут', () => {
    expect(awaySince(at(14), at(14, 20))).toBeNull();
    expect(awaySince(at(13), at(14))).toBe(at(13));
    expect(awaySince(null, at(14))).toBeNull();
  });
  it('вердикт: ждут, помощник ведёт, тихо, пауза', () => {
    expect(verdictLines({ waiting: 1, ai: 0, paused: null, quiet: false })).toEqual(['Вас ждёт 1 диалог.', 'Остальное спокойно.']);
    expect(verdictLines({ waiting: 3, ai: 0, paused: null, quiet: false })[0]).toBe('Вас ждут 3 диалога.');
    expect(verdictLines({ waiting: 0, ai: 2, paused: null, quiet: false })).toEqual(['Никто не ждёт ответа.', 'Помощник ведёт 2 диалога.']);
    expect(verdictLines({ waiting: 0, ai: 0, paused: null, quiet: true })).toEqual(['Сегодня тихо. Новых обращений не было.']);
    expect(verdictLines({ waiting: 0, ai: 0, paused: 'до 15:00', quiet: false })).toEqual(['Помощник на паузе до 15:00 — новые вопросы ждут вас.']);
  });
});
