/** Подписи рабочего места: значения перечислений сервера → ключи словаря (сырые значения на экран не попадают). */
import { t, type Key } from '@/i18n/ru';

const MODE_KEY: Record<string, Key> = {
  inherit: 'mode.inherit', off: 'mode.off', shadow: 'mode.shadow', suggest: 'mode.suggest', auto: 'mode.auto',
};
const MODE_HERE_KEY: Record<string, Key> = {
  inherit: 'mode.inherit', off: 'mode.here.off', shadow: 'mode.here.shadow', suggest: 'mode.here.suggest', auto: 'mode.here.auto',
};
const ROLE_KEY: Record<string, Key> = { admin: 'role.admin', lead: 'role.lead', agent: 'role.agent', viewer: 'role.viewer' };
const VIEW_KEY: Record<string, Key> = { waiting: 'chats.view.waiting', open: 'chats.view.open', done: 'chats.view.done' };

export const modeLabel = (mode: string): string => t(MODE_KEY[mode] ?? 'mode.inherit');
export const modeHereLabel = (mode: string): string => t(MODE_HERE_KEY[mode] ?? 'mode.inherit');
export const roleLabel = (role: string): string => t(ROLE_KEY[role] ?? 'role.unknown');
export const viewLabel = (view: string): string => t(VIEW_KEY[view] ?? 'chats.view.open');
