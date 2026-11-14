/**
 * 课程包 v2 —— 过渡适配层（不是契约 SSOT）。
 *
 * 唯一契约 SSOT 是 `src/partc/contracts/package-manifest.ts`
 * （PackageManifestV2Schema / PackageProvenanceSchema / PackageAnnotationsSchema）。
 *
 * 现状（2026-11-12 FIX2-ADMIN）：
 * - 导出（exporter/package-worker）只产出 Part C v2 包，已通过该 SSOT 校验；
 * - 导入分派：Part C v2 包走 `partc-import` 编译器管线；**本文件的 legacy
 *   聚合形状只服务历史 staged/旧数据包的兼容读取**，不是第二种 v2 契约的
 *   写出路径，导入侧也不接受它冒用 v2；
 * - **raw 素材导入（xlsx/docx zip → 课程）已退役**：`excel-package` 的原始
 *   素材转换不再声明 `formatVersion: 2`，改为显式 legacy 标记
 *   （LEGACY_PACKAGE_FORMAT_VERSION），v2 导入侧一律 PACKAGE_FORMAT_UNSUPPORTED。
 *   新内容必须由 Part C v2 模板生成课程包；raw 路径仅保留转换函数供历史
 *   数据排查，不产出可导入包；
 * - 待清理阶段把历史 staged 包迁完後，本文件与 legacy 聚合类型整体删除
 *   （评审阻断 2；Part A 分类差异已收敛为 categoryPath）。
 */
import type { PackageManifestV2 } from '../../partc/contracts/package-manifest';

export type PackageLanguage = 'en-GB' | 'zh-CN' | (string & {});

/**
 * 原始素材转换产物的显式 legacy 版本标记（不是 formatVersion 2）。
 *
 * raw 素材导入已退役：转换结果带此标记，且不带任何 checksums/摘要清单；
 * 导入侧（manifest.validate / Part C 契约）见到它即整体拒绝。历史 staged
 * 包仍可能是 formatVersion 2 的 legacy 聚合形状（兼容读取，不开新写出路径）。
 */
export const LEGACY_PACKAGE_FORMAT_VERSION = 1 as const;

/** 原始素材转换（历史工作流，已退役）的 legacy 来源标识。 */
export const RETIRED_RAW_SOURCE_ENVIRONMENTS = [
  'EXCEL_TEMPLATE',
  'EXCEL_IMPORT',
] as const;

export type ExhibitType = 'IMAGE' | 'VIDEO' | 'MODEL3D';
export type ReadingType = 'BOOK' | 'ARTICLE' | 'PAPER' | 'OTHER';
export type LearningMode = 'VIDEO_ONLY' | 'TEXT_ONLY' | 'VIDEO_AND_TEXT';
export type TrialRowStatus = 'READY' | 'RE_CONFIRM' | 'LOCKED';

export interface PackageVideoLearningPoint {
  code: string;
  /**
   * 机器时间源派生的秒值；`null` = 本环境没有可用时间源（不得写 0 伪造）。
   * 导出端遇到 null 不得生成章节 cue；导入端按 C7 重新派生。
   */
  timeSeconds: number | null;
  title: string;
}

export interface PackageTextLearningPoint {
  code: string;
  heading: string;
  level?: number;
}

export interface PackageExhibitTrigger {
  timeSeconds: number;
  exhibitRef: string;
}

export interface PackageVideo {
  file: string;
  durationSeconds?: number;
  learningPoints: PackageVideoLearningPoint[];
  exhibitTriggers?: PackageExhibitTrigger[];
}

export interface PackageText {
  html: string;
  learningPoints: PackageTextLearningPoint[];
}

export interface PackageLessonLocalization {
  title: string;
  description?: string;
  video?: PackageVideo | null;
  text?: PackageText | null;
}

export interface PackageExhibit {
  code: string;
  type: ExhibitType;
  file?: string;
  thumbnail?: string;
  source?: string;
  localized: Record<string, { title: string; description?: string }>;
}

export interface PackageReading {
  type: ReadingType;
  title: string;
  author?: string;
  why?: string;
}

export interface PackageKnowledgeQuestion {
  code: string;
  question: string;
  referenceAnswer?: string;
}

export interface PackageLesson {
  code: string;
  order: number;
  localized: Record<string, PackageLessonLocalization>;
  exhibits?: PackageExhibit[];
  recommendedReading?: Record<string, PackageReading[]>;
  knowledgeTest?: { enabled: boolean; questions: PackageKnowledgeQuestion[] };
  applicationTest?: {
    enabled: boolean;
    scenario: string;
    referenceAnswer?: string;
  };
}

export interface PackageCourseLocalization {
  title: string;
  shortDescription?: string;
  overview?: string;
  whatYouLearn?: string[];
  provides?: unknown[];
}

export interface PackageTrial {
  enabled: boolean;
  lessons: {
    lessonRef: string;
    videoCutoffSeconds?: number | null;
    textCutoffLearningPoint?: string | null;
    status?: TrialRowStatus;
  }[];
}

export interface PackagePlan {
  name: string;
  termMonths: number;
  amountMinor: number;
  currency: string;
  lookupKey: string;
}

/** 分类稳定键路径：与 Part C v2 契约同型（唯一 SSOT，不另立形状）。 */
export type PackageCategoryPath = PackageManifestV2['course']['categoryPath'];

export interface PackageCourse {
  code: string;
  slug: string;
  /**
   * 分类稳定键路径（设计 C5/I8）：null = 未分类；不再有 `category` 字符串。
   * 导出时取课程行的分类 name 序列；导入时逐级在 ACTIVE 节点中匹配。
   */
  categoryPath: PackageCategoryPath;
  learningMode: LearningMode;
  learningLanguages: PackageLanguage[];
  defaultContentLanguage: PackageLanguage;
  cover?: string;
  localized: Record<string, PackageCourseLocalization>;
  lessons: PackageLesson[];
  trial?: PackageTrial;
  /** 价格随包带入；导入后在目标环境 Stripe 重新创建（PRD §16）。 */
  pricing?: PackagePlan[];
}

/**
 * legacy 聚合包信封（历史兼容读取；不是 v2 契约）。
 *
 * - `formatVersion` 用 number：历史 staged 包可能是 2，原始素材转换产物是
 *   LEGACY_PACKAGE_FORMAT_VERSION（1，显式退役标记）；
 * - 新代码一律使用 Part C 的 `PackageManifestV2`（SSOT），本类型只由兼容
 *   读取路径消费。
 */
export interface LegacyPackageManifest {
  format: string;
  formatVersion: number;
  packageId: string;
  exportedAt: string;
  source: { environment?: string; courseCode?: string; sourceVersion?: string };
  incomplete: boolean;
  course: PackageCourse;
}

/** 过渡别名；新代码一律使用 Part C 的 `PackageManifestV2`。 */
export type PackageManifest = LegacyPackageManifest;

/** 格式标识与版本只有一个来源（Part C version-matrix），此处只做再导出。 */
export {
  PACKAGE_FORMAT_TAG as PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
} from '../../partc/version-matrix';

export interface PackageValidationIssue {
  level: 'error' | 'warning';
  code: string;
  path?: string;
  message: string;
}

export interface PackageValidationReport {
  errors: PackageValidationIssue[];
  warnings: PackageValidationIssue[];
  incomplete: boolean;
  /**
   * 结构性摘要（Part C 适配层：contract/courseKey/lessonCount/mediaCount）。
   * 只用于 job 视图展示；不是契约的一部分，不参与任何身份判定。
   */
  details?: Record<string, unknown>;
}
