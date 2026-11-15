import type { ErrorCode } from '../../../contracts/envelope';
import {
  deriveDisplayStatus,
  editsOwnAuthority,
  isAccountStatus,
  isDisplayStatus,
  isEmployeeRole,
  isValidEmail,
  normaliseEmail,
  type AccountStatus,
  type DisplayStatus,
  type EmployeeRole,
} from '../../../contracts/employee';
import {
  EMPLOYEE_PAGE_MAX,
  EMPLOYEE_PAGE_SIZE_DEFAULT,
  EMPLOYEE_PAGE_SIZE_MAX,
} from '../../../lib/securityPolicy';
import { tryRecordAuditEvent } from '../../../repositories/auditRepository';
import * as employeeRepository from '../../../repositories/employeeRepository';
import * as sessionRepository from '../../../repositories/sessionRepository';
import {
  manualLinkFor,
  sendActivationEmail as sendActivationEmailTo,
  sendPasswordResetEmail,
  type EmailDeliveryResult,
} from '../../notification/services/email';
import {
  activationLink,
  issueActivationToken,
  issueResetToken,
  resetLink,
  revokeTokensForEmployee,
} from '../../user-authentication/services/verificationTokens';
import { reissueActivation } from '../../user-authentication/services/passwordFlows';

export type EmployeeListItem = {
  employeeId: string;
  loginEmail: string;
  role: EmployeeRole;
  accountStatus: AccountStatus;
  emailVerification: 'PENDING_VERIFICATION' | 'VERIFIED';
  displayStatus: DisplayStatus;
  lastLoginAt: string | null;
  isBootstrapAdmin: boolean;
};

export type EmployeeListResult = {
  items: EmployeeListItem[];
  total: number;
  page: number;
  pageSize: number;
};

