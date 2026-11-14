import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  COMMERCE_CONFIG,
  commerceConfig,
  type CommerceCourseConfig,
} from './commerce.config';
import { CourseStorageService } from './storage.service';
import { CommerceCoursesService } from './commerce-courses.service';
import { CommerceCoursesController } from './commerce-courses.controller';
import { PackageInspector } from './package-inspector';
import { PackageImporter } from './package-importer';
import { PackageJobsService } from './package-jobs.service';
import { PackageWorker } from './package-worker';
import { PortalProjectionService } from './portal-projection.service';
import { PortalCoursesController } from './portal-courses.controller';
import { PortalPreviewService } from './portal-preview.service';
import { PublishingService } from './publishing.service';
import { TrialService } from './trial.service';
import { PricingService } from './pricing.service';
import { PreviewService } from './preview.service';
import { OperationsService } from './operations.service';
import { OperationsController } from './operations.controller';
import { EnvironmentController } from './environment.controller';
import { CourseAuthoringService } from './course-authoring.service';
import { MediaUploadService } from './media-upload.service';
import { DraftRevisionInterceptor } from './draft-revision';
import { CourseCapabilityGuard } from './course-capability.guard';
import { PartcAdminController } from '../partc/api/partc-admin.controller';
import { PartcAdminService } from '../partc/api/partc-admin.service';
import { PartcAdminRepository } from '../partc/api/partc-admin.repository';

/**
 * 商品课程 v2（Commerce Course）：课程管理、课程包导入/导出、Portal v1 投影。
 * P1b：Draft → Publish → Version、History、Operations、Stripe、学员预览。
 * Part C 管理端（阶段树/证据规格/plan 生命周期）挂在 courses/:courseKey/partc。
 */
@Module({
  controllers: [
    CommerceCoursesController,
    PortalCoursesController,
    OperationsController,
    EnvironmentController,
    PartcAdminController,
  ],
  providers: [
    {
      provide: COMMERCE_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => commerceConfig(config),
    },
    CourseStorageService,
    {
      provide: PackageInspector,
      inject: [COMMERCE_CONFIG, CourseStorageService],
      useFactory: (
        config: CommerceCourseConfig,
        storage: CourseStorageService,
      ) => new PackageInspector(config, storage),
    },
    PackageImporter,
    PublishingService,
    DraftRevisionInterceptor,
    PricingService,
    TrialService,
    PreviewService,
    OperationsService,
    PackageJobsService,
    PackageWorker,
    CommerceCoursesService,
    CourseAuthoringService,
    MediaUploadService,
    PortalProjectionService,
    PortalPreviewService,
    CourseCapabilityGuard,
    PartcAdminRepository,
    PartcAdminService,
  ],
})
export class CommerceCoursesModule {}
