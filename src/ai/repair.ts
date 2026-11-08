/**
 * Терпимый разбор ответа модели.
 *
 * Модели, даже с response_format=json_object, регулярно присылают почти-JSON:
 * неэкранированная кавычка внутри текста («нажмите "Подключить"»), один и тот
 * же ключ дважды, висячая запятая, обрыв по лимиту токенов. Строгий
 * JSON.parse на таком падает, и клиент получал «передал специалисту» на
 * вопрос, ответ на который у модели был. Здесь — разбор, который знает
 * ключи контракта и по ним понимает, где кончается строка.
 *
 * Ничего не выдумываем: обрезанное значение помечается обрезанным, и
 * вызывающий решает, годится ли оно.
 */

/** Ключи контракта ответа. По ним эвристика решает, закрывает ли кавычка строку. */
export const DRAFT_KEYS = [
  'reply', 'operator_note', 'operatorNote', 'reason', 'confidence',
  'needs_human', 'needsHuman', 'no_request', 'noRequest', 'clarify', 'used',
] as const;

const KEY_ALT = DRAFT_KEYS.join('|');
/** После закрывающей кавычки — запятая и следующий известный ключ. */
const NEXT_KEY = new RegExp(`^\\s*,\\s*"?(?:${KEY_ALT})"?\\s*:`);
/** Или конец объекта, после которого известных ключей уже нет. */
const ANY_KEY_LATER = new RegExp(`"(?:${KEY_ALT})"\\s*:`);

export interface LenientValue {
  value: unknown;
  /** Значение оборвалось концом текста — обычно лимит токенов. */
  truncated: boolean;
}

export interface LenientResult {
  /** Все пары по порядку, включая повторы ключей. */
  pairs: [string, LenientValue][];
  /** Объект не закрыт: текст кончился раньше '}'. */
  truncated: boolean;
}

/** Срезает ```json-ограждение, если оно есть, и отдаёт содержимое. */
export function stripFences(raw: string): string {
  const fenced = /```(?:json|JSON)?\s*\n?([\s\S]*?)(?:```|$)/.exec(raw);
  if (fenced && fenced[1]!.includes('{')) return fenced[1]!.trim();
  return raw.trim();
}

function decodeString(raw: string): string {
  try {
    return JSON.parse(`"${raw.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`) as string;
  } catch {
    return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

/**
 * Разбирает первый объект в тексте «как получится». Кавычка внутри строки
 * считается закрывающей, только если за ней идёт известный ключ контракта
 * или конец объекта, — иначе это кавычка из текста ответа.
 */
export function lenientParse(text: string): LenientResult | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  const pairs: [string, LenientValue][] = [];
  let i = start + 1;
  const n = text.length;
  const ws = (): void => { while (i < n && /[\s,]/.test(text[i]!)) i += 1; };

  for (;;) {
    ws();
    if (i >= n) return { pairs, truncated: true };
    if (text[i] === '}') return { pairs, truncated: false };

    // Ключ: в кавычках или голым словом.
    let key: string;
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i]!;
      const end = text.indexOf(quote, i + 1);
      if (end === -1) return { pairs, truncated: true };
      key = text.slice(i + 1, end);
      i = end + 1;
    } else {
      const bare = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      if (!bare) return pairs.length ? { pairs, truncated: false } : null;
      key = bare[0];
      i += key.length;
    }
    while (i < n && /\s/.test(text[i]!)) i += 1;
    if (text[i] !== ':') return pairs.length ? { pairs, truncated: i >= n } : null;
    i += 1;
    while (i < n && /\s/.test(text[i]!)) i += 1;
    if (i >= n) return { pairs, truncated: true };

    const ch = text[i]!;
    if (ch === '"') {
      i += 1;
      let raw = '';
      let closed = false;
      while (i < n) {
        const c = text[i]!;
        if (c === '\\' && i + 1 < n) { raw += c + text[i + 1]; i += 2; continue; }
        if (c === '"') {
          const rest = text.slice(i + 1);
          const endsObject = /^\s*}/.test(rest) && !ANY_KEY_LATER.test(rest);
          if (NEXT_KEY.test(rest) || endsObject || /^\s*$/.test(rest)) { closed = true; i += 1; break; }
          // Кавычка из текста ответа — экранируем и идём дальше.
          raw += '\\"';
          i += 1;
          continue;
        }
        raw += c;
        i += 1;
      }
      pairs.push([key, { value: decodeString(raw), truncated: !closed }]);
      if (!closed) return { pairs, truncated: true };
    } else if (ch === '[') {
      const end = text.indexOf(']', i);
      const body = text.slice(i + 1, end === -1 ? n : end);
      const items = (body.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      pairs.push([key, { value: items, truncated: end === -1 }]);
      if (end === -1) return { pairs, truncated: true };
      i = end + 1;
    } else if (ch === '{') {
      // Вложенные объекты контракту не нужны — пропускаем по балансу скобок.
      let depth = 0;
      let inString = false;
      for (; i < n; i += 1) {
        const c = text[i]!;
        if (inString) { if (c === '\\') i += 1; else if (c === '"') inString = false; continue; }
        if (c === '"') inString = true;
        else if (c === '{') depth += 1;
        else if (c === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
      }
      pairs.push([key, { value: undefined, truncated: depth !== 0 }]);
      if (depth !== 0) return { pairs, truncated: true };
    } else {
      const m = /^[^,}\n]*/.exec(text.slice(i))!;
      const token = m[0].trim();
      i += m[0].length;
      let value: unknown = token;
      if (/^true$/i.test(token)) value = true;
      else if (/^false$/i.test(token)) value = false;
      else if (/^null$/i.test(token)) value = null;
      else if (/^-?\d+(?:\.\d+)?$/.test(token)) value = Number(token);
      pairs.push([key, { value, truncated: i >= n }]);
    }
  }
}

/**
 * Последний рубеж: структуры нет совсем (нет фигурной скобки, ключи без
 * кавычек вперемешку с текстом). Достаём известные поля регулярками.
 */
export function regexFields(text: string): [string, LenientValue][] {
  const pairs: [string, LenientValue][] = [];
  for (const key of DRAFT_KEYS) {
    const pattern = new RegExp(`"?${key}"?\\s*[:=]\\s*("((?:[^"\\\\]|\\\\.)*)"|\\[[^\\]]*\\]|true|false|-?\\d+(?:\\.\\d+)?)`, 'gi');
    for (const m of text.matchAll(pattern)) {
      const token = m[1]!;
      let value: unknown;
      if (token.startsWith('"')) value = decodeString(m[2] ?? '');
      else if (token.startsWith('[')) value = (token.match(/-?\d+/g) ?? []).map(Number);
      else if (/^(?:true|false)$/i.test(token)) value = token.toLowerCase() === 'true';
      else value = Number(token);
      pairs.push([key, { value, truncated: false }]);
    }
  }
  return pairs;
}

/**
 * Сводит пары в объект. Повторённый ключ: для reply берём первое непустое
 * значение (модель иногда начинает ответ заново и дописывает пустой), для
 * остального — последнее, как JSON.parse.
 */
export function mergePairs(pairs: [string, LenientValue][]): { fields: Record<string, unknown>; truncated: Set<string> } {
  const fields: Record<string, unknown> = {};
  const truncated = new Set<string>();
  for (const [key, item] of pairs) {
    if (key === 'reply') {
      const current = fields['reply'];
      if (typeof current === 'string' && current.trim()) continue;
    }
    fields[key] = item.value;
    if (item.truncated) truncated.add(key); else truncated.delete(key);
  }
  return { fields, truncated };
}
