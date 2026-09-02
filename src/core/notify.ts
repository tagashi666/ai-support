import type { Bot } from 'grammy';
import { config, log } from '../config.js';
import type { Conversation, Store } from './store.js';
import { runtime } from './settings.js';

/**
 * Уведомления оператору в Telegram.
 *
 * Раньше единственным поводом была просрочка первого ответа — и она не
 * наступала никогда, потому что AI отвечал за секунды. Поэтому событий
 * теперь несколько, и каждое отвечает на вопрос «нужно ли мне сейчас
 * открыть панель».
 */
export type EventKind =
  | 'new' | 'message' | 'ai_reply' | 'handoff' | 'needs_human'
  | 'escalated' | 'aggressive' | 'suspicious' | 'sla' | 'ai_error';

const TITLES: Record<EventKind, string> = {
  new: 'Новое обращение',
  message: 'Сообщение от клиента',
  ai_reply: 'AI ответил клиенту',
  handoff: 'Клиенту обещан ответ специалиста',
  needs_human: 'AI просит человека',
  escalated: 'Диалог эскалирован',
  aggressive: 'Клиент на взводе',
  suspicious: 'Клиента нет в базах',
  sla: 'Клиент ждёт ответа',
  ai_error: 'AI не смог ответить',
};

/**
 * Как часто повторять одно и то же событие по одному диалогу.
 *
 * У передачи человеку троттлинга нет намеренно: клиенту в этот момент
 * говорят «передал специалисту», и если уведомление проглотить, обещание
 * окажется ложью. Один раз это уже случилось — второй хендофф в том же
 * диалоге попал под тридцатиминутную блокировку и исчез.
 */
const THROTTLE_MS: Record<EventKind, number> = {
  new: 6 * 3600_000,
  // Поток переписки и ответы AI не подавляем: их смысл в том, чтобы видеть
  // разговор целиком. Кому это громко — снижает уровень подробности.
  message: 0,
  ai_reply: 0,
  handoff: 0,
  needs_human: 30 * 60_000,
  escalated: 60 * 60_000,
  aggressive: 60 * 60_000,
  suspicious: 12 * 3600_000,
  sla: 6 * 3600_000,
  ai_error: 30 * 60_000,
};

export interface NotifyDetails {
  /** Суть обращения — то, что написал клиент. */
  excerpt?: string;
  /** Почему сработало событие: причина ворот, срок ожидания и так далее. */
  reason?: string;
  /** Предложенный AI ответ, чтобы решение принималось прямо из уведомления. */
  draft?: string;
  tone?: 'спокойный' | 'раздражённый' | 'агрессивный';
}

const cut = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;

const escapeHtml = (text: string): string =>
  text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

export class Notifier {
  /** Telegram не принимает сообщения длиннее 4096 символов. */
  private static readonly LIMIT = 4000;

  /** Последняя ошибка доставки — панель показывает её, а не молчит. */
  lastError: string | null = null;
  private sent = 0;

  constructor(
    private readonly store: Store,
    private readonly bot: Bot,
  ) {}

  get configured(): boolean {
    return !!config.alertChatId;
  }

  /**
   * Что показывать при выбранном уровне подробности.
   * «Всё» — весь разговор, «важное» — только то, что требует вмешательства,
   * «минимум» — только передачи человеку и просрочки.
   */
  private allowed(kind: EventKind): boolean {
    const level = runtime.notifyLevel;
    if (level === 'all') return true;
    if (level === 'important') return kind !== 'message' && kind !== 'ai_reply';
    if (kind === 'suspicious') return true;
    return kind === 'handoff' || kind === 'sla' || kind === 'aggressive';
  }

  state(): { configured: boolean; sent: number; lastError: string | null } {
    return { configured: this.configured, sent: this.sent, lastError: this.lastError };
  }

  private who(conversation: Conversation): string {
    return conversation.display_name
      ?? (conversation.username ? `@${conversation.username}` : `#${conversation.external_id}`);
  }

  private link(conversation: Conversation): string | undefined {
    if (!config.panelUrl) return undefined;
    return `${config.panelUrl.replace(/\/+$/, '')}/#c${conversation.id}`;
  }

