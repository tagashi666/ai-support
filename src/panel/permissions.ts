import type { Permission } from '../core/operations.js';

/**
 * Карта «маршрут → право» (план редизайна, раздел 10, правило 6). Белый
 * список: маршрут, которого здесь нет, доступен только с DENY_BY_DEFAULT.
 * scripts/sectest.ts перебирает все зарегистрированные маршруты и падает на
 * неописанных, поэтому новый маршрут попадает сюда в том же коммите.
 */
// Чтение, доступное любому оператору с conversation:read. Раньше это было
// правилом по умолчанию для всех GET, а любой неописанный POST получал
// conversation:status — новый маршрут молча открывался агенту.
const CONVERSATION_READ_ROUTES = /^\/api\/(?:conversations(?:\/\d+(?:\/(?:avatar|customer|profile))?)?|inbox(?:\/meta)?|thread\/\d+|events|bootstrap|me|search|attachments\/\d+(?:\/lottie)?|health|ticket)(?:\?|$)/;

export const permissionFor = (method: string, url: string): Permission | undefined => {
  if (url.startsWith('/api/roles')) return 'roles:manage';
  if (url.startsWith('/api/operators')) return method === 'GET' ? 'team:read' : 'operators:manage';
  if (url.startsWith('/api/operator-stats')) return 'operator_stats:read';
  if (method === 'POST' && /^\/api\/attachments\/\d+\/retry(?:\?|$)/.test(url)) return 'conversation:read';
  if (url.startsWith('/api/audit')) return 'audit:read';
  if (url.startsWith('/api/diagnostics')) return 'diagnostics:read';
  if (url.startsWith('/api/update')) return 'settings:update';
  if (url.startsWith('/api/sources')) return 'settings:sources';
  if (url.startsWith('/api/learning')) return 'knowledge:review';
  if (url.startsWith('/api/ai/keys') || url.startsWith('/api/ai/models') || url.startsWith('/api/ai/ping')) {
    return 'settings:ai_tools';
  }
  if (url.startsWith('/api/ai/try')) return 'settings:ai_tools';
  // Помощник (10.4): пауза — settings:read на входе, setting:aiMode проверяет обработчик.
  if (/^\/api\/assistant\/(?:pause|settings)(?:\?|$)/.test(url)) return 'settings:read';
  if ((method === 'GET' || method === 'HEAD') && /^\/api\/assistant\/activity(?:\?|$)/.test(url)) return 'stats:read';
  if (method === 'POST' && /^\/api\/messages\/\d+\/feedback(?:\?|$)/.test(url)) return 'conversation:reply';
  if (url.startsWith('/api/stats/reset')) return 'stats:reset';
  if (url.startsWith('/api/stats')) return 'stats:read';
  if (url.startsWith('/api/inbox/folders') && method !== 'GET') return 'settings:sources';
  if (url.startsWith('/api/sla') && method !== 'GET') return 'queue:manage';
  if (url.startsWith('/api/queue') || url.startsWith('/api/sla')) return 'queue:read';
  if (url.startsWith('/api/filters')) return 'queue:read';
  if (url.startsWith('/api/templates') && method !== 'GET') return 'templates:manage';
  if (url.startsWith('/api/templates')) return 'templates:read';
  // Черновик по id читает любой, кто видит диалог: «Почему так?» и «только просмотр» (6.3.2, 6.3.4).
  if ((method === 'GET' || method === 'HEAD') && /^\/api\/suggestions\/\d+(?:\?|$)/.test(url)) return 'conversation:read';
  if (url.startsWith('/api/suggestions')) return 'conversation:reply';
  if (url.startsWith('/api/interface-kb')) return method === 'GET' || method === 'HEAD' ? 'knowledge:read' : 'knowledge:manage';
  if (url.startsWith('/api/kb/mine')) return 'knowledge:mine';
  if (method === 'GET' && /^\/api\/kb\/draft(?:\/|\?|$)/.test(url)) return 'knowledge:review';
  if (url.startsWith('/api/kb') && method !== 'GET') return 'knowledge:manage';
  if (url.startsWith('/api/kb')) return 'knowledge:read';
  if (/^\/api\/conversations\/\d+\/bedolaga\/subscriptions\/\d+\/extend(?:\?|$)/.test(url)) {
    return 'bedolaga:extend';
  }
  if (/^\/api\/conversations\/\d+\/bedolaga\/customer(?:\?|$)/.test(url)) {
    return 'bedolaga:view';
  }
  if (url.includes('/subscription/action')) return 'bedolaga:devices';
  if (url.includes('/subscription')) return 'bedolaga:view';
  if (/\/conversations\/\d+\/attachments(?:\?|$)/.test(url)) return 'conversation:attachments';
  if (/\/conversations\/\d+\/reply(?:\?|$)/.test(url)) return 'conversation:reply';
  if (/\/conversations\/\d+\/(?:note|profile\/notes)(?:\?|$)/.test(url)) return 'conversation:notes';
  if (/\/conversations\/\d+\/(?:read|presence)(?:\?|$)/.test(url)) return 'conversation:read';
  if (/\/conversations\/\d+\/customer\/refresh(?:\?|$)/.test(url)) return 'conversation:profile';
  if (/\/conversations\/\d+\/profile(?:\?|$)/.test(url) && method !== 'GET') return 'conversation:profile';
  if (/\/conversations\/\d+\/(?:state|engage|release)(?:\?|$)/.test(url)) return 'conversation:status';
  if (url.startsWith('/api/settings/services/')) return 'settings:services';
  if (url.startsWith('/api/settings/test-alert')) return 'settings:alerts';
  if (url.startsWith('/api/nodes')) return 'settings:nodes';
  if (url === '/api/settings' || url.startsWith('/api/settings?')) return 'settings:read';
  if ((method === 'GET' || method === 'HEAD') && CONVERSATION_READ_ROUTES.test(url)) return 'conversation:read';
  return undefined;
};

// Маршрут без правила выше доступен только тому, кто может менять роли.
// Ошибка в эту сторону видна сразу (403 у оператора), а не через утечку.
export const DENY_BY_DEFAULT: Permission = 'roles:manage';

/** Маршрут в виде Fastify (`/api/x/:id`) → образец адреса для permissionFor. */
export const routeSample = (url: string): string => url.replace(/:[A-Za-z]+/g, '1');

/** Маршруты /api, зарегистрированные в этом процессе (хук onRoute в server.ts). */
export const registeredApiRoutes: Array<{ method: string; url: string }> = [];
