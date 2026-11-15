import type { EmployeeRole } from "../contracts/employee";

/** PRD §1.4：View 只读；Edit = View + 修改既有记录；Full = 模块内全部授权操作。 */
export type PermissionLevel = "NONE" | "VIEW" | "EDIT" | "FULL";

/** PRD PORT-NAV-002：侧边栏顺序固定，不得在页面里重新排序。 */
export const MENU_ORDER = [
  "course",
  "knowledge",
  "aiTutor",
  "order",
  "reporting",
  "student",
  "helpDesk",
  "settings",
] as const;

export type MenuKey = (typeof MENU_ORDER)[number];

/**
 * PRD §3.2 角色权限矩阵 —— 单一事实来源。
 * 页面、路由守卫与 API 授权都读这张表，禁止各自硬编码。
 */
export const ROLE_MATRIX: Record<EmployeeRole, Record<MenuKey, PermissionLevel>> = {
  ADMIN: {
    course: "FULL",
    knowledge: "FULL",
    aiTutor: "FULL",
    order: "FULL",
    reporting: "FULL",
    student: "FULL",
    helpDesk: "FULL",
    settings: "FULL",
  },
  COURSE_CREATOR: {
    course: "VIEW",
    knowledge: "VIEW",
    aiTutor: "VIEW",
    order: "VIEW",
    reporting: "VIEW",
    student: "VIEW",
    helpDesk: "VIEW",
    settings: "VIEW",
  },
  GRAPHIC_DESIGNER: {
    course: "EDIT",
    // REQ-0236 / PRD §3.2：Course=Edit（可改已有课程内容，不能新增、删除、发布），
    // 其他菜单全部 View。Course 模块已上线，编辑能力不再借道 Knowledge。
    knowledge: "VIEW",
    aiTutor: "VIEW",
    order: "VIEW",
    reporting: "VIEW",
    student: "VIEW",
    helpDesk: "VIEW",
    settings: "VIEW",
  },
  FINANCE: {
    course: "VIEW",
    knowledge: "VIEW",
    aiTutor: "VIEW",
    order: "FULL",
    reporting: "FULL",
    student: "VIEW",
    helpDesk: "VIEW",
    settings: "VIEW",
  },
  OPERATION_ADMIN: {
    course: "FULL",
    knowledge: "NONE",
    aiTutor: "NONE",
    order: "FULL",
    reporting: "FULL",
    student: "FULL",
    helpDesk: "FULL",
    settings: "FULL",
  },
  OPERATION_AI: {
    course: "VIEW",
    knowledge: "FULL",
    aiTutor: "FULL",
    order: "VIEW",
    reporting: "VIEW",
    student: "VIEW",
    helpDesk: "VIEW",
    settings: "VIEW",
  },
};

/** PRD §3.2 注释：Edit 只允许修改既有记录，不能创建、删除或发布。 */
export type ActionKind = "VIEW" | "EDIT_EXISTING" | "CREATE" | "DELETE" | "PUBLISH";

export function levelFor(role: EmployeeRole, menu: MenuKey): PermissionLevel {
  return ROLE_MATRIX[role][menu];
}

export function canViewMenu(role: EmployeeRole, menu: MenuKey): boolean {
  return levelFor(role, menu) !== "NONE";
}

export function isActionAllowed(
  role: EmployeeRole,
  menu: MenuKey,
  action: ActionKind
): boolean {
  const level = levelFor(role, menu);
  switch (action) {
    case "VIEW":
      return level !== "NONE";
    case "EDIT_EXISTING":
      return level === "EDIT" || level === "FULL";
    case "CREATE":
    case "DELETE":
    case "PUBLISH":
      return level === "FULL";
    default:
      return false;
  }
}

export function visibleMenus(role: EmployeeRole): MenuKey[] {
  return MENU_ORDER.filter((menu) => canViewMenu(role, menu));
}

/**
 * PRD §3.3：Employee Account Management 独立于 Settings 的 View/Edit/Full，
 * 只有 Admin 可访问，非 Admin 连子菜单都不可见。
 */
export function canAccessEmployeeAccount(role: EmployeeRole): boolean {
  return role === "ADMIN";
}

/** PRD BR-PORT-017：登录后默认落地 Course。 */
export const DEFAULT_LANDING_MENU: MenuKey = "course";

export const MENU_SEGMENT: Record<MenuKey, string> = {
  course: "course",
  knowledge: "knowledge",
  aiTutor: "ai-tutor",
  order: "order",
  reporting: "reporting",
  student: "student",
  helpDesk: "help-desk",
  settings: "settings",
};

export function menuHref(locale: string, menu: MenuKey): string {
  return `/${locale}/${MENU_SEGMENT[menu]}`;
}

export function employeeAccountHref(locale: string): string {
  return `/${locale}/${MENU_SEGMENT.settings}/employee-account`;
}

/**
 * PRD §2 范围说明 + §8.5：Settings 有子导航，其中 Employee Account 仅 Admin 可见；
 * Payment Gateway 与 Notification Configuration 在 P0 只是占位入口。
 */
export type SettingsSubKey = "employeeAccount" | "paymentGateway" | "notificationConfiguration" | "learningAccess";

export const SETTINGS_SUB_ORDER = [
  "employeeAccount",
  "paymentGateway",
  "notificationConfiguration",
  // Student Management PRD §7：紧跟 Notification Configuration；能看 Settings 的角色都能看（只读角色只读）
  "learningAccess",
] as const;

export const SETTINGS_SUB_SEGMENT: Record<SettingsSubKey, string> = {
  employeeAccount: "employee-account",
  paymentGateway: "payment-gateway",
  notificationConfiguration: "notification-configuration",
  learningAccess: "learning-access",
};

export function settingsSubHref(locale: string, sub: SettingsSubKey): string {
  return `/${locale}/${MENU_SEGMENT.settings}/${SETTINGS_SUB_SEGMENT[sub]}`;
}

/** 非 Admin 看不到 Employee Account 子项（PORT-§3.3 / §15.3）。 */
export function visibleSettingsSubs(role: EmployeeRole): SettingsSubKey[] {
  return SETTINGS_SUB_ORDER.filter(
    (sub) => sub !== "employeeAccount" || canAccessEmployeeAccount(role)
  );
}

/**
 * BUG-0329：员工账号页在分配角色时展示的「菜单 → 级别」清单。
 * 与 ROLE_MATRIX 同源，页面不另写一份权限表。
 */
export function roleAccessRows(
  role: EmployeeRole
): Array<{ menu: MenuKey; level: PermissionLevel }> {
  return MENU_ORDER.map((menu) => ({ menu, level: levelFor(role, menu) }));
}

export function menuFromPathSegments(segments: string[] | undefined): MenuKey | null {
  if (!segments || segments.length === 0) return null;
  const target = segments[0];
  // Operations 从 Course Overview 进入，侧边栏仍高亮 Course（PRD §6）
  if (target === "operations") return "course";
  const entry = (Object.entries(MENU_SEGMENT) as [MenuKey, string][]).find(
    ([, segment]) => segment === target
  );
  return entry ? entry[0] : null;
}
