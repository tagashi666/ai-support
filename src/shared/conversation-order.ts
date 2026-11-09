/**
 * Ранг строки списка (план редизайна, 7.1, «Ранг»): `секция|ярус|ключ|id`,
 * строки сравниваются как текст. Ранг считает сервер для каждого получателя,
 * панель только вставляет строку по рангу и сама ничего не пересчитывает.
 *
 *  - секция — номер в порядке показа: 0 ждут вас, 1 ведут коллеги,
 *    2 помощник ведёт, 3 ждём клиента, 4 решён;
 *  - ярус — 0 или 1 только в «Ждут вас» и «Ведут коллеги», иначе 0;
 *  - ключ — 13 цифр: время начала ожидания по возрастанию («кто дольше ждёт»)
 *    или «максимум минус активность» для секций «новые сверху»;
 *  - id — инвертирован: при равных временах выше более новый диалог.
 *
 * Чистый TypeScript без импортов окружения: общий для сервера и web/.
 */
import type { Section } from './attention.js';

export const SECTION_ORDER: readonly Section[] = ['mine', 'colleagues', 'ai', 'client', 'done'];
export const KEY_MAX = 9_999_999_999_999;

const pad13 = (value: number): string =>
  String(Math.max(0, Math.min(KEY_MAX, Math.round(value)))).padStart(13, '0');

export interface RankInput {
  id: number;
  section: Section;
  tier: 0 | 1;
  /** Начало ожидания; для «Ждут вас» и «Ведут коллеги». */
  waitingSince: number | null;
  /** Последняя активность; для «Помощник ведёт» и «Ждём клиента». */
  activityAt: number;
  /** Время решения; для «Решённые». */
  doneAt: number;
}

export function rankOf(input: RankInput): string {
  const section = SECTION_ORDER.indexOf(input.section);
  const needs = input.section === 'mine' || input.section === 'colleagues';
  const tier = needs ? input.tier : 0;
  const key = needs ? pad13(input.waitingSince ?? input.activityAt)
    : input.section === 'done' ? pad13(KEY_MAX - input.doneAt)
      : pad13(KEY_MAX - input.activityAt);
  return `${section}|${tier}|${key}|${pad13(KEY_MAX - input.id)}`;
}

export const compareRank = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface ParsedRank {
  section: Section;
  tier: number;
  key: number;
  id: number;
}

/** Разбор ранга (курсор страницы). null — строка не похожа на ранг. */
export function parseRank(rank: string): ParsedRank | null {
  const match = /^([0-4])\|([01])\|(\d{13})\|(\d{13})$/.exec(rank);
  if (!match) return null;
  const section = SECTION_ORDER[Number(match[1])];
  if (!section) return null;
  return { section, tier: Number(match[2]), key: Number(match[3]), id: KEY_MAX - Number(match[4]) };
}

/** Время решения из ранга секции «Решённые» (ключ = максимум минус время). */
export const doneAtOfRank = (parsed: ParsedRank): number => KEY_MAX - parsed.key;
