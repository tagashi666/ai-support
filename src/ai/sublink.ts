/**
 * Ссылки подписки в сообщении клиента.
 *
 * Клиенты присылают их постоянно — «вот мой ключ, не работает». Из ссылки
 * достаётся short uuid, а по нему клиент находится в Remnawave даже когда
 * telegram id нигде не записан. Заодно оператор видит, что ключ вообще был
 * прислан, и не просит его повторно.
 */

const PATTERNS: RegExp[] = [
  /\b(?:vless|vmess|trojan|ss|ssr|hysteria2?|hy2|tuic):\/\/\S+/i,
  /https?:\/\/\S*\/(?:sub|subscription|json|clash|mihomo|singbox)\/\S+/i,
  /https?:\/\/\S*happ\.su\/\S+/i,
];

export interface SubLink {
  /** Ссылка целиком — её показываем оператору. */
  link: string;
  /** Опознавательная часть: short uuid или uuid, по нему ищем в панели. */
  ref?: string;
}

export function detectSubLink(text: string): SubLink | undefined {
  for (const pattern of PATTERNS) {
    const found = pattern.exec(text);
    if (!found) continue;
    const link = found[0].replace(/[)\].,;]+$/, '');
    return { link, ref: extractRef(link) };
  }
  return undefined;
}

/** Хвост пути или uuid из ссылки: именно он совпадает с записью в панели. */
function extractRef(link: string): string | undefined {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(link);
  if (uuid) return uuid[0];

  // vless://uuid@host — идентификатор стоит до собаки.
  const scheme = /^(?:vless|trojan|tuic|hysteria2?|hy2):\/\/([^@\s?#]+)@/i.exec(link);
  if (scheme?.[1] && scheme[1].length >= 8) return scheme[1];

  const tail = /\/([A-Za-z0-9_-]{8,})\/?(?:\?|#|$)/.exec(link);
  return tail?.[1];
}
