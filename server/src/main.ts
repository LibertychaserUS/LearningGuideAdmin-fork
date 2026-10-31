import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { readFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createAppModule } from './app.module';
import { learnerApiOpenWarning, parseAppRoles } from './app-roles';
import { configureApp } from './common/app-setup';
import { accessLog } from './common/access-log';
import {
  readBuildVersion,
  registerMissingAssetRoute,
  registerVersionRoute,
  setNoStore,
  withBuildMeta,
} from './common/build-version';

/**
 * 单服务发布：只要构建产物里带着 client/dist，就由本服务直接提供 BackOffice 前端，
 * 不再需要 S3 + CloudFront 的静态站点，也没有第二个“前端服务器”。
 */
function serveBackOfficeUi(app: NestExpressApplication) {
  const clientDir =
    process.env.CLIENT_DIST_DIR?.trim() ||
    resolve(__dirname, '../../client/dist');
  const indexFile = join(clientDir, 'index.html');
  if (!existsSync(indexFile)) {
    Logger.warn(`未找到前端构建产物：${clientDir}，仅提供 API`, 'Bootstrap');
    return;
  }
  // 带 hash 的静态资源可长期缓存；入口 HTML 必须每次回源，且不落任何缓存（浏览器与 CDN）。
  app.useStaticAssets(clientDir, {
    index: false,
    maxAge: 31_536_000_000,
    immutable: true,
    setHeaders: (res: any, filePath: string) => {
      if (basename(filePath) === 'index.html') setNoStore(res);
    },
  });
  const express = app.getHttpAdapter().getInstance();
  // 必须在 SPA 回退路由之前注册，否则 /version.json 会被前端回退先吃掉。
  const buildVersion = readBuildVersion(clientDir);
  const indexHtml = withBuildMeta(readFileSync(indexFile, 'utf8'), buildVersion);
  registerVersionRoute(express, buildVersion);
  // 静态目录里没有的资源回 404，绝不回 index.html（否则浏览器把 HTML 当脚本，白屏）。
  registerMissingAssetRoute(express);
  express.get(/^\/(?!api(?:\/|$)|health$).*/, (_req, res: any) => {
    setNoStore(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(indexHtml);
  });
  Logger.log(
    `前端由本服务提供：${clientDir}（构建 ${buildVersion ?? 'unknown'}）`,
    'Bootstrap',
  );
}

async function bootstrap() {
  // 同一镜像按 APP_ROLES 只起需要的部分（admin / agent / ks），不设时全部启动
  const roles = parseAppRoles(process.env.APP_ROLES);
  const app = await NestFactory.create<NestExpressApplication>(
    createAppModule(roles),
  );
  Logger.log(`启动角色：${roles.join(', ')}`, 'Bootstrap');
  // 发布时的 SIGTERM：先跑各模块的停机钩子（写完 Helpdesk 推荐的事件日志、关连接池）再退出
  app.enableShutdownHooks();
  // 不改行为、不阻止启动：只把漏配醒目地写进日志，便于上线检查发现
  const openLearnerApi = learnerApiOpenWarning(process.env, roles);
  if (openLearnerApi) Logger.error(openLearnerApi, 'Bootstrap');
  // 2026-10-28 复盘 A4：成功的请求也要留痕，否则跨服务调用无法取证。
  app.use(accessLog);
  // App Runner 前有一层代理：只信任最近一跳的 X-Forwarded-For，限流与审计用的 IP 不可被客户端伪造
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
  // /api 全局前缀 + 输入校验（§5.1、§9.3），与 e2e 共用同一设置
  configureApp(app);
  if (roles.includes('admin')) serveBackOfficeUi(app);
  // PORT 经 ConfigService 读取，缺省 3000（开发文档 §7 Phase 2 第 6 项、§8）
  const configService = app.get(ConfigService);
  const port = Number(configService.get<string>('PORT') ?? 3000);
  const server = await app.listen(port);
  // 大文件上传（课程包/原始素材可达数百 MB）放宽 Node HTTP 超时，
  // 避免慢速上传被默认 requestTimeout/headersTimeout 提前中断（表现为浏览器 “Error: aborted”）。
  if (server && typeof server === 'object') {
    const httpServer = server as unknown as {
      requestTimeout?: number;
      headersTimeout?: number;
      keepAliveTimeout?: number;
      timeout?: number;
    };
    httpServer.requestTimeout = 0;
    httpServer.headersTimeout = 120_000;
    httpServer.keepAliveTimeout = 120_000;
    httpServer.timeout = 0;
  }
}

// 启动失败（如 DATABASE_URL 缺失）时明确报错并退出进程
bootstrap().catch((err: unknown) => {
  Logger.error(
    `服务启动失败: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
