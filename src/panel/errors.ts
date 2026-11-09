import type { ApiError, ErrorCode } from '../shared/api-types.js';

/**
 * Ответ с ошибкой в едином формате (план редизайна, 10.2 п.3): `code` для
 * новой панели, текст `error` — для классики и людей.
 */
export const apiError = (code: ErrorCode, error: string): ApiError => ({ error, code });