function toListItem(
  record: employeeRepository.EmployeeRecord,
): EmployeeListItem {
  return {
    employeeId: record.employeeId,
    loginEmail: record.loginEmail,
    role: record.role,
    accountStatus: record.accountStatus,
    emailVerification: record.emailVerification,
    displayStatus: deriveDisplayStatus(
      record.accountStatus,
      record.emailVerification,
    ),
    lastLoginAt: record.lastLoginAt ? record.lastLoginAt.toISOString() : null,
    isBootstrapAdmin: record.isBootstrapAdmin,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}

/** 非有限数或越界的分页参数夹到 [1, max]，避免巨大 OFFSET 让数据库报错。 */
function clampInt(value: number | undefined, fallback: number, max: number) {
  const n =
    value !== undefined && Number.isFinite(value)
      ? Math.trunc(value)
      : fallback;
  return Math.min(Math.max(1, n), max);
}

/** PRD PORT-LST-002：邮箱模糊搜索 + 角色/状态筛选 + 分页可组合。 */
export async function listEmployees(input: {
  email?: string;
  role?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}): Promise<EmployeeListResult> {
  const pageSize = clampInt(
    input.pageSize,
    EMPLOYEE_PAGE_SIZE_DEFAULT,
    EMPLOYEE_PAGE_SIZE_MAX,
  );
  const page = clampInt(input.page, 1, EMPLOYEE_PAGE_MAX);

  const filter: employeeRepository.EmployeeFilter = {
    limit: pageSize,
    offset: (page - 1) * pageSize,
  };

  const email = (input.email ?? '').trim();
  if (email !== '') filter.email = email;
  if (isEmployeeRole(input.role)) filter.role = input.role;
  if (isDisplayStatus(input.status)) filter.status = input.status;

  const { rows, total } = await employeeRepository.listEmployees(filter);
  return { items: rows.map(toListItem), total, page, pageSize };
}

export type CreateEmployeeOutcome =
  | {
      ok: true;
      employee: EmployeeListItem;
      delivery: string;
      manualLink: string;
    }
  | { ok: false; code: ErrorCode };

/** PRD PORT-NEW-001~004。 */
export async function createEmployee(input: {
  rawEmail: string;
  role: string;
  accountStatus: string;
  actorEmployeeId: string;
  locale: string;
  appUrl: string;
  ipAddress: string | null;
}): Promise<CreateEmployeeOutcome> {
  const email = normaliseEmail(input.rawEmail);
  if (!isValidEmail(email) || !isEmployeeRole(input.role)) {
    return { ok: false, code: 'INVALID_INPUT' };
  }

  const accountStatus: AccountStatus = isAccountStatus(input.accountStatus)
    ? input.accountStatus
    : 'ACTIVE';

  let created: employeeRepository.EmployeeRecord;
  try {
    created = await employeeRepository.createEmployee({
      loginEmail: email,
      role: input.role,
      accountStatus,
      emailVerification: 'PENDING_VERIFICATION',
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, code: 'DUPLICATE_EMAIL' };
    throw error;
  }

  const rawToken = await issueActivationToken(created.employeeId);
  const link = activationLink(input.appUrl, input.locale, rawToken);
  const delivery = await sendActivationEmailTo({
    to: created.loginEmail,
    link,
    locale: input.locale,
  });

  await tryRecordAuditEvent({
    eventName: 'employee_created',
    actorEmployeeId: input.actorEmployeeId,
    targetEmployeeId: created.employeeId,
    action: 'CREATE_EMPLOYEE',
    newValue: `${created.role}:${created.accountStatus}:${delivery}`,
    result: 'SUCCESS',
    ipAddress: input.ipAddress,
  });

  return {
    ok: true,
    employee: toListItem(created),
    delivery,
    manualLink: manualLinkFor(link),
  };
}

export type UpdateEmployeeOutcome =
  | {
      ok: true;
      employee: EmployeeListItem;
      delivery?: string;
      manualLink?: string;
    }
  | { ok: false; code: ErrorCode };

/** PRD PORT-EDT-001~006。 */
export async function updateEmployee(input: {
  employeeId: string;
  rawEmail?: string;
  role?: string;
  accountStatus?: string;
  actorEmployeeId: string;
  locale: string;
  appUrl: string;
  ipAddress: string | null;
}): Promise<UpdateEmployeeOutcome> {
  const existing = await employeeRepository.findById(input.employeeId);
  if (!existing) return { ok: false, code: 'INVALID_INPUT' };

  const patch: {
    loginEmail?: string;
    role?: EmployeeRole;
    accountStatus?: AccountStatus;
  } = {};

  if (input.role !== undefined) {
    if (!isEmployeeRole(input.role))
      return { ok: false, code: 'INVALID_INPUT' };
    patch.role = input.role;
  }
  if (input.accountStatus !== undefined) {
    if (!isAccountStatus(input.accountStatus))
      return { ok: false, code: 'INVALID_INPUT' };
    patch.accountStatus = input.accountStatus;
  }

  const emailChanged =
    input.rawEmail !== undefined &&
    normaliseEmail(input.rawEmail) !== existing.loginEmail;

  if (emailChanged) {
    // PRD BR-PORT-008：已验证邮箱不可修改，即使账号已停用
    if (existing.emailVerification === 'VERIFIED') {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    const nextEmail = normaliseEmail(input.rawEmail ?? '');
    if (!isValidEmail(nextEmail)) return { ok: false, code: 'INVALID_INPUT' };
    patch.loginEmail = nextEmail;
  }

  // PRD PORT-EDT-006：受保护管理员的角色与状态不可变更
  if (existing.isBootstrapAdmin) {
    if (patch.role !== undefined && patch.role !== 'ADMIN') {
      return { ok: false, code: 'PROTECTED_ADMIN_ACCOUNT' };
    }
    if (patch.accountStatus !== undefined && patch.accountStatus !== 'ACTIVE') {
      return { ok: false, code: 'PROTECTED_ADMIN_ACCOUNT' };
    }
  }

  // BUG-0329（补充）：不允许改自己的角色或停用自己（改邮箱/密码不受影响）。
  if (
    editsOwnAuthority({
      actorEmployeeId: input.actorEmployeeId,
      targetEmployeeId: existing.employeeId,
      currentRole: existing.role,
      currentStatus: existing.accountStatus,
      nextRole: patch.role,
      nextStatus: patch.accountStatus,
    })
  ) {
    return { ok: false, code: 'SELF_ACCOUNT_EDIT' };
  }

  // BUG-0329：最后一个可登录 Admin 的保护在仓储层的事务里完成
  // （advisory lock + FOR UPDATE + ACTIVE/VERIFIED 计数），这里只翻译结果。
  let outcome: employeeRepository.UpdateEmployeeOutcome;
  try {
    outcome = await employeeRepository.updateEmployee(existing.employeeId, patch);
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, code: 'DUPLICATE_EMAIL' };
    throw error;
  }
  if (outcome.kind === 'not_found') return { ok: false, code: 'INVALID_INPUT' };
  if (outcome.kind === 'last_admin') return { ok: false, code: 'LAST_ADMIN' };
  const updated = outcome.record;

  if (existing.role !== updated.role) {
    await tryRecordAuditEvent({
      eventName: 'employee_role_changed',
      actorEmployeeId: input.actorEmployeeId,
      targetEmployeeId: updated.employeeId,
      action: 'UPDATE_EMPLOYEE',
      oldValue: existing.role,
      newValue: updated.role,
      result: 'SUCCESS',
      ipAddress: input.ipAddress,
    });
  }

  if (existing.accountStatus !== updated.accountStatus) {
    // PRD BR-PORT-013：停用立即吊销会话
    const revoked =
      updated.accountStatus === 'INACTIVE'
        ? await sessionRepository.revokeAllForEmployee(updated.employeeId)
        : 0;
    await tryRecordAuditEvent({
      eventName: 'employee_status_changed',
      actorEmployeeId: input.actorEmployeeId,
      targetEmployeeId: updated.employeeId,
      action: 'UPDATE_EMPLOYEE',
      oldValue: existing.accountStatus,
      newValue: `${updated.accountStatus}:revoked=${revoked}`,
      result: 'SUCCESS',
      ipAddress: input.ipAddress,
    });
  }

  let delivery: EmailDeliveryResult | undefined;

  if (emailChanged && patch.loginEmail) {
    // PRD PORT-ACT-005 / BR-PORT-009：旧链接作废，向新地址重发激活邮件
    await revokeTokensForEmployee(updated.employeeId);
    const rawToken = await issueActivationToken(updated.employeeId);
    const link = activationLink(input.appUrl, input.locale, rawToken);
    delivery = await sendActivationEmailTo({
      to: patch.loginEmail,
      link,
      locale: input.locale,
    });

    await tryRecordAuditEvent({
      eventName: 'employee_email_changed',
      actorEmployeeId: input.actorEmployeeId,
      targetEmployeeId: updated.employeeId,
      action: 'UPDATE_EMPLOYEE',
      oldValue: existing.loginEmail,
      newValue: patch.loginEmail,
      result: delivery === 'SENT' ? 'SUCCESS' : 'FAILURE',
      ipAddress: input.ipAddress,
    });

    return {
      ok: true,
      employee: toListItem(updated),
      delivery,
      manualLink: manualLinkFor(link),
    };
  }

  return { ok: true, employee: toListItem(updated) };
}

export type AdminActionOutcome =
  | { ok: true; delivery: string; manualLink: string }
  | { ok: false; code: ErrorCode };

/** PRD PORT-ADM-002：直接发送，并把真实投递结果返回给调用方。 */
export async function sendAdminPasswordReset(input: {
  employeeId: string;
  actorEmployeeId: string;
  locale: string;
  appUrl: string;
  ipAddress: string | null;
}): Promise<AdminActionOutcome> {
  const employee = await employeeRepository.findById(input.employeeId);
  if (!employee) return { ok: false, code: 'INVALID_INPUT' };

  // 还没激活的账号不走重置：改为重发激活邮件，激活仍是唯一的验证途径
  if (employee.emailVerification !== 'VERIFIED') {
    return reissueActivation({
      employeeId: employee.employeeId,
      actorEmployeeId: input.actorEmployeeId,
      locale: input.locale,
      appUrl: input.appUrl,
      ipAddress: input.ipAddress,
    });
  }

  const rawToken = await issueResetToken(employee.employeeId);
  const link = resetLink(input.appUrl, input.locale, rawToken);
  const delivery = await sendPasswordResetEmail({
    to: employee.loginEmail,
    link,
    locale: input.locale,
  });

  await tryRecordAuditEvent({
    eventName: 'password_reset_sent',
    actorEmployeeId: input.actorEmployeeId,
    targetEmployeeId: employee.employeeId,
    action: 'ADMIN_RESET_PASSWORD',
    newValue: delivery,
    result: delivery === 'SENT' ? 'SUCCESS' : 'FAILURE',
    ipAddress: input.ipAddress,
  });

  return { ok: true, delivery, manualLink: manualLinkFor(link) };
}
