/**
 * 统一响应信封（Admin 仓库规则：success/data/error/message）。
 * `error` 是稳定机器码，前端按它查 i18n；`message` 仅作兜底。
 */
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_EMPLOYEE_ACCOUNT'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'EMAIL_NOT_VERIFIED'
  | 'NOT_AUTHORISED'
  | 'RATE_LIMITED'
  | 'PROTECTED_ADMIN_ACCOUNT'
  | 'LAST_ADMIN'
  | 'SELF_ACCOUNT_EDIT'
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_ALREADY_USED'
  | 'DUPLICATE_EMAIL'
  | 'PASSWORD_TOO_WEAK'
  | 'PASSWORD_MISMATCH'
  | 'PASSWORD_SAME_AS_CURRENT'
  | 'INTERNAL_ERROR';

export type Envelope<T> =
  | { success: true; data: T; error: null; message: string }
  | { success: false; data: null; error: ErrorCode; message: string };

export function ok<T>(data: T, message = 'OK'): Envelope<T> {
  return { success: true, data, error: null, message };
}

export function fail<T = never>(
  error: ErrorCode,
  message: string,
): Envelope<T> {
  return { success: false, data: null, error, message };
}

export const ERROR_STATUS: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  INVALID_EMPLOYEE_ACCOUNT: 401,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_NOT_ACTIVE: 403,
  EMAIL_NOT_VERIFIED: 403,
  NOT_AUTHORISED: 403,
  RATE_LIMITED: 429,
  PROTECTED_ADMIN_ACCOUNT: 403,
  LAST_ADMIN: 409,
  SELF_ACCOUNT_EDIT: 409,
  INVALID_TOKEN: 400,
  TOKEN_EXPIRED: 410,
  TOKEN_ALREADY_USED: 410,
  DUPLICATE_EMAIL: 409,
  PASSWORD_TOO_WEAK: 400,
  PASSWORD_MISMATCH: 400,
  PASSWORD_SAME_AS_CURRENT: 400,
  INTERNAL_ERROR: 500,
};
