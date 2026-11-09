/**
 * Ссылки, которые AI может дать клиенту: прокси для Telegram, бот, сайт,
 * инструкция. Владелец заводит их в панели.
 *
 * Модель не пишет адрес сама, а ставит метку [[link:ключ]], и точная ссылка
 * подставляется уже после проверки ответа. Так длинный секрет прокси не
 * искажается при пересказе, а замок в outbound.ts остаётся строгим: адрес,
 * IP или ключ, написанный моделью от себя, клиенту по-прежнему не уходит.
 */
export interface CustomerLink {
  /** Латиница, цифры, - и _: из него строится метка [[link:key]]. */
  key: string;
  /** Что это, для модели и оператора: «Прокси для Telegram». */
  title: string;
  url: string;
  /** Когда давать: «клиент просит прокси для телеграма, не VPN». */
  when: string;
}

export const MAX_LINKS = 20;
const KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Метка в ответе модели. Терпим `[[proxy]]` и пробелы: модели их пишут. */
const TAG = /\[\[\s*(?:link\s*:\s*)?([a-z0-9][a-z0-9_-]{0,31})\s*\]\]/gi;

/** Проверка значения из панели. undefined — значение отклоняется целиком. */
export function normalizeLinks(value: unknown): CustomerLink[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_LINKS) return undefined;
  const seen = new Set<string>();
  const result: CustomerLink[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return undefined;
    const item = raw as Record<string, unknown>;
    const key = String(item.key ?? '').trim().toLowerCase();
    const title = String(item.title ?? '').trim();
    const url = String(item.url ?? '').trim();
    const when = String(item.when ?? '').trim();
    if (!KEY.test(key) || seen.has(key)) return undefined;
    if (!title || title.length > 80 || when.length > 300) return undefined;
    if (url.length > 600 || !/^(?:https?|tg):\/\/\S+$/i.test(url)) return undefined;
    seen.add(key);
    result.push({ key, title, url, when });
  }
  return result;
}

/** Блок для промпта. Нет ссылок — нет и блока: токены не тратим. */
export function linksBlock(links: CustomerLink[]): string {
  if (!links.length) return '';
  return [
    '# Ссылки, которые можно дать клиенту',
    'Если ссылка отвечает на вопрос — вставь в reply её метку целиком, адрес подставится сам; не обещай «могу отправить», а сразу давай. Сам адресов не пиши.',
    ...links.map((link) => `- [[link:${link.key}]] — ${link.title}${link.when ? `. Когда давать: ${link.when}` : ''}`),
  ].join('\n');
}

/**
 * Прячет известные адреса в тексте для модели: оператор вставил ссылку в
 * ответ, она попала в историю или в образцы — модель увидит метку и
 * повторит именно её, а не скопирует секрет по буквам.
 */
export function maskLinks(text: string, links: CustomerLink[]): string {
  let result = text;
  // Длинные адреса первыми: один может начинаться с другого.
  for (const link of [...links].sort((a, b) => b.url.length - a.url.length)) {
    result = result.split(link.url).join(`[[link:${link.key}]]`);
  }
  return result;
}

export interface ExpandedLinks {
  /** Текст клиенту с настоящими адресами. */
  text: string;
  /** Тот же текст для замка outbound: известные метки заменены нейтрально, неизвестные остались. */
  probe: string;
  used: CustomerLink[];
}

export function expandLinks(text: string, links: CustomerLink[]): ExpandedLinks {
  const byKey = new Map(links.map((link) => [link.key, link]));
  const used = new Map<string, CustomerLink>();
  const replace = (fill: (link: CustomerLink) => string) => text.replace(TAG, (tag, key: string) => {
    const link = byKey.get(key.toLowerCase());
    if (!link) return tag;
    used.set(link.key, link);
    return fill(link);
  });
  return { text: replace((link) => link.url), probe: replace(() => '«ссылка»'), used: [...used.values()] };
}
