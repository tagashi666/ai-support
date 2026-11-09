/**
 * Реестр действий (план, 7.4): каждое действие описано один раз — название,
 * право, ярус подтверждения (7.6), что делать без права, где показывать на
 * компьютере и на телефоне. Из него строятся кнопки, меню «⋯» строки и
 * шапки, подсказки клавиш и проверка прав. Тест registry.test.ts проверяет,
 * что всё, что есть на компьютере, достижимо и на 390 px.
 */
import type { Key } from '@/i18n/ru';

export type ActionId =
  | 'reply.send' | 'draft.send' | 'draft.edit' | 'draft.reject'
  | 'conv.open' | 'conv.read' | 'conv.resolve' | 'conv.reopen' | 'conv.status' | 'conv.important' | 'conv.hide' | 'conv.unhide'
  | 'conv.take' | 'conv.return' | 'conv.takeover' | 'conv.aimode' | 'conv.note' | 'conv.attach' | 'conv.template'
  | 'conv.copyLink' | 'msg.quote' | 'msg.copy';

/** Где действие видно. Ширина не прячет действие: на телефоне оно в другом месте, но есть. */
export type Place = 'row' | 'rowMenu' | 'head' | 'headMenu' | 'chip' | 'draft' | 'composer' | 'message';

export interface ActionDef {
  id: ActionId;
  label: Key;
  /** Право сервера (src/core/operations.ts); null — нужно только чтение. */
  permission: string | null;
  /** 0 — обратимое с «Отменить»; 1 — видно клиенту (окно отмены); 2 — лист с вопросом; 3 — «было → станет». */
  tier: 0 | 1 | 2 | 3;
  /** Отложенная фиксация: запрос уходит после окна отмены (след вне панели). */
  deferred?: boolean;
  /** Без права: hide — не рисовать; explain — неактивно с причиной. */
  noRight: 'hide' | 'explain';
  desktop: readonly Place[];
  phone: readonly Place[];
  /** Сочетание клавиш (подпись — в словаре; привязка по event.code). */
  key?: string;
}

const A = (def: ActionDef): ActionDef => def;

export const ACTIONS: Readonly<Record<ActionId, ActionDef>> = {
  'reply.send': A({ id: 'reply.send', label: 'composer.send', permission: 'conversation:reply', tier: 1, noRight: 'explain', desktop: ['composer'], phone: ['composer'], key: 'Mod+Enter' }),
  'draft.send': A({ id: 'draft.send', label: 'draft.send', permission: 'conversation:reply', tier: 1, noRight: 'explain', desktop: ['draft'], phone: ['draft'], key: 'Mod+Enter' }),
  'draft.edit': A({ id: 'draft.edit', label: 'draft.edit', permission: 'conversation:reply', tier: 0, noRight: 'explain', desktop: ['draft'], phone: ['draft'] }),
  'draft.reject': A({ id: 'draft.reject', label: 'draft.reject', permission: 'conversation:reply', tier: 0, deferred: true, noRight: 'hide', desktop: ['draft'], phone: ['draft'] }),
  'conv.open': A({ id: 'conv.open', label: 'action.open', permission: null, tier: 0, noRight: 'hide', desktop: ['row'], phone: ['row'], key: 'Enter' }),
  'conv.read': A({ id: 'conv.read', label: 'action.read', permission: null, tier: 0, noRight: 'hide', desktop: ['rowMenu'], phone: ['rowMenu'] }),
  'conv.resolve': A({ id: 'conv.resolve', label: 'thread.resolve', permission: 'conversation:status', tier: 0, deferred: true, noRight: 'explain', desktop: ['head', 'rowMenu'], phone: ['head', 'rowMenu'] }),
  'conv.reopen': A({ id: 'conv.reopen', label: 'thread.reopen', permission: 'conversation:status', tier: 0, noRight: 'explain', desktop: ['chip', 'rowMenu'], phone: ['chip', 'rowMenu'] }),
  'conv.status': A({ id: 'conv.status', label: 'thread.statusWaitClient', permission: 'conversation:status', tier: 0, noRight: 'explain', desktop: ['headMenu'], phone: ['headMenu'] }),
  'conv.important': A({ id: 'conv.important', label: 'thread.markImportant', permission: 'conversation:status', tier: 0, deferred: true, noRight: 'hide', desktop: ['headMenu', 'rowMenu'], phone: ['headMenu', 'rowMenu'] }),
  'conv.hide': A({ id: 'conv.hide', label: 'thread.hide', permission: 'conversation:status', tier: 0, deferred: true, noRight: 'hide', desktop: ['headMenu', 'rowMenu'], phone: ['headMenu', 'rowMenu'] }),
  'conv.unhide': A({ id: 'conv.unhide', label: 'thread.unhide', permission: 'conversation:status', tier: 0, noRight: 'hide', desktop: ['head'], phone: ['head'] }),
  'conv.take': A({ id: 'conv.take', label: 'who.take', permission: 'conversation:status', tier: 0, noRight: 'explain', desktop: ['chip'], phone: ['chip'] }),
  'conv.return': A({ id: 'conv.return', label: 'who.giveBack', permission: 'conversation:status', tier: 0, noRight: 'explain', desktop: ['chip'], phone: ['chip'] }),
  'conv.takeover': A({ id: 'conv.takeover', label: 'who.intercept', permission: 'conversation:assign', tier: 2, noRight: 'hide', desktop: ['chip'], phone: ['chip'] }),
  'conv.aimode': A({ id: 'conv.aimode', label: 'thread.aiMode', permission: 'conversation:status', tier: 0, noRight: 'explain', desktop: ['chip', 'headMenu'], phone: ['chip', 'headMenu'] }),
  'conv.note': A({ id: 'conv.note', label: 'composer.note', permission: 'conversation:notes', tier: 0, noRight: 'explain', desktop: ['composer'], phone: ['composer'] }),
  'conv.attach': A({ id: 'conv.attach', label: 'composer.attach', permission: 'conversation:attachments', tier: 0, noRight: 'explain', desktop: ['composer'], phone: ['composer'], key: 'Mod+Shift+KeyU' }),
  'conv.template': A({ id: 'conv.template', label: 'composer.templates', permission: 'templates:read', tier: 0, noRight: 'hide', desktop: ['composer'], phone: ['composer'], key: 'Slash' }),
  'conv.copyLink': A({ id: 'conv.copyLink', label: 'thread.copyLink', permission: null, tier: 0, noRight: 'hide', desktop: ['headMenu'], phone: ['headMenu'] }),
  'msg.quote': A({ id: 'msg.quote', label: 'message.quote', permission: 'conversation:reply', tier: 0, noRight: 'explain', desktop: ['message'], phone: ['message'] }),
  'msg.copy': A({ id: 'msg.copy', label: 'message.copy', permission: null, tier: 0, noRight: 'hide', desktop: ['message'], phone: ['message'] }),
};

export type Availability = 'show' | 'hide' | 'explain';

/** Показать, скрыть или показать неактивным с причиной — по правам того, кто смотрит. */
export function availability(id: ActionId, permissions: ReadonlySet<string> | readonly string[]): Availability {
  const def = ACTIONS[id];
  if (!def.permission) return 'show';
  const has = Array.isArray(permissions) ? permissions.includes(def.permission) : (permissions as ReadonlySet<string>).has(def.permission);
  return has ? 'show' : def.noRight;
}

/** Действия для места на экране в порядке реестра. */
export function actionsAt(place: Place, phone: boolean): ActionDef[] {
  return Object.values(ACTIONS).filter((def) => (phone ? def.phone : def.desktop).includes(place));
}
