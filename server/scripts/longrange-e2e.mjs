#!/usr/bin/env node
/**
 * 长程真实测试 runner（计划 §3 的 7 步连续 scenario）。
 *
 * 做的事（按顺序、真实执行、输出命令结果）：
 *  1. 空库：DROP DATABASE ... WITH (FORCE) → CREATE DATABASE
 *  2. `npx prisma migrate deploy`（记录迁移数与退出码）
 *  3. `npx jest --config ./test/jest-e2e.json longrange-full-scenario --runInBand`
 *     （场景本体在 test/longrange-full-scenario.e2e-spec.ts，全部经 HTTP 观察）
 *
 * 用法：
 *   cd LearningGuideAdmin/server
 *   node scripts/longrange-e2e.mjs
 *
 * 环境变量：
 *  - DATABASE_URL  默认 postgresql://admin:admin@localhost:5432/learning_guide_e2e
 *  - LG_PORTAL_ROOT 默认 ../../LearningGuidePortal（学习事件 Route Handler 夹具）
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE_URL =
  process.env.DATABASE_URL?.trim() ||
  'postgresql://admin:admin@localhost:5432/learning_guide_e2e';

function log(step, message) {
  console.log(`[LR-RUNNER] ${step} ${message}`);
}

function targetDatabaseName(urlString) {
  const url = new URL(urlString);
  return decodeURIComponent(url.pathname.replace(/^\//, ''));
}

function adminUrlFor(urlString) {
  const url = new URL(urlString);
  url.pathname = '/postgres';
  return url.toString();
}

async function resetDatabase() {
  const dbName = targetDatabaseName(DATABASE_URL);
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
    throw new Error(`refusing to drop unsafe database name: ${dbName}`);
  }
  const admin = new Client({ connectionString: adminUrlFor(DATABASE_URL) });
  await admin.connect();
  try {
    log('step1', `dropping database ${dbName} (empty-db scenario)`);
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
    log('step1', `created empty database ${dbName}`);
  } finally {
    await admin.end();
  }
}

async function migrationCount() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(
      'SELECT count(*)::int8 AS count FROM _prisma_migrations',
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

async function main() {
  log('step0', `server root ${SERVER_ROOT}`);
  log('step0', `DATABASE_URL=${DATABASE_URL}`);

  await resetDatabase();

  log('step1', 'running: npx prisma migrate deploy');
  const migrate = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['prisma', 'migrate', 'deploy'],
    {
      cwd: SERVER_ROOT,
      env: { ...process.env, DATABASE_URL },
      stdio: 'inherit',
    },
  );
  if (migrate.status !== 0) {
    throw new Error(`prisma migrate deploy failed with exit ${migrate.status}`);
  }
  log('step1', `applied migrations=${await migrationCount()}`);

  log('step2', 'running: npx jest --config ./test/jest-e2e.json longrange-full-scenario --runInBand');
  const jest = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    [
      'jest',
      '--config',
      './test/jest-e2e.json',
      'longrange-full-scenario',
      '--runInBand',
      '--forceExit',
    ],
    {
      cwd: SERVER_ROOT,
      env: {
        ...process.env,
        DATABASE_URL,
        HEAVY_TASKS_INLINE: '1',
      },
      stdio: 'inherit',
    },
  );
  log('step-done', `jest exit=${jest.status}`);
  process.exit(jest.status ?? 1);
}

main().catch((error) => {
  console.error('[LR-RUNNER] failed:', error);
  process.exit(1);
});
