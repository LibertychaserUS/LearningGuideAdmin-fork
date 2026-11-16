import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Commerce Course 模块配置（带安全默认值）。环境变量见 docs/Course_Module_Import_Export_Design.md §19。
 */
export type VersionNumberingMode = 'sandbox' | 'production';

export interface CommerceCourseConfig {
  environmentLabel: string;
  publicSiteUrl: string;
  versionNumberingMode: VersionNumberingMode;
  /**
   * 环境语义是否已确定（R16）：VERSION_NUMBERING_MODE 显式配置，或未显式但
   * NODE_ENV=production 推导为生产。为 false（两个信号都缺）时导出路径必须
   * 拒绝——绝不静默把 sourceEnv 写成 sandbox。使用点按 `!== true` 拒绝（fail closed）。
   */
  environmentDetermined?: boolean;
  stripeSecretKey?: string;
  mediaRoot: string;
  packageStagingRoot: string;
  // 对象存储（生产用 S3 私有桶；未配置时回退到本地文件系统）
  awsRegion?: string;
  mediaBucket?: string;
  mediaPrefix?: string;
  stagingBucket?: string;
  stagingPrefix?: string;
  s3Endpoint?: string;
  s3ForcePathStyle?: boolean;
  maxImageBytes: number;
  maxVideoBytes: number;
  maxAudioBytes: number;
  maxPdfBytes: number;
  maxModelBytes: number;
  packageMaxBytes: number;
  packageDirectUploadBytes: number;
  packageExportTtlHours: number;
  jobConcurrency: number;
  jobPollMs: number;
  jobHeartbeatMs: number;
  jobStaleMs: number;
  jobMaxAttempts: number;
}

const MB = 1024 * 1024;

/**
 * ALLOW_DRAFT_EXPORT 休眠开关（默认关闭，fail closed）。
 *
 * PRD §16.2（Aligned Design §16.2 L177）：『导出的是当前线上版本（已发布到
 * Sandbox、测试过的），不能选草稿/其他版本』。草稿/历史版本导出仅用于 Sandbox
 * 调试，显式设 ALLOW_DRAFT_EXPORT=on 才放行；缺省或无法识别的值一律关闭
 * （镜像 partc/compiler/parse.ts 的 packageSourceEnforcementFromEnv 先例）。
 */
export function draftExportAllowedFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env.ALLOW_DRAFT_EXPORT?.trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1';
}

/** 生产模式启动告警：进程内只发一次（工厂可能被多次编译调用）。 */
let productionModeWarningEmitted = false;

/** 仅供测试：重置告警旗标（commerce.config.spec.ts 用）。 */
export function resetProductionModeWarningForTests(): void {
  productionModeWarningEmitted = false;
}

function warnProductionModeOnce(message: string): void {
  if (productionModeWarningEmitted) return;
  productionModeWarningEmitted = true;
  Logger.warn(message, 'CommerceCourseConfig');
}

export function commerceConfig(config: ConfigService): CommerceCourseConfig {
  const num = (key: string, fallback: number): number => {
    const raw = config.get<string>(key);
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const numberingRaw = (config.get<string>('VERSION_NUMBERING_MODE') ?? '')
    .trim()
    .toLowerCase();
  const environmentRaw = (config.get<string>('ENVIRONMENT_LABEL') ?? '').trim();
  const nodeEnv = (config.get<string>('NODE_ENV') ?? '').trim().toLowerCase();

  // R16：环境语义显式化。显式配置 → 该模式；未显式但 NODE_ENV=production →
  // 推导生产并告警一次；两个信号都缺 → 编号回退 sandbox 但 environmentDetermined
  // = false，导出路径据此拒绝（不再静默写 sourceEnv=sandbox）。
  const numberingExplicit =
    numberingRaw === 'production' || numberingRaw === 'sandbox';
  let versionNumberingMode: VersionNumberingMode;
  let environmentDetermined: boolean;
  if (numberingExplicit) {
    versionNumberingMode = numberingRaw;
    environmentDetermined = true;
  } else if (nodeEnv === 'production') {
    versionNumberingMode = 'production';
    environmentDetermined = true;
  } else {
    versionNumberingMode = 'sandbox';
    environmentDetermined = false;
  }
  if (versionNumberingMode === 'production') {
    warnProductionModeOnce(
      numberingExplicit
        ? 'Production environment active (VERSION_NUMBERING_MODE=production). ' +
            'Course exports carry sourceEnv=production and use integer version numbering.'
        : 'VERSION_NUMBERING_MODE is not set. NODE_ENV=production → deriving production mode. ' +
            'Set VERSION_NUMBERING_MODE explicitly (sandbox or production) to confirm the environment.',
    );
  }
  return {
    environmentLabel:
      environmentRaw ||
      (versionNumberingMode === 'production' ? 'Production' : 'Sandbox'),
    publicSiteUrl: config.get<string>('PUBLIC_SITE_URL')?.trim() || '',
    versionNumberingMode,
    environmentDetermined,
    stripeSecretKey:
      config.get<string>('STRIPE_SECRET_KEY')?.trim() || undefined,
    mediaRoot:
      config.get<string>('COURSE_MEDIA_ROOT')?.trim() || 'storage/course-media',
    packageStagingRoot:
      config.get<string>('COURSE_PACKAGE_ROOT')?.trim() ||
      'storage/course-package',
    awsRegion: config.get<string>('AWS_REGION')?.trim() || 'ap-southeast-1',
    mediaBucket: config.get<string>('COURSE_MEDIA_BUCKET')?.trim() || undefined,
    mediaPrefix: config.get<string>('COURSE_MEDIA_PREFIX')?.trim() || '',
    stagingBucket:
      config.get<string>('COURSE_PACKAGE_BUCKET')?.trim() ||
      config.get<string>('COURSE_MEDIA_BUCKET')?.trim() ||
      undefined,
    stagingPrefix:
      config.get<string>('COURSE_PACKAGE_PREFIX')?.trim() || 'staging/',
    s3Endpoint: config.get<string>('S3_ENDPOINT')?.trim() || undefined,
    s3ForcePathStyle:
      (config.get<string>('S3_FORCE_PATH_STYLE') ?? '').toLowerCase() ===
      'true',
    maxImageBytes: num('MEDIA_MAX_IMAGE_BYTES', 20 * MB),
    maxVideoBytes: num('MEDIA_MAX_VIDEO_BYTES', 500 * MB),
    maxAudioBytes: num('MEDIA_MAX_AUDIO_BYTES', 100 * MB),
    maxPdfBytes: num('MEDIA_MAX_PDF_BYTES', 100 * MB),
    maxModelBytes: num('MEDIA_MAX_MODEL_BYTES', 25 * MB),
    packageMaxBytes: num('PACKAGE_MAX_BYTES', 8 * 1024 * MB),
    packageDirectUploadBytes: num('PACKAGE_DIRECT_UPLOAD_BYTES', 200 * MB),
    packageExportTtlHours: num('PACKAGE_EXPORT_TTL_HOURS', 24),
    jobConcurrency: num('PACKAGE_JOB_CONCURRENCY', 2),
    jobPollMs: num('PACKAGE_JOB_POLL_MS', 2000),
    jobHeartbeatMs: num('PACKAGE_JOB_HEARTBEAT_MS', 10_000),
    jobStaleMs: num('PACKAGE_JOB_STALE_MS', 10 * 60 * 1000),
    jobMaxAttempts: num('PACKAGE_JOB_MAX_ATTEMPTS', 3),
  };
}

export const COMMERCE_CONFIG = Symbol('COMMERCE_CONFIG');
