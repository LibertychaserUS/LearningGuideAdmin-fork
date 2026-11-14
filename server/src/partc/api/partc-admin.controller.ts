import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { BackofficeRequest } from '../../backoffice/nest/request-context';
import { CourseCapabilityGuard } from '../../commerce-courses/course-capability.guard';
import type { ApplyResult } from '../compiler/apply';
import type { EvidenceSpec, PrerequisiteEdge, Stage } from '../contracts';
import { PartcAdminService, type PlanView } from './partc-admin.service';

/**
 * Part C 管理端 API（评审阻断 4-API；设计 §14 C9 步骤 5）。
 *
 * 路由挂在 `/api/backoffice/courses/:courseKey/partc/**`：
 * - 员工会话与菜单权限由全局 BackofficeAccessGuard 统一处理（沿用既有模型）；
 * - 能力门 CourseCapabilityGuard（ENV_CAPABILITY_ENFORCEMENT 默认 off）：
 *   阶段树/证据规格编辑 = course.authoring（Production 禁用），
 *   计划工作流 = course.publish（C10.7：Production 允许 plan preview/approve/publish）。
 *
 * 路由形状（orderKey 由服务端生成，客户端不传）：
 * - GET  stages / PUT stages（stage/step 树 + requires/recommends 边，整组原子替换）
 * - GET  evidence-specs / PUT evidence-specs/:evidenceKey（新版本）
 * - GET  alignments / POST alignments/:alignmentId/sign-off（人签：proposed →
 *   verified/rejected；C3/C4 ALN-2）
 * - GET  content-versions
 * - POST plans/preview → plans/save → plans/approve → plans/apply | plans/publish
 */
@Controller('backoffice/courses/:courseKey/partc')
@UseGuards(CourseCapabilityGuard)
export class PartcAdminController {
  constructor(private readonly partc: PartcAdminService) {}

  @Get('stages')
  getStages(@Param('courseKey') courseKey: string): Promise<{
    stages: readonly Stage[];
    prerequisiteEdges: readonly PrerequisiteEdge[];
  }> {
    return this.partc.getStageTree(courseKey);
  }

  @Put('stages')
  @HttpCode(200)
  replaceStages(
    @Param('courseKey') courseKey: string,
    @Body() body: unknown,
  ): Promise<{
    stages: readonly Stage[];
    prerequisiteEdges: readonly PrerequisiteEdge[];
  }> {
    return this.partc.replaceStageTree(courseKey, body);
  }

  @Get('evidence-specs')
  listEvidenceSpecs(): Promise<EvidenceSpec[]> {
    return this.partc.listEvidenceSpecs();
  }

  @Put('evidence-specs/:evidenceKey')
  @HttpCode(200)
  putEvidenceSpec(
    @Param('courseKey') courseKey: string,
    @Param('evidenceKey') evidenceKey: string,
    @Body() body: unknown,
  ): Promise<EvidenceSpec> {
    return this.partc.putEvidenceSpec(courseKey, evidenceKey, body);
  }

  @Get('content-versions')
  listContentVersions(@Param('courseKey') courseKey: string) {
    return this.partc.listContentVersions(courseKey);
  }

  /**
   * P8 Restore：按冻结版本 pins 重建草稿。body =
   * `{contentVersionId} | {versionNo}`；缺资产/CATEGORY → 422 且草稿不变。
   */
  @Post('restore')
  @HttpCode(200)
  restore(@Param('courseKey') courseKey: string, @Body() body: unknown) {
    return this.partc.restoreContentVersion(courseKey, body);
  }

  /** 可观察面（E）：发布记录 / live 指针。 */
  @Get('publications')
  listPublications(@Param('courseKey') courseKey: string) {
    return this.partc.listPublications(courseKey);
  }

  @Get('publications/live')
  livePublication(@Param('courseKey') courseKey: string) {
    return this.partc.livePublication(courseKey);
  }

  /** 可观察面（E）：pc_content_spec / pc_rendition / pc_media_asset 只读投影。 */
  @Get('content-specs')
  listContentSpecs(@Param('courseKey') courseKey: string) {
    return this.partc.listContentSpecs(courseKey);
  }

  @Get('renditions')
  listRenditions(@Param('courseKey') courseKey: string) {
    return this.partc.listRenditions(courseKey);
  }

  @Get('media-assets')
  listMediaAssets(@Param('courseKey') courseKey: string) {
    return this.partc.listMediaAssets(courseKey);
  }

  @Get('alignments')
  listAlignments(@Param('courseKey') courseKey: string) {
    return this.partc.listAlignments(courseKey);
  }

  /**
   * 显式创建 proposed 对齐（D 缺陷）：body =
   * `{stageKey, renditionKey, objectiveKey, role}`；人指定绑定，机器不猜。
   * 写入 status=proposed / provenance=human，仍须走 sign-off 人签收。
   */
  @Post('alignments')
  createAlignment(
    @Param('courseKey') courseKey: string,
    @Body() body: unknown,
  ) {
    return this.partc.createProposedAlignment(courseKey, body);
  }

  /** 人签收：proposed → verified/rejected（verifiedAgainst 服务端派生）。 */
  @Post('alignments/:alignmentId/sign-off')
  @HttpCode(200)
  signOffAlignment(
    @Param('courseKey') courseKey: string,
    @Param('alignmentId') alignmentId: string,
    @Body() body: unknown,
    @Req() request: BackofficeRequest,
  ) {
    return this.partc.signOffAlignment(
      courseKey,
      alignmentId,
      body,
      request.employee?.employeeId ?? null,
    );
  }

  @Post('plans/preview')
  @HttpCode(200)
  previewPlan(@Param('courseKey') courseKey: string): Promise<PlanView> {
    return this.partc.previewPlan(courseKey);
  }

  @Post('plans/save')
  @HttpCode(200)
  savePlan(
    @Param('courseKey') courseKey: string,
    @Body() body: unknown,
  ): Promise<PlanView> {
    return this.partc.savePlan(courseKey, body);
  }

  @Post('plans/approve')
  @HttpCode(200)
  approvePlan(
    @Param('courseKey') courseKey: string,
    @Body() body: unknown,
    @Req() request: BackofficeRequest,
  ): Promise<{
    planId: string;
    planVersion: number;
    decision: 'approved' | 'rejected';
    status: string;
  }> {
    return this.partc.approvePlan(
      courseKey,
      body,
      request.employee?.employeeId ?? null,
    );
  }

  @Post('plans/apply')
  @HttpCode(200)
  applyPlan(
    @Param('courseKey') courseKey: string,
    @Body() body: unknown,
  ): Promise<ApplyResult> {
    return this.partc.applyPlan(courseKey, body);
  }

  @Post('plans/publish')
  @HttpCode(200)
  publishPlan(
    @Param('courseKey') courseKey: string,
    @Body() body: unknown,
  ): Promise<ApplyResult> {
    return this.partc.publishPlan(courseKey, body);
  }
}
