import { existsSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { runImportTask } from './import-worker';

/**
 * 在独立 worker 线程里执行导入阶段的 CPU 重活（原始素材转换、课程包解压校验），
 * 避免 165MB 级 ZIP 的同步解压/重打包阻塞事件循环导致 App Runner 健康检查失败 → 502。
 *
 * B7（测试可运行性）：ts-jest / ts-node 直接跑源码时 `__dirname` 下没有
 * `import-worker.js`（只有 nest build 后的 dist 才有）。此时自动回退到进程内执行；
 * `HEAVY_TASKS_INLINE=1` 亦可强制进程内执行。测试与 CI 与生产走同一入口。
 */
export function runImportWorker<T = unknown>(
  task: 'raw' | 'inspect',
  payload: Record<string, unknown>,
): Promise<T> {
  const workerPath = path.join(__dirname, 'import-worker.js');
  const inline =
    process.env.HEAVY_TASKS_INLINE === '1' || !existsSync(workerPath);
  if (inline) return runImportTask(task, payload) as Promise<T>;

  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: { task, payload },
    });
    let settled = false;
    worker.once(
      'message',
      (msg: {
        ok: boolean;
        result?: unknown;
        error?: string;
        validation?: { code: string; report: unknown };
      }) => {
        settled = true;
        if (msg.ok) resolve(msg.result as T);
        else {
          const failure = new Error(
            msg.error ?? 'import worker failed',
          ) as Error & {
            code?: string;
            report?: unknown;
          };
          if (msg.validation) {
            failure.code = msg.validation.code;
            failure.report = msg.validation.report;
          }
          reject(failure);
        }
        void worker.terminate();
      },
    );
    worker.once('error', (err) => {
      if (!settled) reject(err instanceof Error ? err : new Error(String(err)));
    });
    worker.once('exit', (code) => {
      if (!settled && code !== 0)
        reject(new Error(`import worker exited with code ${code}`));
    });
  });
}
