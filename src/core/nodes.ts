import { config, log } from '../config.js';
import type { NodeState, RemnawaveClient } from '../integrations/remnawave.js';
import type { Store } from './store.js';

/**
 * Состояние узлов для модели и оператора.
 *
 * Модель не спрашивает Remnawave — она получает готовый текст, который здесь
 * собирается и чистится. Так у неё нет ни доступа к панели, ни возможности
 * что-то в ней изменить: только слепок, снятый нами.
 */
export interface NodesSnapshot {
  at: number;
  nodes: NodeState[];
  error?: string;
}

export interface RemnawaveNodeSource {
  id: string;
  name: string;
  client: RemnawaveClient;
}

export class NodeWatch {
  private snapshot: NodesSnapshot = { at: 0, nodes: [] };
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly store: Store,
    remnawave: RemnawaveClient | RemnawaveNodeSource[],
  ) {
    this.sources = Array.isArray(remnawave)
      ? remnawave
      : [{ id: 'remnawave:legacy', name: 'Remnawave', client: remnawave }];
  }

  private readonly sources: RemnawaveNodeSource[];

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), config.nodes.pollSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get(): NodesSnapshot {
    return this.snapshot;
  }

  async refresh(): Promise<NodesSnapshot> {
    const results = await Promise.allSettled(this.sources.map(async (source) => {
      const nodes = await source.client.nodes();
      if (!nodes) throw new Error('панель не отдала список узлов');
      return nodes.map((node) => ({
        ...node,
        sourceId: source.id,
        sourceName: source.name,
        aliasKey: `${source.id}:${node.rawName}`,
      }));
    }));

    const previousBySource = new Map(this.sources.map((source) => [
      source.id,
      this.snapshot.nodes.filter((node) => node.sourceId === source.id),
    ]));
    const nodes: NodeState[] = [];
    const errors: string[] = [];
    let succeeded = 0;
    results.forEach((result, index) => {
      const source = this.sources[index]!;
      if (result.status === 'fulfilled') {
        succeeded += 1;
        nodes.push(...result.value);
      } else {
        nodes.push(...(previousBySource.get(source.id) ?? []));
        errors.push(`${source.name}: ${(result.reason as Error)?.message ?? String(result.reason)}`);
      }
    });

    if (succeeded) {
      this.snapshot = { at: Date.now(), nodes, ...(errors.length ? { error: errors.join('; ') } : {}) };
      this.store.setState('nodes:last_ok', String(Date.now()));
    } else {
      const message = errors.join('; ') || 'ни одна панель не отдала список узлов';
      log.debug(`Состояние узлов не обновилось: ${message}`);
      this.snapshot = { ...this.snapshot, error: message };
    }
    return this.snapshot;
  }

  /**
   * Текст для модели. Устаревший слепок помечаем прямо в тексте: пусть
   * лучше AI скажет «сведений нет», чем выдаст вчерашнюю картину за
   * сегодняшнюю — именно так появился ответ «сбоев не было».
   */
  render(): string {
    const { at, nodes } = this.snapshot;
    if (!nodes.length) {
      return 'Сведений о состоянии серверов нет. Не утверждай ничего об авариях и работоспособности узлов.';
    }

    const ageMinutes = Math.round((Date.now() - at) / 60_000);
    if (ageMinutes > config.nodes.staleMinutes) {
      return `Сведения о серверах устарели (обновлялись ${ageMinutes} мин назад). Считай, что данных нет, и не утверждай ничего об авариях.`;
    }

    // Псевдоним оператора сильнее очищенного имени: внутренние названия
    // модель видеть не должна вовсе.
    const aliases = this.store.nodeAliases();
    const lines = nodes.map((node) => {
      const label = aliases[node.aliasKey ?? node.rawName]?.trim()
        || aliases[node.rawName]?.trim()
        || node.name;
      const state = node.disabled ? 'выключен администратором'
        : node.online ? 'работает'
        : 'недоступен';
      const users = node.usersOnline !== undefined ? `, подключено ${node.usersOnline}` : '';
      return `- ${label}: ${state}${users}`;
    });

    const down = nodes.filter((n) => !n.online).length;
    const summary = down
      ? `Недоступных узлов: ${down} из ${nodes.length}.`
      : 'Все узлы работают.';

    return [
      `Состояние серверов на ${new Date(at).toLocaleString('ru-RU')} (${summary})`,
      ...lines,
      'Об узлах, которых нет в этом списке, сведений у тебя нет — так и говори.',
    ].join('\n');
  }
}
