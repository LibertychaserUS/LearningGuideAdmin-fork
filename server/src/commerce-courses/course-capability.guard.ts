import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';

import {
  assertCapabilityEnabled,
  capabilityEnforcementFromEnv,
  courseCapabilityForRequest,
  type SourceEnv,
} from '../partc/contracts/environment';
import { isPartCError } from '../partc/errors';
import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';

const COURSE_PREFIX = /^\/?(?:api\/)?backoffice\/courses\/?/i;

/**
 * 课程能力矩阵（设计 §14 C10.7）：服务端强制，不靠 UI 隐藏。
 *
 * - 休眠开关 `ENV_CAPABILITY_ENFORCEMENT` 默认 off：请求原样放行，
 *   行为与现状完全一致（UAT 即生产，部署后不能锁死 authoring）。
 * - on：Production 禁用 `course.authoring`（403 CAPABILITY_DISABLED）；
 *   `course.import` / `course.publish` / `course.status` 在两个环境都可用。
 * - 环境由服务端配置（VERSION_NUMBERING_MODE）判定，不信任客户端声明。
 */
@Injectable()
export class CourseCapabilityGuard implements CanActivate {
  constructor(
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!capabilityEnforcementFromEnv()) return true;
    const request = context
      .switchToHttp()
      .getRequest<{ method: string; path: string }>();
    const segments = request.path
      .replace(COURSE_PREFIX, '')
      .split('/')
      .filter(Boolean);
    const capability = courseCapabilityForRequest(request.method, segments);
    if (!capability) return true;
    const environment: SourceEnv =
      this.config.versionNumberingMode === 'production'
        ? 'production'
        : 'sandbox';
    try {
      assertCapabilityEnabled(environment, capability);
    } catch (error) {
      if (isPartCError(error) && error.code === 'CAPABILITY_DISABLED') {
        throw new ForbiddenException({
          code: 'CAPABILITY_DISABLED',
          message: error.message,
        });
      }
      throw error;
    }
    return true;
  }
}
