/**
 * Разбор выгрузки Telegram Desktop.
 *
 * Личку через Bot API не поднять — истории он не отдаёт вовсе. Единственный
 * способ достать прошлые диалоги: Telegram Desktop → Настройки → Экспорт
 * данных → формат JSON, и получившийся result.json скормить сюда.
 */
import { readFile } from 'node:fs/promises';

export interface RawExchange {
  source: string;
  reference: string;
  question: string;
  answer: string;
}

interface ExportMessage {
  type?: string;
  from_id?: string;
  text?: unknown;
  date?: string;
}

/** Поле text бывает строкой, а бывает массивом кусков с форматированием. */
function flattenText(text: unknown): string {
  if (typeof text === 'string') return text;
  if (!Array.isArray(text)) return '';
  return text
    .map((part) => {
      if (typeof part === 'string') return part;
      const typed = part as { text?: unknown };
      return typeof typed.text === 'string' ? typed.text : '';
    })
    .join('');
}

export interface ParsedExport {
  chatName: string;
  participants: string[];
  exchanges: RawExchange[];
}

/**
 * Собирает пары «последний вопрос собеседника → наш ответ». Подряд идущие
 * сообщения одной стороны склеиваются: люди пишут мысль в три коротких
 * сообщения, и по отдельности они бессмысленны.
 */
export async function parseTelegramExport(path: string, me?: string): Promise<ParsedExport> {
  return parseExportObject(JSON.parse(await readFile(path, 'utf8')), me);
}

/** Тот же разбор, но по готовому объекту — из панели файл уже прочитан. */
export function parseExportObject(raw: { name?: string; messages?: unknown[] }, me?: string): ParsedExport {
  const all = (raw.messages ?? []) as ExportMessage[];
  const messages = all.filter((message) => message.type === 'message');
  const participants = [...new Set(messages.map((message) => message.from_id).filter((id): id is string => !!id))];

  if (!me) return { chatName: raw.name ?? 'чат', participants, exchanges: [] };

  // Склейка серий
  const runs: { mine: boolean; text: string }[] = [];
  for (const message of messages) {
    const text = flattenText(message.text).trim();
    if (!text) continue;
    const mine = message.from_id === me;
    const last = runs.at(-1);
    if (last && last.mine === mine) last.text += `\n${text}`;
    else runs.push({ mine, text });
  }

  const exchanges: RawExchange[] = [];
  for (let index = 1; index < runs.length; index += 1) {
    const answer = runs[index]!;
    const question = runs[index - 1]!;
    if (!answer.mine || question.mine) continue;
    if (answer.text.length < 40 || question.text.length < 10) continue;
    exchanges.push({
      source: 'telegram',
      reference: `${raw.name ?? 'чат'} #${index}`,
      question: question.text,
      answer: answer.text,
    });
  }

  return { chatName: raw.name ?? 'чат', participants, exchanges };
}
