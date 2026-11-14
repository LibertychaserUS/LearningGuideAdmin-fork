import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { sendMedia } from './media-stream';
import { PortalProjectionService } from './portal-projection.service';
import { PortalPreviewService } from './portal-preview.service';
import { CourseStorageService } from './storage.service';

/**
 * Portal 只读投影（v1 形状）。服务令牌鉴权（/api 路由在 route-access 登记为 service）。
 * Portal 现有页面消费；v2 新契约另开 /api/portal/v2（P1b/后续）。
 */
@Controller('portal/v1')
export class PortalCoursesController {
  constructor(
    private readonly projection: PortalProjectionService,
    private readonly preview: PortalPreviewService,
    private readonly storage: CourseStorageService,
  ) {}

  @Get('courses')
  list(@Query('limit') limit?: string) {
    return this.projection.listCourses(limit ? Number(limit) : undefined);
  }

  /** C1：分类树（只含 ACTIVE；契约不暴露 UUID；缓存 60s）。 */
  @Get('categories')
  @Header('Cache-Control', 'private, max-age=60')
  categories() {
    return this.projection.listCategoryTree();
  }

  @Get('courses/:id')
  async detail(@Param('id') id: string) {
    const course = await this.projection.getCourseById(id);
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    return course;
  }

  /** Portal 服务端用 preview token 取草稿/指定版本数据；仍需 X-API-Key 服务鉴权。 */
  @Get('preview/course')
  async previewCourse(@Query('token') token?: string) {
    const payload = this.preview.verifyToken(token ?? '');
    const course = await this.projection.getPreviewCourse(
      payload.courseId,
      payload.versionId ?? undefined,
    );
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    return course;
  }

  @Get('media/:courseId/cover')
  async cover(@Param('courseId') courseId: string, @Res() res: Response) {
    const media = await this.projection.getCoverBytes(courseId);
    if (!media || !(await sendMedia(res, this.storage, media))) {
      throw new NotFoundException({
        code: 'COURSE_MEDIA_NOT_FOUND',
        message: 'Cover not found.',
      });
    }
  }

  @Get('media/:courseId/assets/:assetId')
  async asset(
    @Param('courseId') courseId: string,
    @Param('assetId') assetId: string,
    @Res() res: Response,
  ) {
    const media = await this.projection.getMediaBytes(courseId, assetId);
    if (!media || !(await sendMedia(res, this.storage, media))) {
      throw new NotFoundException({
        code: 'COURSE_MEDIA_NOT_FOUND',
        message: 'Media not found.',
      });
    }
  }
}
