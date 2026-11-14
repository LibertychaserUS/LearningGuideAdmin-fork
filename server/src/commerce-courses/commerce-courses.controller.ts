import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import JSZip from 'jszip';
import type { Response } from 'express';

import { CommerceCoursesService } from './commerce-courses.service';
import { PackageJobsService } from './package-jobs.service';
import { PackageWorker } from './package-worker';
import { PackageError } from './package-inspector';
import { PublishingService } from './publishing.service';
import { TrialService } from './trial.service';
import { PricingService } from './pricing.service';
import { PreviewService } from './preview.service';
import { CourseAuthoringService } from './course-authoring.service';
import { MediaUploadService } from './media-upload.service';
import { PortalPreviewService } from './portal-preview.service';
import { PortalProjectionService } from './portal-projection.service';
import { sendMedia } from './media-stream';
import { CourseStorageService } from './storage.service';
import { DraftRevisionInterceptor } from './draft-revision';
import type { BackofficeRequest } from '../backoffice/nest/request-context';
import { CourseCapabilityGuard } from './course-capability.guard';

function actor(request: BackofficeRequest): string | null {
  return request.employee?.employeeId ?? null;
}

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((error: unknown) => {
    if (error instanceof PackageError) {
      throw error;
    }
    throw error;
  });
}

/**
 * 商品课程 v2 管理接口（P1a：列表/详情/工作流/导入导出）。
 * RBAC 见 backoffice route-access：courses/* 走 knowledge 菜单，导入导出要求 FULL。
 */
@Controller('backoffice/courses')
@UseGuards(CourseCapabilityGuard)
export class CommerceCoursesController {
  constructor(
    private readonly courses: CommerceCoursesService,
    private readonly jobs: PackageJobsService,
    private readonly worker: PackageWorker,
    private readonly publishing: PublishingService,
    private readonly trial: TrialService,
    private readonly pricing: PricingService,
    private readonly preview: PreviewService,
    private readonly authoring: CourseAuthoringService,
    private readonly mediaUploads: MediaUploadService,
    private readonly portalPreview: PortalPreviewService,
    private readonly portalProjection: PortalProjectionService,
    private readonly storage: CourseStorageService,
  ) {}

