/**
 * Коды ошибок сервера словами (план, 6.3.5 и 6.14): что не получилось, что
 * сделать. Сырые тексты сервера и браузера не показываются; код — в
 * «Подробностях».
 */
import type { Key } from '@/i18n/ru';

export type FixAction = 'retry' | 'toField' | 'note' | 'waitClient' | 'takeover' | 'copy' | 'connections' | 'checkFeed';

export interface ErrorView {
  text: Key;
  actions: FixAction[];
  /** Повтор возможен: после обрыва связи — только с проверкой ленты (10.3 п.2 без ключа). */
  retry: boolean;
}

export function sendErrorView(code: string, hasClientId: boolean): ErrorView {
  switch (code) {
    case 'window_closed': return { text: 'error.windowClosed', actions: ['note', 'waitClient'], retry: false };
    case 'locked_by_other': return { text: 'error.lockedByOther', actions: ['takeover', 'copy'], retry: false };
    case 'no_sender': return { text: 'error.noSender', actions: ['connections'], retry: false };
    case 'permission': return { text: 'error.permission', actions: [], retry: false };
    case 'rate_limited': return { text: 'error.rateLimited', actions: ['retry'], retry: true };
    case 'upstream': return { text: 'error.upstream', actions: ['retry', 'toField'], retry: true };
    // Обрыв: с client_msg_id повтор безопасен, без него — сначала проверить ленту.
    case 'network': return hasClientId
      ? { text: 'error.network', actions: ['retry', 'toField'], retry: true }
      : { text: 'error.networkCheck', actions: ['checkFeed', 'toField'], retry: false };
    default: return { text: 'error.unknown', actions: ['retry', 'toField'], retry: true };
  }
}

/** Ошибка действия (статус, режим, важность) — короткий текст для тоста. */
export function actionErrorText(code: string): Key {
  switch (code) {
    case 'permission': return 'error.actionPermission';
    case 'upstream': return 'error.actionUpstream';
    case 'no_sender': return 'error.actionNoSender';
    case 'locked_by_other': return 'error.lockedByOther';
    case 'network': return 'error.actionNetwork';
    case 'not_found': return 'error.notFound';
    default: return 'error.actionUnknown';
  }
}
