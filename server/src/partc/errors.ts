/**
 * Part C 错误码表（设计 §14 C5）。
 *
 * 只收 §14 明确命名的错误码；码是契约的一部分（CI 有冻结断言），
 * 新增/改名必须带设计编号与迁移规则（B8 版本升级规则）。
 * httpStatus 供管理端/Portal 薄壳直接映射；retryable 描述同一输入重试是否有意义。
 */

export const PART_C_PIPELINE_PHASES = [
  'P0',
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
  'P6',
  'P7',
  'P8',
] as const;
export type PartCPipelinePhase = (typeof PART_C_PIPELINE_PHASES)[number];

export interface PartCErrorDefinition {
  /** 该码所属的首个管线阶段（C5）。 */
  readonly phase: PartCPipelinePhase;
  /** 管理端/Portal HTTP 响应状态。 */
  readonly httpStatus: number;
  /** 同一输入重试是否有意义（如预览过期可重编译后重试）。 */
  readonly retryable: boolean;
  /** 语义说明（界面与报告共用的一句话）。 */
  readonly description: string;
}

export const PART_C_ERROR_DEFINITIONS = {
  PACKAGE_FORMAT_UNSUPPORTED: {
    phase: 'P1',
    httpStatus: 422,
    retryable: false,
    description:
      '课程包格式不被支持（formatVersion 非 2、含旧 category 字段或缺少 categoryPath）；旧包整体拒绝，不做兼容解析。',
  },
  TEMPLATE_FORMAT_UNSUPPORTED: {
    phase: 'P1',
    httpStatus: 422,
    retryable: false,
    description:
      '模板格式不被支持（templateVersion 缺失或非 2）；整个 job 失败。',
  },
  PACKAGE_FILE_MISSING: {
    phase: 'P1',
    httpStatus: 422,
    retryable: false,
    description: 'manifest 声明了包内文件但实际缺失（闭合包一一对应）。',
  },
  PACKAGE_FILE_UNKNOWN: {
    phase: 'P1',
    httpStatus: 422,
    retryable: false,
    description: '包内存在 manifest 未声明的文件（闭合包，不按目录猜内容）。',
  },
  HUMAN_TIME_FORBIDDEN: {
    phase: 'P1',
    httpStatus: 422,
    retryable: false,
    description:
      '模板或包中出现任何人工时间输入（时间列/时间值）；时间只能由容器/字幕/章节/DOCX 结构机器派生。',
  },
  CATEGORY_NOT_FOUND: {
    phase: 'P1',
    httpStatus: 422,
    retryable: false,
    description:
      '分类路径无法在当前环境解析为 ACTIVE 分类；整包/恢复被拒绝且草稿不变，不创建分类。',
  },
  TIMING_SOURCE_MISSING: {
    phase: 'P3',
    httpStatus: 422,
    retryable: false,
    description:
      '缺少可派生的时间来源（字幕/章节轨/DOCX 结构）；不猜时间，整包失败或课时 incomplete。',
  },
  UNSUPPORTED_ORDERING: {
    phase: 'P5',
    httpStatus: 422,
    retryable: false,
    description: 'v1 不接受 choice 容器或多 target 等未支持的排序/选择语义。',
  },
  PLAN_PREVIEW_STALE: {
    phase: 'P6',
    httpStatus: 409,
    retryable: true,
    description:
      'save 携带的 (planId, planVersion) 与按当前 inputClosure 重算的 canonical bytes 不等；需重新预览。',
  },
  PLAN_NOT_APPROVED: {
    phase: 'P6',
    httpStatus: 409,
    retryable: false,
    description:
      'apply/publish 只认 DB 中最新决定为 approved 且绑定 (planId, planVersion) 的 plan；未批准/已拒绝不得写入。',
  },
  PLAN_INPUT_CHANGED: {
    phase: 'P6',
    httpStatus: 409,
    retryable: true,
    description:
      'apply/publish 时按当前 inputClosure 重算的 plan 与已批准的 canonical bytes 不等；冻结内容或 pins 已变化，需重新预览/签收。',
  },
  CONTENT_VERSION_NOT_FOUND: {
    phase: 'P7',
    httpStatus: 404,
    retryable: false,
    description:
      '事件/恢复引用了本环境不存在的 contentVersion（未知 stage/version）；不猜测、不回退默认版本。',
  },
  ASSET_NOT_FOUND: {
    phase: 'P8',
    httpStatus: 422,
    retryable: false,
    description:
      '恢复/往返时旧 pin 引用的资产不存在；草稿保持不变，不静默置空。',
  },
} as const satisfies Record<string, PartCErrorDefinition>;

export type PartCErrorCode = keyof typeof PART_C_ERROR_DEFINITIONS;

export function partCErrorDefinition(
  code: PartCErrorCode,
): PartCErrorDefinition {
  return PART_C_ERROR_DEFINITIONS[code];
}

/**
 * 环境模型错误码（设计 §14 C10.6 / C10.7）。
 *
 * 与 C5 管线错误码分表：C5 表由 `src/partc-contracts.spec.ts` 冻结（P0–P8
 * 管线码；评审补齐了 PLAN_NOT_APPROVED / PLAN_INPUT_CHANGED /
 * CONTENT_VERSION_NOT_FOUND 三个应用门错误）；C10 的两个服务端强制错误只出现在
 * 环境/能力门（生产导入来源强制、生产 authoring 能力禁用），不属于管线阶段。
 */
export const PART_C_ENVIRONMENT_ERROR_DEFINITIONS = {
  PACKAGE_SOURCE_NOT_ALLOWED: {
    httpStatus: 422,
    retryable: false,
    description:
      '生产环境导入只接受 provenance.sourceEnv === "sandbox" 的 v2 课程包；来源判定只看服务端解析出的字段，不看文件名/路径。',
  },
  CAPABILITY_DISABLED: {
    httpStatus: 403,
    retryable: false,
    description:
      '当前环境禁用了该课程能力（C10.7 能力矩阵）；服务端强制，不靠 UI 隐藏。',
  },
} as const satisfies Record<
  string,
  { httpStatus: number; retryable: boolean; description: string }
>;

export type PartCEnvironmentErrorCode =
  keyof typeof PART_C_ENVIRONMENT_ERROR_DEFINITIONS;

export function partCEnvironmentErrorHttpStatus(
  code: PartCEnvironmentErrorCode,
): number {
  return PART_C_ENVIRONMENT_ERROR_DEFINITIONS[code].httpStatus;
}

export function partCErrorHttpStatus(code: PartCErrorCode): number {
  return PART_C_ERROR_DEFINITIONS[code].httpStatus;
}

/**
 * Part C 管线错误：code 是契约；details 只放机器可读上下文
 * （例如源坐标 sheet/row/col、未解析路径），不放本地化散文。
 */
export class PartCError extends Error {
  readonly code: PartCErrorCode | PartCEnvironmentErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: PartCErrorCode | PartCEnvironmentErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PartCError';
    this.code = code;
    this.details = details;
  }
}

export function isPartCError(error: unknown): error is PartCError {
  return error instanceof PartCError;
}