  @Get()
  list(
    @Query('search') search?: string,
    @Query('lifecycleStatus') lifecycleStatus?: string,
    @Query('liveStatus') liveStatus?: string,
    @Query('categoryId') categoryId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.courses.list({
      search,
      lifecycleStatus,
      liveStatus,
      categoryId,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Post()
  @HttpCode(201)
  create(
    @Body()
    body: {
      code: string;
      slug?: string;
      title: string;
      language?: string;
      learningMode?: string;
      defaultContentLanguage?: string;
      learningLanguages?: string[];
      subtitle?: string | null;
      categoryId?: string | null;
    },
    @Req() request: BackofficeRequest,
  ) {
    return this.courses.createCourse(body, actor(request));
  }

  @Get('categories')
  categories() {
    return this.authoring.listCategories();
  }

  // 只读诊断：确认媒体存储驱动（S3 桶/前缀 或 本地路径），便于核对 S3 是否生效。需声明在 :id 之前。
  @Get('storage-info')
  storageInfo() {
    return this.jobs.storageInfo();
  }

  // 上传上限：前端在「上传视频/展品/封面」处直接展示，避免用户选完大文件才被拒。需声明在 :id 之前。
  @Get('media-limits')
  mediaLimits() {
    return this.mediaUploads.limits();
  }

  @Get(':id')
  @UseInterceptors(DraftRevisionInterceptor)
  detail(@Param('id') id: string) {
    return this.courses.detail(id);
  }

  @Get(':id/versions')
  versions(@Param('id') id: string) {
    return this.publishing.listVersions(id);
  }

  @Get(':id/versions/:versionId')
  version(@Param('id') id: string, @Param('versionId') versionId: string) {
    return this.publishing.getVersion(id, versionId);
  }

  @Get(':id/history')
  history(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.publishing.listHistory(id, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get(':id/preview')
  previewCourse(
    @Param('id') id: string,
    @Query('versionId') versionId?: string,
  ) {
    return this.preview.preview(id, versionId || undefined);
  }

  /** 生成短时效课程预览链接（Admin 自建 Portal 风格预览页）。 */
  @Get(':id/portal-preview')
  portalPreviewLink(
    @Param('id') id: string,
    @Query('versionId') versionId?: string,
    @Query('locale') locale?: string,
  ) {
    return this.portalPreview.createLink(
      id,
      versionId || undefined,
      locale || undefined,
    );
  }

  /**
   * 预览页数据：员工会话 + 预览 token 双重要求。
   * 返回与 Portal 投影一致的详情结构（草稿或指定版本），供 Admin 预览页渲染。
   */
  @Get(':id/portal-preview/content')
  async portalPreviewContent(
    @Param('id') id: string,
    @Query('token') token?: string,
  ) {
    const payload = this.portalPreview.verifyToken(token ?? '');
    if (payload.courseId !== id)
      throw new PackageError(
        'INVALID_PREVIEW_TOKEN',
        401,
        'Preview token does not match this course.',
      );
    const course = await this.portalProjection.getPreviewCourse(
      id,
      payload.versionId ?? undefined,
    );
    if (!course)
      throw new PackageError('COURSE_NOT_FOUND', 404, 'Course not found.');
    return course;
  }

  /**
   * 预览页媒体：员工会话 + 预览 token 双重校验。
   * 与正式 Portal 媒体端点读同一个存储对象，只是允许草稿/指定版本课程
   * （不要求已 ONLINE），并支持 HTTP Range 供视频试播。
   */
  @Get(':id/portal-preview/cover')
  async portalPreviewCover(
    @Param('id') id: string,
    @Query('token') token: string,
    @Res() res: Response,
  ) {
    const payload = this.portalPreview.verifyToken(token ?? '');
    if (payload.courseId !== id) {
      throw new PackageError(
        'INVALID_PREVIEW_TOKEN',
        401,
        'Preview token does not match this course.',
      );
    }
    const media = await this.portalProjection.getPreviewCoverBytes(id);
    if (!media || !(await sendMedia(res, this.storage, media))) {
      throw new PackageError('COURSE_MEDIA_NOT_FOUND', 404, 'Cover not found.');
    }
  }
  @Get(':id/portal-preview/media/:assetId')
  async portalPreviewMedia(
    @Param('id') id: string,
    @Param('assetId') assetId: string,
    @Query('token') token: string,
    @Res() res: Response,
  ) {
    const payload = this.portalPreview.verifyToken(token ?? '');
    if (payload.courseId !== id) {
      throw new PackageError(
        'INVALID_PREVIEW_TOKEN',
        401,
        'Preview token does not match this course.',
      );
    }
    const media = await this.portalProjection.getPreviewMediaBytes(id, assetId);
    if (!media || !(await sendMedia(res, this.storage, media))) {
      throw new PackageError('COURSE_MEDIA_NOT_FOUND', 404, 'Media not found.');
    }
  }

  // ===== 预览媒体（Admin 课程页展示封面 / 视频 / 展品图） =====
  @Get(':id/cover')
  async cover(@Param('id') id: string, @Res() res: Response) {
    const media = await this.courses.getCoverBytes(id);
    if (!media) {
      throw new PackageError('COURSE_MEDIA_NOT_FOUND', 404, 'Cover not found.');
    }
    if (!(await sendMedia(res, this.storage, media))) {
      throw new PackageError('COURSE_MEDIA_NOT_FOUND', 404, 'Cover not found.');
    }
  }

  @Get(':id/media/:assetId')
  async media(
    @Param('id') id: string,
    @Param('assetId') assetId: string,
    @Res() res: Response,
  ) {
    const media = await this.courses.getMediaBytes(id, assetId);
    if (!media) {
      throw new PackageError('COURSE_MEDIA_NOT_FOUND', 404, 'Media not found.');
    }
    if (!(await sendMedia(res, this.storage, media))) {
      throw new PackageError('COURSE_MEDIA_NOT_FOUND', 404, 'Media not found.');
    }
  }

  // ===== 编辑工作区（第一版） =====
  @Put(':id')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(200)
  updateCourse(
    @Param('id') id: string,
    @Body()
    body: {
      code?: string;
      slug?: string;
      learningMode?: string;
      defaultContentLanguage?: string;
      learningLanguages?: string[];
      subtitle?: string | null;
      level?: string | null;
      categoryId?: string | null;
    },
  ) {
    return this.courses.updateCourse(id, body);
  }

  @Put(':id/localizations/:language')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(200)
  updateLocalization(
    @Param('id') id: string,
    @Param('language') language: string,
    @Body()
    body: {
      title: string;
      shortDescription?: string | null;
      overview?: string | null;
      whatYouLearn?: unknown;
      provides?: unknown;
    },
  ) {
    return this.courses.updateLocalization(id, language, body);
  }

  @Post(':id/lessons')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(201)
  createLesson(
    @Param('id') id: string,
    @Body() body: { code?: string; language?: string; title: string },
  ) {
    return this.courses.createLesson(id, body);
  }

  @Put(':id/lessons/reorder')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(200)
  reorderLessons(
    @Param('id') id: string,
    @Body() body: { lessonIds: string[] },
  ) {
    return this.courses.reorderLessons(id, body.lessonIds);
  }

  @Put(':id/lessons/:lessonId')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(200)
  updateLesson(
    @Param('id') id: string,
    @Param('lessonId') lessonId: string,
    @Body()
    body: {
      code?: string;
      sortOrder?: number;
      language?: string;
      title?: string;
      description?: string | null;
      textHtml?: string | null;
    },
  ) {
    return this.courses.updateLesson(id, lessonId, body);
  }

  @Delete(':id/lessons/:lessonId')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(200)
  deleteLesson(@Param('id') id: string, @Param('lessonId') lessonId: string) {
    return this.courses.deleteLesson(id, lessonId);
  }

  // ===== 课程内容创作（CM05–CM07）=====
  @Post(':id/media')
  @UseInterceptors(FileInterceptor('file'))
  uploadMedia(
    @Param('id') id: string,
    @UploadedFile()
    file:
      { originalname: string; mimetype?: string; buffer: Buffer } | undefined,
  ) {
    return this.authoring.uploadMedia(id, file);
  }

  // ===== 大文件分块上传（视频可达数百 MB，单请求会被边缘切断）=====
  @Post(':id/media/session')
  @HttpCode(200)
  createMediaUploadSession(
    @Param('id') id: string,
    @Body() body: { fileName?: string; bytesTotal?: number },
  ) {
    return this.mediaUploads.createSession(id, body ?? {});
  }

  @Get(':id/media/sessions/:sessionId')
  mediaUploadSession(
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.mediaUploads.status(id, sessionId);
  }

  @Put(':id/media/sessions/:sessionId/chunk')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('chunk'))
  uploadMediaChunk(
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Query('index') index: string | undefined,
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ) {
    return this.mediaUploads.appendChunk(
      id,
      sessionId,
      Number(index),
      file?.buffer,
    );
  }

  @Post(':id/media/sessions/:sessionId/complete')
  @HttpCode(200)
  completeMediaUpload(
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.mediaUploads.complete(id, sessionId);
  }

  @Delete(':id/media/sessions/:sessionId')
  @HttpCode(200)
  cancelMediaUpload(
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.mediaUploads.cancel(id, sessionId);
  }

  @Post(':id/cover')
  @UseInterceptors(DraftRevisionInterceptor)
  @UseInterceptors(FileInterceptor('file'))
  uploadCover(
    @Param('id') id: string,
    @UploadedFile()
    file:
      { originalname: string; mimetype?: string; buffer: Buffer } | undefined,
  ) {
    return this.authoring.uploadCover(id, file);
  }

  @Delete(':id/cover')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(200)
  deleteCover(@Param('id') id: string) {
    return this.authoring.deleteCover(id);
  }

  @Put(':id/lessons/:lessonId/video')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(200)
  setLessonVideo(
    @Param('id') id: string,
    @Param('lessonId') lessonId: string,
    @Body() body: { language: string; assetId: string },
  ) {
    return this.authoring.setLessonVideo(
      id,
      lessonId,
      body.language,
      body.assetId,
    );
  }

  @Put(':id/lessons/:lessonId/learning-points')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(200)
  saveLearningPoints(
    @Param('id') id: string,
    @Param('lessonId') lessonId: string,
    @Body()
    body: {
      language: string;
      points: Array<{ code?: string; title: string; timeSeconds: number }>;
    },
  ) {
    return this.authoring.saveVideoLearningPoints(
      id,
      lessonId,
      body.language,
      body.points ?? [],
    );
  }

  @Put(':id/lessons/:lessonId/triggers')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(200)
  saveTriggers(
    @Param('id') id: string,
    @Param('lessonId') lessonId: string,
    @Body()
    body: {
      language: string;
      triggers: Array<{ exhibitId: string; timeSeconds: number }>;
    },
  ) {
    return this.authoring.saveTriggers(
      id,
      lessonId,
      body.language,
      body.triggers ?? [],
    );
  }

  @Post(':id/lessons/:lessonId/exhibits')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(201)
  createExhibit(
    @Param('id') id: string,
    @Param('lessonId') lessonId: string,
    @Body()
    body: {
      code?: string;
      type: string;
      mediaAssetId?: string | null;
      thumbnailAssetId?: string | null;
      sourceText?: string | null;
      localized?: unknown;
    },
  ) {
    return this.authoring.createExhibit(id, lessonId, body);
  }

  @Put(':id/lessons/:lessonId/exhibits/:exhibitId')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(200)
  updateExhibit(
    @Param('id') id: string,
    @Param('lessonId') lessonId: string,
    @Param('exhibitId') exhibitId: string,
    @Body()
    body: {
      type?: string;
      mediaAssetId?: string | null;
      thumbnailAssetId?: string | null;
      sourceText?: string | null;
      localized?: unknown;
    },
  ) {
    return this.authoring.updateExhibit(id, lessonId, exhibitId, body);
  }

  @Delete(':id/lessons/:lessonId/exhibits/:exhibitId')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(200)
  deleteExhibit(
    @Param('id') id: string,
    @Param('lessonId') lessonId: string,
    @Param('exhibitId') exhibitId: string,
  ) {
    return this.authoring.deleteExhibit(id, lessonId, exhibitId);
  }

  @Put(':id/lessons/:lessonId/readings')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(200)
  saveReadings(
    @Param('id') id: string,
    @Param('lessonId') lessonId: string,
    @Body()
    body: {
      language: string;
      readings: Array<{
        type: string;
        title: string;
        author: string;
        whyRecommended: string;
      }>;
    },
  ) {
    return this.authoring.saveReadings(
      id,
      lessonId,
      body.language,
      body.readings ?? [],
    );
  }

  @Post(':id/docx')
  @UseInterceptors(FileInterceptor('file'))
  parseDocx(
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
  ): Promise<{
    html: string;
    messages: Array<{ type: string; message: string }>;
  }> {
    return this.authoring.parseDocx(file);
  }

  @Post(':id/readings/import')
  @UseInterceptors(DraftRevisionInterceptor)
  @UseInterceptors(FileInterceptor('file'))
  importReadings(
    @Param('id') id: string,
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
  ) {
    return this.authoring.importReadings(id, file);
  }

  @Put(':id/lessons/:lessonId/knowledge-test')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(200)
  saveKnowledgeTest(
    @Param('id') id: string,
    @Param('lessonId') lessonId: string,
    @Body()
    body: {
      enabled: boolean;
      questions: Array<{
        code?: string;
        question: string;
        referenceAnswer: string;
      }>;
    },
  ) {
    return this.authoring.saveKnowledgeTest(
      id,
      lessonId,
      Boolean(body.enabled),
      body.questions ?? [],
    );
  }

  @Put(':id/lessons/:lessonId/application-test')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(200)
  saveApplicationTest(
    @Param('id') id: string,
    @Param('lessonId') lessonId: string,
    @Body()
    body: { enabled: boolean; scenario?: string; referenceAnswer?: string },
  ) {
    return this.authoring.saveApplicationTest(id, lessonId, body);
  }

  @Post(':id/understanding/import')
  @UseInterceptors(DraftRevisionInterceptor)
  @UseInterceptors(FileInterceptor('file'))
  importUnderstanding(
    @Param('id') id: string,
    @Body() body: { language?: string; lessonId?: string },
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
  ) {
    return this.authoring.importUnderstanding(
      id,
      body.language || 'en-GB',
      file,
      body.lessonId,
    );
  }

  @Get(':id/understanding/template')
  async understandingTemplate(@Param('id') id: string, @Res() res: Response) {
    const csv = await this.authoring.downloadUnderstandingTemplate(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="understanding-template.csv"',
    );
    res.send(csv);
  }

  // ===== 草稿 / 发布 / 版本（PRD §15）=====
  @Post(':id/publish')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(200)
  publish(
    @Param('id') id: string,
    @Body() body: { notifyLearners?: boolean },
    @Req() request: BackofficeRequest,
  ) {
    return this.publishing.publish(id, actor(request), body ?? {});
  }

  @Post(':id/delete-draft')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(200)
  deleteDraft(@Param('id') id: string, @Req() request: BackofficeRequest) {
    return this.publishing.deleteDraft(id, actor(request));
  }

  @Post(':id/live-status')
  @HttpCode(200)
  changeStatus(
    @Param('id') id: string,
    @Body() body: { status: 'ONLINE' | 'HIDDEN' | 'OFFLINE'; reason?: string },
    @Req() request: BackofficeRequest,
  ) {
    return this.publishing.changeStatus(id, body, actor(request));
  }

  @Post(':id/restore')
  @UseInterceptors(DraftRevisionInterceptor)
  @HttpCode(200)
  restore(
    @Param('id') id: string,
    @Body() body: { versionId: string },
    @Req() request: BackofficeRequest,
  ) {
    return this.publishing.restore(id, body.versionId, actor(request));
  }

  // ===== Trial（不生成版本，PRD §14）=====
  @Get(':id/trial')
  getTrial(@Param('id') id: string) {
    return this.trial.get(id);
  }

  @Put(':id/trial')
  @HttpCode(200)
  saveTrial(
    @Param('id') id: string,
    @Body()
    body: {
      enabled: boolean;
      rows?: Array<{
        lessonId: string;
        videoCutoffSeconds?: number | null;
        textCutoffLearningPointId?: string | null;
        videoCutoffByLanguage?: Record<string, number | null>;
        textCutoffByLanguage?: Record<string, string | null>;
      }>;
    },
  ) {
    return this.trial.save(id, body);
  }

  // ===== Pricing（不生成版本，PRD §14）=====
  @Get(':id/plans')
  listPlans(@Param('id') id: string) {
    return this.pricing.list(id);
  }

  @Put(':id/plans')
  @HttpCode(200)
  savePlans(
    @Param('id') id: string,
    @Body()
    body: {
      plans: Array<{
        id?: string;
        name: string;
        termMonths: number;
        amountMinor: number;
        currency?: string;
        lookupKey?: string;
      }>;
    },
  ) {
    return this.pricing.save(id, body?.plans ?? []);
  }

  @Post(':id/plans/:planId/sync-stripe')
  @HttpCode(200)
  syncPlan(@Param('id') id: string, @Param('planId') planId: string) {
    return this.pricing.syncPlan(id, planId);
  }

  // ===== 原始素材导入（Excel + Word/视频/图片素材 ZIP） =====
  @Post('import/raw')
  @UseInterceptors(FileInterceptor('file'))
  importRaw(
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
    @Req() request: BackofficeRequest,
  ) {
    if (!file?.buffer) {
      throw new PackageError(
        'PACKAGE_INVALID_ZIP',
        400,
        'No raw materials archive uploaded.',
      );
    }
    if (!file.originalname.toLowerCase().endsWith('.zip')) {
      throw new PackageError(
        'PACKAGE_INVALID_ZIP',
        400,
        'Raw course materials must be uploaded as a .zip archive.',
      );
    }
    const idempotencyKey =
      typeof request.headers['idempotency-key'] === 'string'
        ? request.headers['idempotency-key']
        : undefined;
    return wrap(() =>
      this.jobs.createRawImportJob(
        { name: file.originalname, bytes: file.buffer },
        actor(request),
        idempotencyKey,
      ),
    );
  }

  // ===== 原始素材分块上传（大包：前端切块，逐块上传，规避边缘单请求限制）=====
  @Post('import/raw/session')
  @HttpCode(200)
  createRawUploadSession(
    @Body() body: { fileName?: string; bytesTotal?: number },
    @Req() request: BackofficeRequest,
  ) {
    const idempotencyKey =
      typeof request.headers['idempotency-key'] === 'string'
        ? request.headers['idempotency-key']
        : undefined;
    return wrap(() =>
      this.jobs.createRawUploadSession(
        {
          name: body?.fileName || 'raw.zip',
          bytesTotal: Number(body?.bytesTotal) || 0,
        },
        actor(request),
        idempotencyKey,
      ),
    );
  }

  @Put('import/:jobId/chunk')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('chunk'))
  uploadRawChunk(
    @Param('jobId') jobId: string,
    @Query('index') chunkIndex: string | undefined,
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ) {
    if (!file?.buffer) {
      throw new PackageError('INVALID_INPUT', 400, 'No chunk uploaded.');
    }
    return wrap(() =>
      this.jobs.appendRawChunk(jobId, Number(chunkIndex), file.buffer),
    );
  }

  @Post('import/:jobId/complete')
  @HttpCode(200)
  completeRawUpload(@Param('jobId') jobId: string) {
    return wrap(() => this.jobs.completeRawUpload(jobId));
  }

  // ===== 本地目录导入（服务端直接读取仓库内 docs 素材，规避浏览器上传大文件中断） =====
  @Post('import/local')
  @HttpCode(201)
  importLocal(
    @Body() body: { dir?: string; courseCode?: string; slug?: string },
    @Req() request: BackofficeRequest,
  ) {
    return wrap(() =>
      this.jobs.createLocalRawImportJob(body ?? {}, actor(request)),
    );
  }

  // ===== 导入到已有课程（只替换草稿，CM16）=====
  @Post(':id/import')
  @UseInterceptors(FileInterceptor('file'))
  async importIntoCourse(
    @Param('id') id: string,
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
    @Req() request: BackofficeRequest,
  ) {
    await this.courses.assertExists(id);
    if (!file?.buffer) {
      throw new PackageError(
        'PACKAGE_INVALID_ZIP',
        400,
        'No package file uploaded.',
      );
    }
    if (
      !file.originalname.toLowerCase().endsWith('.zip') &&
      !file.originalname.toLowerCase().endsWith('.lgcourse.zip')
    ) {
      throw new PackageError(
        'PACKAGE_NOT_A_COURSE',
        422,
        'Only .lgcourse.zip course packages can be imported.',
      );
    }
    const idempotencyKey =
      typeof request.headers['idempotency-key'] === 'string'
        ? request.headers['idempotency-key']
        : undefined;
    return wrap(() =>
      this.jobs.createImportJob(
        { name: file.originalname, bytes: file.buffer },
        actor(request),
        idempotencyKey,
        id,
      ),
    );
  }

  // ===== 导入 =====
  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  async import(
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
    @Req() request: BackofficeRequest,
  ) {
    if (!file?.buffer) {
      throw new PackageError(
        'PACKAGE_INVALID_ZIP',
        400,
        'No package file uploaded.',
      );
    }
    if (
      !file.originalname.toLowerCase().endsWith('.zip') &&
      !file.originalname.toLowerCase().endsWith('.lgcourse.zip')
    ) {
      throw new PackageError(
        'PACKAGE_NOT_A_COURSE',
        422,
        'Only .zip course packages or raw-material archives can be imported.',
      );
    }
    const idempotencyKey =
      typeof request.headers['idempotency-key'] === 'string'
        ? request.headers['idempotency-key']
        : undefined;
    // 智能识别：zip 内没有 manifest.json 但含 xlsx（原始素材包）时，自动走原始素材导入。
    const isRaw = await this.looksLikeRawMaterials(file.buffer);
    return wrap(() =>
      isRaw
        ? this.jobs.createRawImportJob(
            { name: file.originalname, bytes: file.buffer },
            actor(request),
            idempotencyKey,
          )
        : this.jobs.createImportJob(
            { name: file.originalname, bytes: file.buffer },
            actor(request),
            idempotencyKey,
          ),
    );
  }

  /** zip 内是否存在 manifest.json；不存在且含 .xlsx 视为原始素材包。 */
  private async looksLikeRawMaterials(bytes: Buffer): Promise<boolean> {
    try {
      const zip = await JSZip.loadAsync(bytes);
      const names = Object.keys(zip.files);
      if (
        names.some((n) => n === 'manifest.json' || n.endsWith('/manifest.json'))
      )
        return false;
      return names.some((n) => /\.xlsx$/i.test(n));
    } catch {
      return false;
    }
  }

  @Get('import/:jobId')
  importStatus(@Param('jobId') jobId: string) {
    return this.jobs.getJob(jobId);
  }

  @Post('import/:jobId/confirm')
  @HttpCode(200)
  confirmImport(
    @Param('jobId') jobId: string,
    @Body()
    body: {
      onConflict: 'ABORT' | 'CREATE_NEW_COURSE' | 'NEW_VERSION';
      reassignCodes?: boolean;
      overwriteDraft?: boolean;
    },
    @Req() request: BackofficeRequest,
  ) {
    return wrap(() => this.jobs.confirmImport(jobId, body, actor(request)));
  }

  @Post('import/:jobId/cancel')
  @HttpCode(200)
  cancelImport(@Param('jobId') jobId: string) {
    return this.jobs.cancelJob(jobId);
  }

  // ===== 导出 =====
  @Post(':id/export')
  @HttpCode(202)
  export(
    @Param('id') id: string,
    @Body() body: { version?: string },
    @Req() request: BackofficeRequest,
  ) {
    return wrap(() => this.jobs.startExport(id, actor(request), body?.version));
  }

  @Get('export/:jobId')
  exportStatus(@Param('jobId') jobId: string) {
    return this.jobs.getJob(jobId);
  }

  @Get('export/:jobId/download')
  async download(@Param('jobId') jobId: string, @Res() res: Response) {
    const bytes = await this.worker.readExport(jobId);
    if (!bytes) {
      throw new PackageError('PACKAGE_JOB_NOT_FOUND', 404, 'Export not ready.');
    }
    const job = await this.jobs.getJob(jobId);
    const fileName = job.fileLabel ?? `course-${jobId}.lgcourse.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    res.send(bytes);
  }

  // ===== 作业列表 =====
  @Get('jobs/list')
  jobsList(@Req() request: BackofficeRequest) {
    return this.jobs.listJobs(actor(request));
  }
}
