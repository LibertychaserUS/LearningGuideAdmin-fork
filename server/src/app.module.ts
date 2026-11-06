import { Logger, Module, ModuleMetadata, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AiModule } from './ai/ai.module';
import { HttpKnowledgeClient } from './ai/knowledge/http-knowledge.client';
import { HealthController } from './health/health.controller';
import { validateEnv } from './config/env.validation';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { BackofficeModule } from './backoffice/nest/backoffice.module';
import { CommerceCoursesModule } from './commerce-courses/commerce-courses.module';
import { BackofficeAccessGuard } from './backoffice/nest/backoffice-access.guard';
import { ALL_ROLES, type AppRole } from './app-roles';
import { KNOWLEDGE_CLIENT } from './ks/contract/knowledge-client';
import { KsModule } from './ks/ks.module';
import { PrismaKnowledgeClient } from './ks/prisma-knowledge.client';
import { HELPDESK_QA_SOURCE } from './contracts/helpdesk-qa';
import { HELPDESK_TRACE_SOURCE } from './contracts/helpdesk-trace';
import {
  HELPDESK_GAP_LABELLER,
  noGapLabeller,
} from './contracts/helpdesk-flywheel';
import { createModelGapLabeller } from './ai/helpdesk/flywheel/gap-labeller';
import { createModelCardRewriter } from './ai/helpdesk/card-rewriter';
import {
  HELPDESK_CARD_REWRITER,
  noCardRewriter,
} from './contracts/helpdesk-card-rewrite';
import { suggestModel } from './ai/helpdesk/helpdesk-suggest.service';
import { PiStepRunner } from './ai/helpdesk/workflow/pi-step-runner';
import { PrismaAgentEventLog } from './ai/helpdesk/trace/agent-event.store';
import { createTraceSource } from './ai/helpdesk/trace/trace-query';
import { PrismaService } from './prisma/prisma.service';
import { createPgHelpdeskQaSource } from './backoffice/modules/helpdesk/faqs/faqQaSource';
import type { FaqReleaseSnapshot } from './backoffice/modules/helpdesk/faqs/faqRelease';
import { HELPDESK_RELEASE_ANSWERER } from './contracts/helpdesk-release-eval';
import { createReleaseAnswerer } from './ai/helpdesk/release-answerer';
import {
  cachedFaqEmbedder,
  sharedFaqVectorSearch,
} from './backoffice/modules/helpdesk/faqs/faqVectors';
import { createPgEvalCacheStore } from './backoffice/modules/helpdesk/faqs/release-check/evalCacheStore';
import { helpdeskSwitch } from './contracts/helpdesk-defaults';

/**
 * Agent 读 KS 的方式：同进程起了 ks 角色、或没配 KS_BASE_URL 时直接读库；
 * 否则经 HTTP 调独立部署的 KS（docs/Engine_Split_Implementation.md）。
 */
function knowledgeProvider(roles: readonly AppRole[]): Provider {
  const baseUrl = process.env.KS_BASE_URL?.trim();
  if (roles.includes('ks') || !baseUrl) {
    return { provide: KNOWLEDGE_CLIENT, useClass: PrismaKnowledgeClient };
  }
  return {
    provide: KNOWLEDGE_CLIENT,
    useFactory: (config: ConfigService) => {
      new Logger('AppModule').log(`Agent 经 HTTP 读取 KS：${baseUrl}`);
      return new HttpKnowledgeClient({
        baseUrl,
        token: config.get<string>('KS_SERVICE_TOKEN')?.trim(),
        timeoutMs: Number(config.get<string>('KS_TIMEOUT_MS')) || undefined,
      });
    },
    inject: [ConfigService],
  };
}

