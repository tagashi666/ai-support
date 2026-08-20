/**
 * Последняя проверка перед отправкой ответа клиенту.
 *
 * Модель видит карточку клиента и состояние узлов. Даже при аккуратном
 * промпте она может процитировать оттуда лишнее, а клиент — попросить об
 * этом нарочно. Промпт — это просьба, а здесь стоит замок: текст, в котором
 * нашлось внутреннее, клиенту не уходит вовсе.
 *
 * Проверка идёт по исходящему тексту, а не по входящему: неважно, как
 * именно модель к нему пришла.
 */
export interface OutboundVerdict {
  ok: boolean;
  /** Что именно нашлось — для оператора и для журнала. */
  found: string[];
  text: string;
}

const FORBIDDEN: [RegExp, string][] = [
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/, 'ip-адрес'],
  [/\b[a-z0-9-]+\.(?:com|net|org|ru|icu|io|dev|xyz|su|me|cc|top|site|online)\b/i, 'домен'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, 'uuid'],
  [/\b[0-9a-f]{32,}\b/i, 'длинный ключ'],
  [/\b(?:sk|gsk|xai|api)[-_][A-Za-z0-9_-]{16,}\b/, 'ключ провайдера'],
  [/(?:vless|vmess|trojan|hysteria2?|tuic|ss):\/\//i, 'ссылка подписки'],
  [/\b(?:BOT_TOKEN|PANEL_TOKEN|API_KEY|Bearer)\b/i, 'имя секрета'],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/, 'токен бота'],
];

/** Доменам сервиса ходить в ответах можно: это публичные адреса. */
function allowlist(text: string, allowed: string[]): string {
  let cleaned = text;
  for (const domain of allowed) {
    if (!domain) continue;
    cleaned = cleaned.split(domain).join('«разрешённый адрес»');
  }
  return cleaned;
}

export function checkOutbound(text: string, allowedDomains: string[] = []): OutboundVerdict {
  const probe = allowlist(text, allowedDomains);
  const found = FORBIDDEN.filter(([pattern]) => pattern.test(probe)).map(([, name]) => name);
  return { ok: found.length === 0, found, text };
}