  async notify(kind: EventKind, conversation: Conversation, details: NotifyDetails = {}): Promise<boolean> {
    if (!this.configured || !this.allowed(kind)) return false;

    const throttle = THROTTLE_MS[kind];
    let throttleKey: string | undefined;
    if (throttle > 0) {
      throttleKey = `notify:${kind}:${conversation.id}`;
      const last = Number(this.store.getState(throttleKey) ?? 0);
      if (Date.now() - last < throttle) return false;
    }

    const channel = conversation.channel === 'tg_dm'
      ? 'личка Business'
      : conversation.channel === 'tg_bot' ? 'личка бота' : 'тикет';
    const lines = [
      `<b>${TITLES[kind]}</b>`,
      `${escapeHtml(this.who(conversation))} · ${channel}${details.tone ? ` · ${details.tone}` : ''}`,
    ];
    if (details.reason) lines.push(`<i>${escapeHtml(details.reason)}</i>`);
    if (details.excerpt) lines.push('', `«${escapeHtml(cut(details.excerpt, 400))}»`);
    if (details.draft) lines.push('', `<b>AI предлагает:</b> ${escapeHtml(cut(details.draft, 400))}`);

    const waiting = this.store.waitingCount();
    if (waiting > 1) lines.push('', `Всего без ответа: ${waiting}`);

    const url = this.link(conversation);
    if (url) lines.push('', `<a href="${url}">Открыть диалог</a>`);

    const delivered = await this.deliver(lines.join('\n'));
    // Не подавляем повтор после сетевого отказа: пользователь не должен
    // потерять важное уведомление только потому, что первая доставка упала.
    if (delivered && throttleKey) this.store.setState(throttleKey, String(Date.now()));
    return delivered;
  }

  /** Проверка доставки — чтобы не гадать, доходят уведомления или нет. */
  async test(): Promise<{ ok: boolean; error?: string }> {
    if (!this.configured) return { ok: false, error: 'ALERT_CHAT_ID не задан' };
    const ok = await this.deliver('<b>ai-support</b>\nПроверка уведомлений. Если вы это видите, доставка работает.');
    return ok ? { ok: true } : { ok: false, error: this.lastError ?? 'неизвестная ошибка' };
  }

  /** HTML в плоский текст: запасной путь, когда Telegram отверг разметку. */
  private static stripTags(html: string): string {
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  private async deliver(html: string): Promise<boolean> {
    // Длинное обращение клиента легко переваливает лимит Telegram, и всё
    // уведомление отбивается целиком. Лучше обрезать, чем потерять. Режем по
    // границе тега (последний '>' до лимита): срез посреди тега или сущности
    // (&amp;) Telegram отвергает как «can't parse entities» — ровно тот отказ,
    // от которого обрезка и должна была спасти.
    let text = html;
    if (html.length > Notifier.LIMIT) {
      const head = html.slice(0, Notifier.LIMIT);
      const safeCut = head.lastIndexOf('>') + 1 || head.length;
      text = `${head.slice(0, safeCut)}\n…`;
    }
    try {
      await this.bot.api.sendMessage(config.alertChatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      this.sent += 1;
      this.lastError = null;
      return true;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      // Разметку Telegram мог отвергнуть из-за случайно битого HTML — тогда
      // ещё одна попытка плоским текстом доносит хотя бы суть, а не молчит.
      try {
        await this.bot.api.sendMessage(config.alertChatId, Notifier.stripTags(text), {
          link_preview_options: { is_disabled: true },
        });
        this.sent += 1;
        this.lastError = null;
        return true;
      } catch (plainErr) {
        // Молчать здесь нельзя: неверный id чата или бот не в группе выглядят
        // ровно как «уведомления не работают», и причину видно только в логе.
        this.lastError = plainErr instanceof Error ? plainErr.message : String(plainErr);
        log.error(`Уведомление не доставлено в ${config.alertChatId}: ${this.lastError}`);
        return false;
      }
    }
  }
}

/**
 * Тон клиента. Нужен и для уведомления, и для ворот: на взводе человеку
 * должен отвечать человек, а не модель.
 */
// Граница слова \b в JavaScript определена только для латиницы: перед
// кириллицей она не срабатывает, и любое правило с ней молча не работает.
// Поэтому границы задаём явно через класс не-букв.
const EDGE = '(?:^|[^\\p{L}])';

const AGGRESSIVE = [
  new RegExp(`${EDGE}(?:бля|блят|бляд|нахуй|нахер|нах\\b|пизд|ебан|ёбан|ебат|ебал|заеб|заёб|хуй|хуе|хуё|хуя|сука|суки|мраз|гнид|уёб|уеб|долбо)`, 'iu'),
  new RegExp(`${EDGE}(?:идиот|дебил|тупо[йеиы]|кретин|придурок|придурки|клоун|мошенник)`, 'iu'),
  new RegExp(`(?:вы|ты)\\s+(?:совсем\\s+|вообще\\s+)?(?:офиг|охре|обнагл|издева|ополоум)`, 'iu'),
];

const IRRITATED = [
  new RegExp(`${EDGE}(?:сколько можно|достал|достали|надоел|надоело|доколе|когда уже|в который раз|опять двадцать пять)`, 'iu'),
  /уже\s+\d+\s*(?:час|дн|день|недел|мес)/iu,
  /[?!]{3,}/u,
  new RegExp(`${EDGE}(?:верните деньги|отвратительн|ужасн|позор)`, 'iu'),
];

export function toneOf(text: string): 'спокойный' | 'раздражённый' | 'агрессивный' {
  if (AGGRESSIVE.some((pattern) => pattern.test(text))) return 'агрессивный';
  if (IRRITATED.some((pattern) => pattern.test(text))) return 'раздражённый';
  return 'спокойный';
}
