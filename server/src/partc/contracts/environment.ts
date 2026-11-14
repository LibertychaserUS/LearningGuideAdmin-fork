import { z } from 'zod';
import { PartCError } from '../errors';

/**
 * 环境模型（设计 §14 C10.3/C10.6/C10.7）。
 *
 * - sourceEnv 标识内容产物的来源环境（sandbox/production）。版本标签环境局部：
 *   Sandbox 的 `X.Y` 与 Production 的本地 `Version N` 互不通用；
 *   sourceLabel 记录来源标签（PRD 的 Source 字段）。
 * - capability 是路由层统一判定的显式能力词表（C10.7），替代旧「课程菜单
 *   VIEW/EDIT」模型。Production 禁用 authoring（403 CAPABILITY_DISABLED），
 *   import / publish / status 可用；Sandbox 全部可用。分类修改归
 *   course.authoring 且仅 Sandbox。
 * - 来源与能力判定只看服务端解析出的字段，绝不依据文件名/路径/声明位置
 *   （C10.6 / C10.7：服务端强制，不靠 UI 隐藏）。
 *
 * 本模块只冻结词表与判定函数；HTTP 薄壳与 RBAC 接线由后续阶段实现。
 */

export const SOURCE_ENVIRONMENTS = ['sandbox', 'production'] as const;

export const SourceEnvSchema = z.enum(SOURCE_ENVIRONMENTS);

export type SourceEnv = z.infer<typeof SourceEnvSchema>;

/** Sandbox 版本标签形如 `4.2`（C10.6 provenance.sourceVersionLabel）。 */
export const SOURCE_VERSION_LABEL_PATTERN = /^\d+\.\d+$/;

export const COURSE_CAPABILITIES = [
  'course.authoring',
  'course.import',
  'course.publish',
  'course.status',
] as const;

export const CourseCapabilitySchema = z.enum(COURSE_CAPABILITIES);

export type CourseCapability = z.infer<typeof CourseCapabilitySchema>;

/**
 * 环境 × 能力矩阵（C10.7）。
 *
 * Production 的「不允许维护」精确指内容编辑/新建/结构变更（authoring），
 * 不包含 import / publish / change status。
 */
export const CAPABILITY_ENVIRONMENTS = {
  'course.authoring': ['sandbox'],
  'course.import': ['sandbox', 'production'],
  'course.publish': ['sandbox', 'production'],
  'course.status': ['sandbox', 'production'],
} as const satisfies Record<CourseCapability, readonly SourceEnv[]>;

export function isCapabilityEnabled(
  environment: SourceEnv,
  capability: CourseCapability,
): boolean {
  const allowed: readonly SourceEnv[] = CAPABILITY_ENVIRONMENTS[capability];
  return allowed.includes(environment);
}

/**
 * ENV_CAPABILITY_ENFORCEMENT 的休眠开关（默认 off）。
 *
 * C10.7 要求服务端按环境强制能力矩阵；owner 决策该强制默认休眠，避免部署后
 * 把 UAT（即生产）的 authoring 锁死。off 时路由层行为与现状完全一致。
 */
export function capabilityEnforcementFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env.ENV_CAPABILITY_ENFORCEMENT?.trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1';
}

/**
 * 课程路由 → 能力（C10.7）。路径是 `/api/backoffice/courses` 之后的段。
 * - import（上传/确认/取消/原始素材/分块，含 `:id/import` 与
 *   `:id/readings/import`、`:id/understanding/import`）→ course.import；
 *   必须在 export 判定之后：export 是只读产物生成，不归任何写能力。
 * - publish / restore → course.publish（Production 允许发布与恢复）；
 * - live-status → course.status；
 * - Part C 计划工作流（`plans/preview|save|approve|apply|publish`）→
 *   course.publish：C10.7 明确 Production 允许 plan preview/approve/publish，
 *   而能力词表只有这四项，计划工件不是内容维护，故归 publish 而非 authoring；
 * - 对齐人签收（`alignments/:id/sign-off`）→ course.publish：它是发布门的
 *   人签（C0 红线⑭），且 Production 的唯一内容写路径是导入包 —— 导入后
 *   proposed 对齐必须能在 Production 签收后才能发布，否则 C10.7/C10.8 互斥；
 * - 其余内容写（新建课程、改元数据/分类、课时/展品/学习点/测评/媒体、delete-draft、
 *   Part C 阶段树与证据规格编辑）→ course.authoring（Production 禁用）；
 * - 读请求 → null（由既有 RBAC 处理）。
 *
 * operations 路由（`/backoffice/operations/**`）不在此函数内：它们挂在独立的
 * OperationsController，不经 CourseCapabilityGuard；C10.7 将 operations 列为
 * Production 可用，若把它映射成课程能力反而会误伤（见 e2e 断言）。
 */
export function courseCapabilityForRequest(
  method: string,
  segments: readonly string[],
): CourseCapability | null {
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return null;
  const [first] = segments;
  if (first === 'import') return 'course.import';
  // 导出是只读产物的生成（不改变内容），不归 authoring。
  if (first === 'export' || segments.includes('export')) return null;
  // 评审阻断 7：`POST /courses/:id/import` 的子路径曾落到 authoring，
  // 能力强制开启后 Production 无法导入（与 C10.7/C10.8 冲突）。
  if (segments.includes('import')) return 'course.import';
  if (segments.includes('publish') || segments.includes('restore')) {
    return 'course.publish';
  }
  if (segments.includes('live-status')) return 'course.status';
  // Part C 计划工件（preview/save/approve/apply/publish）不是内容维护。
  if (segments.includes('plans')) return 'course.publish';
  // 对齐人签收是发布门的一部分（C0 红线⑭）：Production 导入后必须能签收，
  // 否则 proposed 对齐永远进不了 Plan（C10.7 Production 允许 publish）。
  if (segments.includes('alignments') && segments.includes('sign-off')) {
    return 'course.publish';
  }
  // 其它写路径一律归 authoring（含 create course、PUT /:id 分类修改、结构/内容编辑）。
  return 'course.authoring';
}

/**
 * 服务端能力门：禁用环境返回 403 CAPABILITY_DISABLED（C10.7）。
 * 调用方必须传服务端判定的环境，不得信任客户端声明。
 */
export function assertCapabilityEnabled(
  environment: SourceEnv,
  capability: CourseCapability,
): void {
  if (!isCapabilityEnabled(environment, capability)) {
    throw new PartCError(
      'CAPABILITY_DISABLED',
      `${capability} is disabled in ${environment}`,
      { environment, capability },
    );
  }
}
