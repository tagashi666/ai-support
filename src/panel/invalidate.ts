import type { InvalidateScope } from '../shared/api-types.js';

/**
 * Какие разделы новой панели устарели после успешного изменяющего запроса
 * (L-4). Кадр invalidate несёт только scope: открытый раздел перечитывает
 * себя своим GET, и права проверяет этот GET (SCOPE_PERMISSION в live.ts).
 * Майнинг и автоматическое обучение добавляют идеи позже — их кадр шлёт runJob.
 */
const RULES: Array<[RegExp, InvalidateScope[]]> = [
  [/^\/api\/kb\/mine/, []],
  [/^\/api\/kb\/publish\//, ['kb', 'ideas']],
  [/^\/api\/kb(?:\/|$)/, ['kb', 'ideas']],
  [/^\/api\/interface-kb\//, ['kb']],
  [/^\/api\/learning\//, ['ideas', 'kb']],
  [/^\/api\/messages\/\d+\/feedback$/, ['ideas']],
  [/^\/api\/templates(?:\/|$)/, ['templates']],
  [/^\/api\/operators(?:\/|$)/, ['team']],
  [/^\/api\/roles\//, ['roles', 'team']],
  [/^\/api\/nodes\//, ['nodes']],
  [/^\/api\/(?:sources\/|inbox\/folders|settings\/services\/)/, ['connections']],
];

export function invalidatedBy(method: string, path: string): InvalidateScope[] {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return [];
  return RULES.find(([pattern]) => pattern.test(path))?.[1] ?? [];
}
