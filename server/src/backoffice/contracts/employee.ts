/** PRD §3.1 六个固定角色；顺序即筛选器与导航的展示顺序。 */
export const EMPLOYEE_ROLES = [
  'ADMIN',
  'COURSE_CREATOR',
  'GRAPHIC_DESIGNER',
  'FINANCE',
  'OPERATION_ADMIN',
  'OPERATION_AI',
] as const;

export type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

export const ACCOUNT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export type EmailVerification = 'PENDING_VERIFICATION' | 'VERIFIED';
export type DisplayStatus = 'Active' | 'Pending' | 'Inactive';

export const DISPLAY_STATUSES = ['Active', 'Pending', 'Inactive'] as const;

export function isEmployeeRole(value: unknown): value is EmployeeRole {
  return (
    typeof value === 'string' &&
    (EMPLOYEE_ROLES as readonly string[]).includes(value)
  );
}

export function isAccountStatus(value: unknown): value is AccountStatus {
  return value === 'ACTIVE' || value === 'INACTIVE';
}

export function isDisplayStatus(value: unknown): value is DisplayStatus {
  return (
    typeof value === 'string' &&
    (DISPLAY_STATUSES as readonly string[]).includes(value)
  );
}

/** PRD BR-PORT-004：Inactive 优先，其次未验证为 Pending。 */
export function deriveDisplayStatus(
  accountStatus: AccountStatus,
  emailVerification: EmailVerification,
): DisplayStatus {
  if (accountStatus === 'INACTIVE') return 'Inactive';
  return emailVerification === 'VERIFIED' ? 'Active' : 'Pending';
}

/** PRD BR-PORT-002：去空格 + 小写，保证大小写不敏感比较。 */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// 本地部分不以点开头/结尾、不含连续点；域名每段字母数字（可含中间连字符），顶级域至少两位字母
const EMAIL_PATTERN =
  /^(?!\.)(?!.*\.\.)[^\s@]+(?<!\.)@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function isValidEmail(raw: string): boolean {
  const value = normaliseEmail(raw);
  return value.length > 0 && value.length <= 254 && EMAIL_PATTERN.test(value);
}

/** PRD BR-PORT-018：显示名取邮箱 @ 之前的部分。 */
export function displayNameFromEmail(email: string): string {
  const normalised = normaliseEmail(email);
  const at = normalised.indexOf('@');
  return at > 0 ? normalised.slice(0, at) : normalised;
}

/** PRD BR-PORT-005：Active + Verified 才允许登录。 */
export function isSignInEligible(
  accountStatus: AccountStatus,
  emailVerification: EmailVerification,
): boolean {
  return accountStatus === 'ACTIVE' && emailVerification === 'VERIFIED';
}

/**
 * BUG-0329：员工账号是唯一能分配角色的入口，把最后一个**可登录**的 Admin 降级或停用
 * 会让团队永久失去账号管理能力（非 Admin 连入口都看不到）。已有的
 * PROTECTED_ADMIN_ACCOUNT 只保护 bootstrap 账号，保护不到这里。
 *
 * 「可登录」= ADMIN + ACTIVE + 邮箱已验证：邀请创建的管理员是 PENDING_VERIFICATION，
 * 既不写密码也登不进来，不能算作「还有一个管理员」。
 * `otherActiveAdmins` 由调用方在事务内、以 FOR UPDATE 锁定目标行之后统计。
 */
export function leavesNoActiveAdmin(input: {
  currentRole: EmployeeRole;
  currentStatus: AccountStatus;
  emailVerified: boolean;
  nextRole?: EmployeeRole;
  nextStatus?: AccountStatus;
  otherActiveAdmins: number;
}): boolean {
  const usableNow =
    input.currentRole === 'ADMIN' &&
    input.currentStatus === 'ACTIVE' &&
    input.emailVerified;
  const staysUsable =
    (input.nextRole ?? input.currentRole) === 'ADMIN' &&
    (input.nextStatus ?? input.currentStatus) === 'ACTIVE' &&
    input.emailVerified;
  return usableNow && !staysUsable && input.otherActiveAdmins === 0;
}

/**
 * BUG-0329（补充）：不允许管理员改动自己的权限或停用自己。
 *
 * 「最后一个管理员」规则在有种子管理员的库上不可达（种子账号受触发器保护且始终可用），
 * 真正每天都在发生的误操作是"把自己降级 / 停用自己"——这一条与库状态无关，任何环境都能拦住。
 * 改自己的邮箱、密码不受影响。
 */
export function editsOwnAuthority(input: {
  actorEmployeeId: string;
  targetEmployeeId: string;
  currentRole: EmployeeRole;
  currentStatus: AccountStatus;
  nextRole?: EmployeeRole;
  nextStatus?: AccountStatus;
}): boolean {
  if (input.actorEmployeeId !== input.targetEmployeeId) return false;
  const changesRole =
    input.nextRole !== undefined && input.nextRole !== input.currentRole;
  const deactivates =
    input.nextStatus === 'INACTIVE' && input.currentStatus !== 'INACTIVE';
  return changesRole || deactivates;
}

export type SessionEmployee = {
  employeeId: string;
  loginEmail: string;
  role: EmployeeRole;
  displayName: string;
  accountStatus: AccountStatus;
  emailVerification: EmailVerification;
  displayStatus: DisplayStatus;
  isBootstrapAdmin: boolean;
};
