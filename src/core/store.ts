import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { StoreEvents } from './store/types.js';
import { ConversationRepo } from './store/conversations.js';
import { MessageRepo } from './store/messages.js';
import { SuggestionRepo } from './store/suggestions.js';
import { MiningRepo } from './store/mining.js';
import { KbRepo } from './store/kb.js';
import { TemplateRepo } from './store/templates.js';
import { AttachmentRepo } from './store/attachments.js';
import { SourceRepo } from './store/sources.js';
import { StateRepo } from './store/state.js';
import { JobRepo } from './store/jobs.js';
import { CustomerRepo } from './store/customers.js';
import { StatsRepo } from './store/stats.js';

export * from './store/types.js';

/**
 * Фасад хранилища. Методы живут в репозиториях `store/*.ts` и подмешиваются
 * в прототип Store; типы методов — из тех же классов через слияние
 * интерфейса, поэтому вызывающий код видит прежние сигнатуры.
 */
export interface Store extends
  ConversationRepo,
  MessageRepo,
  SuggestionRepo,
  MiningRepo,
  KbRepo,
  TemplateRepo,
  AttachmentRepo,
  SourceRepo,
  StateRepo,
  JobRepo,
  CustomerRepo,
  StatsRepo {}

export class Store extends EventEmitter<StoreEvents> {
  constructor(readonly db: Database.Database) {
    super();
  }
}

for (const repo of [
  ConversationRepo,
  MessageRepo,
  SuggestionRepo,
  MiningRepo,
  KbRepo,
  TemplateRepo,
  AttachmentRepo,
  SourceRepo,
  StateRepo,
  JobRepo,
  CustomerRepo,
  StatsRepo,
]) {
  for (const name of Object.getOwnPropertyNames(repo.prototype)) {
    if (name === 'constructor') continue;
    // Совпадение имён в двух репозиториях тихо подменило бы метод.
    if (Object.hasOwn(Store.prototype, name)) throw new Error(`Store: метод ${name} объявлен дважды`);
    Object.defineProperty(Store.prototype, name, Object.getOwnPropertyDescriptor(repo.prototype, name)!);
  }
}
