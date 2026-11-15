import { leavesNoActiveAdmin } from '../contracts/employee';
import type {
  AccountStatus,
  DisplayStatus,
  EmailVerification,
  EmployeeRole,
} from '../contracts/employee';
import { query, withTransaction } from '../lib/db';

export type EmployeeRecord = {
  employeeId: string;
  loginEmail: string;
  role: EmployeeRole;
  accountStatus: AccountStatus;
  emailVerification: EmailVerification;
  emailVerifiedAt: Date | null;
  passwordHash: string | null;
  lastLoginAt: Date | null;
  isBootstrapAdmin: boolean;
  createdAt: Date;
};

type EmployeeRow = {
  employee_id: string;
  login_email: string;
  role: EmployeeRole;
  account_status: AccountStatus;
  email_verification: EmailVerification;
  email_verified_at: Date | null;
  password_hash: string | null;
  last_login_at: Date | null;
  is_bootstrap_admin: boolean;
  created_at: Date;
};

const COLUMNS = `employee_id, login_email, role, account_status, email_verification,
                 email_verified_at, password_hash, last_login_at, is_bootstrap_admin, created_at`;

function toRecord(row: EmployeeRow): EmployeeRecord {
  return {
    employeeId: row.employee_id,
    loginEmail: row.login_email,
    role: row.role,
    accountStatus: row.account_status,
    emailVerification: row.email_verification,
    emailVerifiedAt: row.email_verified_at,
    passwordHash: row.password_hash,
    lastLoginAt: row.last_login_at,
    isBootstrapAdmin: row.is_bootstrap_admin,
    createdAt: row.created_at,
  };
}

