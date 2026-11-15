import { Logger } from '@nestjs/common';

import type { StaffActor } from './contracts';

/**
 * Portal 学生管理集成接口（/api/integration/students、/api/integration/feature-access）的唯一客户端。
 *
 * - 地址：PORTAL_STUDENTS_BASE_URL，没配就用已有的 PORTAL_HELPDESK_BASE_URL（同一个 Portal）。
 * - 鉴权：Bearer PORTAL_STUDENTS_TOKEN，没配就用 PORTAL_HELPDESK_TOKEN（Portal 那边同样回退），
 *   已接好 HelpDesk 的环境不用新增密钥。每次请求现读，轮换不用重启。
 * - 任一未配置：503 STUDENTS_NOT_CONNECTED，且不发请求。
 * - Portal 的 RFC 9457 problem+json 在这里映射成 BackOffice 错误码；成功体原样转给页面（形状由 Portal 契约定）。
 */

const TIMEOUT_MS = 8_000;

export class StudentsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StudentsError';
  }
}

export type PortalStudentsConfig = { baseUrl: string; token: string };

const mismatchLogger = new Logger('PortalStudentsClient');
const warnedMismatches = new Set<string>();

function baseIdentity(raw: string): string | null {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * BUG-0330：两个地址按约定是同一个 Portal。指向不同 Portal 时，BackOffice 读到的
 * 不是学员保存资料的那份数据，症状是"学生详情全空"而不是报错。这里只告警，不改取数。
 */
export function portalBaseMismatch(): {
  students: string;
  helpdesk: string;
} | null {
  const students = process.env.PORTAL_STUDENTS_BASE_URL?.trim() ?? '';
  const helpdesk = process.env.PORTAL_HELPDESK_BASE_URL?.trim() ?? '';
  if (students === '' || helpdesk === '') return null;
  const a = baseIdentity(students);
  const b = baseIdentity(helpdesk);
  if (a === null || b === null || a === b) return null;
  return { students, helpdesk };
}

export function portalStudentsConfig(): PortalStudentsConfig | null {
  const rawBase = (
    process.env.PORTAL_STUDENTS_BASE_URL?.trim() ||
    process.env.PORTAL_HELPDESK_BASE_URL?.trim() ||
    ''
  ).trim();
  const token = (
    process.env.PORTAL_STUDENTS_TOKEN?.trim() ||
    process.env.PORTAL_HELPDESK_TOKEN?.trim() ||
    ''
  ).trim();
  if (rawBase === '' || token === '') return null;
  try {
    const url = new URL(rawBase);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  const mismatch = portalBaseMismatch();
  if (mismatch) {
    const key = `${mismatch.students}\n${mismatch.helpdesk}`;
    if (!warnedMismatches.has(key)) {
      warnedMismatches.add(key);
      mismatchLogger.warn(
        `PORTAL_STUDENTS_BASE_URL (${mismatch.students}) and PORTAL_HELPDESK_BASE_URL (${mismatch.helpdesk}) point at different Portals; student details come from the students one.`,
      );
    }
  }
  return { baseUrl: rawBase.replace(/\/+$/, ''), token };
}

/** Portal problem code → BackOffice 错误码与状态；detail 只在校验类错误时转给员工（不含学员隐私以外的内容）。 */
const PROBLEM_MAP: Record<
  string,
  { status: number; code: string; useDetail: boolean }
> = {
  validation_failed: { status: 400, code: 'INVALID_INPUT', useDetail: true },
  not_found: { status: 404, code: 'STUDENT_NOT_FOUND', useDetail: false },
  version_conflict: { status: 409, code: 'VERSION_CONFLICT', useDetail: true },
  email_taken: { status: 409, code: 'EMAIL_TAKEN', useDetail: true },
  email_unverified: { status: 409, code: 'EMAIL_UNVERIFIED', useDetail: true },
  account_inactive: { status: 409, code: 'ACCOUNT_INACTIVE', useDetail: true },
  rate_limited: { status: 429, code: 'RATE_LIMITED', useDetail: true },
  email_unavailable: {
    status: 503,
    code: 'EMAIL_UNAVAILABLE',
    useDetail: true,
  },
  email_delivery_failed: {
    status: 502,
    code: 'EMAIL_DELIVERY_FAILED',
    useDetail: true,
  },
};

function notConnected(): StudentsError {
  return new StudentsError(
    503,
    'STUDENTS_NOT_CONNECTED',
    'Student Management is not connected yet',
  );
}

function unavailable(status = 502): StudentsError {
  return new StudentsError(
    status,
    'STUDENTS_UNAVAILABLE',
    'Student Management is unavailable, please try again',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type PortalStudentsClient = {
  get: (path: string) => Promise<Record<string, unknown>>;
  write: (
    method: 'PUT' | 'POST',
    path: string,
    body: Record<string, unknown>,
    actor: StaffActor,
  ) => Promise<Record<string, unknown>>;
};

export function createPortalStudentsClient(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): PortalStudentsClient {
  const logger = new Logger('PortalStudentsClient');
  const fetchImpl: typeof fetch =
    options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  async function send(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const config = portalStudentsConfig();
    if (!config) throw notConnected();
    const headers: Record<string, string> = {
      authorization: `Bearer ${config.token}`,
      accept: 'application/json, application/problem+json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetchImpl(`${config.baseUrl}/api/integration${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        logger.warn(`Portal students timed out after ${timeoutMs}ms`);
        throw unavailable(504);
      }
      logger.warn('Portal students is unreachable');
      throw unavailable();
    }
    let parsed: unknown = null;
    try {
      const text = await response.text();
      parsed = text.trim() ? (JSON.parse(text) as unknown) : null;
    } catch {
      if (response.ok) throw unavailable();
    }
    if (!response.ok) {
      const code =
        isRecord(parsed) && typeof parsed.code === 'string' ? parsed.code : '';
      if (code === 'invalid_token' || code === 'integration_disabled') {
        logger.error(`Portal rejected the service token (${code})`);
        throw notConnected();
      }
      const mapped = PROBLEM_MAP[code];
      if (!mapped) {
        logger.warn(
          `Portal students answered ${response.status} ${code || '(no code)'}`,
        );
        throw unavailable();
      }
      const detail =
        mapped.useDetail &&
        isRecord(parsed) &&
        typeof parsed.detail === 'string'
          ? parsed.detail.slice(0, 300)
          : mapped.code === 'STUDENT_NOT_FOUND'
            ? 'Student not found'
            : 'Request failed';
      throw new StudentsError(mapped.status, mapped.code, detail);
    }
    if (!isRecord(parsed)) throw unavailable();
    return parsed;
  }

  return {
    get: (path) => send('GET', path),
    write: (method, path, body, actor) =>
      send(method, path, { ...body, actor }),
  };
}
