/**
 * API のエラー。server.ts が `{ error: { code, message, field? } }` の形で返す（docs/api.md「エラー形式」）。
 */

export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'text_too_long'
  | 'unsupported_media_type'
  | 'model_not_installed'
  | 'unprocessable_text'
  | 'queue_full'
  | 'internal_error'
  | 'engine_unavailable'
  | 'timeout';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly field: string | undefined;
  /** 429 の Retry-After（秒） */
  retryAfterSec: number | undefined;

  constructor(status: number, code: ErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field;
  }

  toJSON(): { error: { code: ErrorCode; message: string; field?: string } } {
    return { error: { code: this.code, message: this.message, ...(this.field ? { field: this.field } : {}) } };
  }
}

export const invalid = (message: string, field?: string): ApiError => new ApiError(400, 'invalid_request', message, field);
export const notFound = (message: string, field?: string): ApiError => new ApiError(404, 'not_found', message, field);
export const conflict = (message: string, field?: string): ApiError => new ApiError(409, 'conflict', message, field);