function appModuleMetadata(roles: readonly AppRole[]): ModuleMetadata {
  const admin = roles.includes('admin');
  const agent = roles.includes('agent');
  const ks = roles.includes('ks');
  return {
    imports: [
      // 环境变量配置（开发文档 §7 Phase 2 第 6 项、§8）：全局可用，启动时校验 DATABASE_URL
      // 注：envFilePath 相对进程 cwd，须从 server/ 目录启动（npm run start / start:dev / start:prod）
      ConfigModule.forRoot({
        isGlobal: true,
        envFilePath: '.env',
        validate: validateEnv,
      }),
      // Prisma 客户端单例（§7 Phase 2 第 3 项）
      PrismaModule,
      // Knowledge System：员工编写（admin 角色）+ 给 Agent 的内部接口（ks 角色）
      // KsModule 内部导入 KnowledgeModule，提供 RAG 索引与向量检索能力
      KsModule.register({ authoring: admin, internalApi: ks }),
      // AI Tutor：员工配置与测试（admin 角色）+ 学员对话运行时（agent 角色）
      ...(admin || agent
        ? [
            AiModule.register({
              adminApi: admin,
              learnerApi: agent,
              knowledge: knowledgeProvider(roles),
              // Helpdesk 推荐的候选：读 BackOffice 的已发布 FAQ（同库直读，契约见 src/contracts）；
              // 有发布版本后只读那一版快照（faqQaSource.ts）
              helpdeskQa: {
                provide: HELPDESK_QA_SOURCE,
                useFactory: () => createPgHelpdeskQaSource(),
              },
            }),
          ]
        : []),
      // BackOffice 员工登录、账号与菜单级权限（PRD v1.1）；HelpDesk 工单与 FAQ 库
      // 「查看链路」读 Agent 的事件日志（同库直读，契约见 src/contracts/helpdesk-trace.ts）
      ...(admin
        ? [
            BackofficeModule.register({
              // 缺口挖掘给一组未解决的问题起话题、提一个学员口吻的问题（只做这个，从不写答案）：
              // Agent 的一次小模型调用（pi 工作流 + 守卫；没有 OPENROUTER_API_KEY 或测试里 = 不问模型）
              gapLabeller: {
                provide: HELPDESK_GAP_LABELLER,
                useFactory: () =>
                  process.env.NODE_ENV === 'test'
                    ? noGapLabeller
                    : createModelGapLabeller({
                        runner: new PiStepRunner(),
                        model: suggestModel,
                      }),
              },
              // 「AI 按指令改卡」：员工说怎么改，Helpdesk 的缺省模型改好给员工看（不保存）；没有 key 或测试里 = 不问模型
              cardRewriter: {
                provide: HELPDESK_CARD_REWRITER,
                useFactory: () =>
                  process.env.NODE_ENV === 'test'
                    ? noCardRewriter
                    : createModelCardRewriter({
                        runner: new PiStepRunner(),
                        model: suggestModel,
                      }),
              },
              // 发布前的真流程抽样检查（owner 2026-11-03）：线上聊天同一个 HelpdeskSuggestService，钉在候选版本上；
              // 测试里不组装（只跑检索检查、同步返回）。分层结果缓存（helpdesk_eval_stage_cache）缺省开，
              // HELPDESK_EVAL_CACHE=off 关；问句向量经缓存算，卡片向量与线上共用同一份内存索引
              ...(process.env.NODE_ENV === 'test'
                ? {}
                : {
                    releaseAnswerer: {
                      provide: HELPDESK_RELEASE_ANSWERER,
                      useFactory: () =>
                        createReleaseAnswerer({
                          runner: new PiStepRunner(),
                          ...(helpdeskSwitch(
                            process.env.HELPDESK_EVAL_CACHE,
                            true,
                          )
                            ? { cache: createPgEvalCacheStore() }
                            : {}),
                          qaFor: (version, snapshot) =>
                            createPgHelpdeskQaSource(
                              undefined,
                              undefined,
                              sharedFaqVectorSearch().withEmbedder?.(
                                cachedFaqEmbedder,
                              ),
                              {
                                version,
                                snapshot: snapshot as FaqReleaseSnapshot,
                              },
                            ),
                        }),
                    },
                  }),
              helpdeskTrace: {
                provide: HELPDESK_TRACE_SOURCE,
                useFactory: (prisma: PrismaService) =>
                  createTraceSource(new PrismaAgentEventLog(prisma)),
                inject: [PrismaService],
              },
            }),
          ]
        : []),
      // 商品课程 v2：课程管理 + 课程包导入导出 + Portal v1 投影（P1a）
      ...(admin ? [CommerceCoursesModule] : []),
    ],
    controllers: [AppController, HealthController],
    providers: [
      AppService,
      // 统一响应格式（§5.3、§7 Phase 2 第 4 项），SSE 流式接口豁免点见拦截器注释
      { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
      // 全局错误处理（§5.3、§7 Phase 2 第 5 项）
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      // 员工会话 + 菜单级权限；Portal 学员端 /api/user/** 仍走 X-API-Key（ApiKeyGuard 规则），
      // KS 内部接口 /api/ks/** 走 KS_SERVICE_TOKEN；Portal Helpdesk 集成 /api/integration/helpdesk/**
      // 走 ADMIN_HELPDESK_TOKEN
      { provide: APP_GUARD, useClass: BackofficeAccessGuard },
    ],
  };
}

/** 按角色组装的根模块；main.ts 依据 APP_ROLES 调用 */
export function createAppModule(roles: readonly AppRole[]) {
  @Module(appModuleMetadata(roles))
  class RoleScopedAppModule {}
  return RoleScopedAppModule;
}

/** 三个角色全开（拆分前的行为）；e2e 与默认部署使用 */
@Module(appModuleMetadata(ALL_ROLES))
export class AppModule {}