export async function findByLoginEmail(
  email: string,
): Promise<EmployeeRecord | null> {
  const rows = await query<EmployeeRow>(
    `SELECT ${COLUMNS} FROM employees WHERE login_email = $1`,
    [email],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function findById(
  employeeId: string,
): Promise<EmployeeRecord | null> {
  const rows = await query<EmployeeRow>(
    `SELECT ${COLUMNS} FROM employees WHERE employee_id = $1`,
    [employeeId],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** PRD PORT-LOG-004：仅认证成功才更新 last_login_at。 */
export async function touchLastLogin(employeeId: string): Promise<void> {
  await query(
    `UPDATE employees SET last_login_at = now(), updated_at = now() WHERE employee_id = $1`,
    [employeeId],
  );
}

export async function createEmployee(input: {
  loginEmail: string;
  role: EmployeeRole;
  accountStatus: AccountStatus;
  passwordHash?: string | null;
  emailVerification?: EmailVerification;
  emailVerifiedAt?: Date | null;
  isBootstrapAdmin?: boolean;
}): Promise<EmployeeRecord> {
  const rows = await query<EmployeeRow>(
    `INSERT INTO employees
       (login_email, role, account_status, email_verification, email_verified_at,
        password_hash, is_bootstrap_admin)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${COLUMNS}`,
    [
      input.loginEmail,
      input.role,
      input.accountStatus,
      input.emailVerification ?? 'PENDING_VERIFICATION',
      input.emailVerifiedAt ?? null,
      input.passwordHash ?? null,
      input.isBootstrapAdmin ?? false,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('Failed to create employee');
  return toRecord(row);
}

export type UpdateEmployeeOutcome =
  | { kind: 'updated'; record: EmployeeRecord }
  | { kind: 'not_found' }
  | { kind: 'last_admin' };

/**
 * BUG-0329：更新员工账号，并在同一个事务里守住「至少剩一个可登录的管理员」。
 *
 * - 事务 + advisory lock + FOR UPDATE：两个 Admin 并发互降时不会各自读到旧计数
 *   （`bootstrap.ts` 的 createFirstAdmin 是同一把锁的同类写法）。
 * - 「可用」= ADMIN + ACTIVE + VERIFIED：未激活的邀请账号登不进来，不能算数。
 *
 * 可用性说明：种子迁移总会建一个 ACTIVE+VERIFIED 的受保护管理员
 * （`20261023170000_backoffice_default_admin`），且触发器禁止停用/降级/删除它。
 * 因此只要库里有种管理员，这条分支就不会触发——它是为「库里没有种管理员」
 * （恢复的备份、被裁剪的环境）准备的兜底，不是日常路径。
 */
export async function updateEmployee(
  employeeId: string,
  patch: {
    loginEmail?: string;
    role?: EmployeeRole;
    accountStatus?: AccountStatus;
  },
): Promise<UpdateEmployeeOutcome> {
  return withTransaction(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('backoffice_employee_admin_guard'))`,
    );
    const found = await client.query<EmployeeRow>(
      `SELECT ${COLUMNS} FROM employees WHERE employee_id = $1 FOR UPDATE`,
      [employeeId],
    );
    const current = found.rows[0];
    if (!current) return { kind: 'not_found' as const };

    const nextRole = patch.role ?? current.role;
    const nextStatus = patch.accountStatus ?? current.account_status;
    const nextVerified = current.email_verification === 'VERIFIED';
    const usableNow =
      current.role === 'ADMIN' &&
      current.account_status === 'ACTIVE' &&
      current.email_verification === 'VERIFIED';
    const staysUsable =
      nextRole === 'ADMIN' && nextStatus === 'ACTIVE' && nextVerified;

    if (usableNow && !staysUsable) {
      const others = await client.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM employees
          WHERE role = 'ADMIN' AND account_status = 'ACTIVE'
            AND email_verification = 'VERIFIED' AND employee_id <> $1`,
        [employeeId],
      );
      if (
        leavesNoActiveAdmin({
          currentRole: current.role,
          currentStatus: current.account_status,
          emailVerified: true,
          nextRole,
          nextStatus,
          otherActiveAdmins: Number(others.rows[0]?.total ?? '0'),
        })
      ) {
        return { kind: 'last_admin' as const };
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.loginEmail !== undefined) {
      params.push(patch.loginEmail);
      sets.push(`login_email = $${params.length}`);
    }
    if (patch.role !== undefined) {
      params.push(patch.role);
      sets.push(`role = $${params.length}`);
    }
    if (patch.accountStatus !== undefined) {
      params.push(patch.accountStatus);
      sets.push(`account_status = $${params.length}`);
    }

    sets.push('updated_at = now()');
    params.push(employeeId);

    const updated = await client.query<EmployeeRow>(
      `UPDATE employees SET ${sets.join(', ')} WHERE employee_id = $${params.length}
       RETURNING ${COLUMNS}`,
      params,
    );
    const row = updated.rows[0];
    if (!row) return { kind: 'not_found' as const };
    return { kind: 'updated' as const, record: toRecord(row) };
  });
}

/** 设置密码同时完成邮箱验证（PRD PORT-ACT-002 / PORT-PWD-004）。 */
export async function setPasswordAndVerify(
  employeeId: string,
  passwordHash: string,
): Promise<void> {
  await query(
    `UPDATE employees
        SET password_hash = $2,
            email_verification = 'VERIFIED',
            email_verified_at = COALESCE(email_verified_at, now()),
            updated_at = now()
      WHERE employee_id = $1`,
    [employeeId, passwordHash],
  );
}

export type EmployeeFilter = {
  email?: string;
  role?: EmployeeRole;
  status?: DisplayStatus;
  limit: number;
  offset: number;
};

function filterClause(filter: EmployeeFilter): {
  where: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.email) {
    // 用户输入里的 % _ \ 按字面匹配（PostgreSQL LIKE 默认转义符是 \）
    const literal = filter.email.toLowerCase().replace(/[\\%_]/g, '\\$&');
    params.push(`%${literal}%`);
    conditions.push(`login_email LIKE $${params.length}`);
  }
  if (filter.role) {
    params.push(filter.role);
    conditions.push(`role = $${params.length}`);
  }
  // PRD BR-PORT-004 的派生状态在 SQL 层等价展开，避免全表拉取后再过滤
  if (filter.status === 'Inactive') {
    conditions.push(`account_status = 'INACTIVE'`);
  } else if (filter.status === 'Pending') {
    conditions.push(
      `account_status = 'ACTIVE' AND email_verification = 'PENDING_VERIFICATION'`,
    );
  } else if (filter.status === 'Active') {
    conditions.push(
      `account_status = 'ACTIVE' AND email_verification = 'VERIFIED'`,
    );
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

export async function listEmployees(
  filter: EmployeeFilter,
): Promise<{ rows: EmployeeRecord[]; total: number }> {
  const { where, params } = filterClause(filter);

  const countRows = await query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM employees ${where}`,
    params,
  );
  const total = Number(countRows[0]?.total ?? '0');

  const pageParams = [...params, filter.limit, filter.offset];
  const rows = await query<EmployeeRow>(
    `SELECT ${COLUMNS} FROM employees ${where}
      ORDER BY created_at DESC, login_email ASC
      LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );

  return { rows: rows.map(toRecord), total };
}
