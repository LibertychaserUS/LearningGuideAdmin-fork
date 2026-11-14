import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildPackageFromRawZip } from './excel-package';
import { PackageInspector, PackageValidationError } from './package-inspector';
import type { CommerceCourseConfig } from './commerce.config';

interface WorkerInput {
  task: 'raw' | 'inspect';
  payload: Record<string, unknown>;
}

async function runRaw(payload: Record<string, unknown>) {
  const rawPath = String(payload.rawPath);
  const outPath = String(payload.outPath);
  const buf = await fs.readFile(rawPath);
  const courseCode =
    typeof payload.courseCode === 'string' ? payload.courseCode : undefined;
  const slug = typeof payload.slug === 'string' ? payload.slug : undefined;
  const built = await buildPackageFromRawZip(buf, { courseCode, slug });
  await fs.writeFile(outPath, built.bytes);
  return {
    warnings: built.warnings,
    courseCode: built.courseCode,
    slug: built.slug,
    title: built.title,
    lessonCount: built.lessonCount,
    mediaCount: built.mediaCount,
  };
}

async function runInspect(payload: Record<string, unknown>) {
  const packagePath = String(payload.packagePath);
  const outDir = String(payload.outDir);
  const config = payload.config as CommerceCourseConfig;
  const buf = await fs.readFile(packagePath);
  // inspector 仅用 config + 静态 sha256，不需要真实 storage 实例
  const inspector = new PackageInspector(config, {} as unknown as never);
  const { manifest, files, report } = await inspector.inspect(buf);
  const persisted: string[] = [];
  for (const [name, bytes] of files) {
    if (name === 'manifest.json' || name === 'checksums.sha256') continue;
    const target = path.join(outDir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    persisted.push(name);
  }
  return { manifest, report, files: persisted };
}

export interface ImportWorkerTaskResultMap {
  raw: {
    warnings: string[];
    courseCode: string;
    slug: string;
    title: string;
    lessonCount: number;
    mediaCount: number;
  };
  inspect: unknown;
}

/**
 * 执行一个导入任务（worker 线程与进程内共用同一实现，B7）。
 * `raw` 的返回形状见 ImportWorkerTaskResultMap；`inspect` 返回
 * `{ manifest, report, files }`。
 */
export async function runImportTask(
  task: WorkerInput['task'],
  payload: Record<string, unknown>,
): Promise<unknown> {
  return task === 'raw' ? runRaw(payload) : runInspect(payload);
}

async function main() {
  // 主线程 import 本模块时只导出 runImportTask，不执行任务（B7 进程内回退）。
  if (isMainThread) return;
  const input = workerData as WorkerInput;
  try {
    const result = await runImportTask(input.task, input.payload);
    parentPort?.postMessage({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 校验类错误带结构化报告（C5 job report 必须有错误码）；worker 边界显式携带。
    const validation =
      error instanceof PackageValidationError
        ? { code: error.code, report: error.report }
        : undefined;
    parentPort?.postMessage({ ok: false, error: message, validation });
  }
}

void main();
