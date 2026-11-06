import { createHash } from 'node:crypto';

import {
  addAskStats,
  emptyAskStats,
  type EvalAskStats,
  type EvalCacheMode,
} from '../../../../../contracts/helpdesk-eval-cache';
import type {
  ReleaseEvalAnswer,
  ReleaseEvalSession,
} from '../../../../../contracts/helpdesk-release-eval';
import {
  scoreModelAnswer,
  type EvalQuestion,
  type ModelEvalScore,
} from './questions';

/**
 * 发布前检查的跑题器（release check v2）：每题同时问候选版本与上线版本（逐题对比；上线版本的答案几乎
 * 全在缓存里，不再花钱），然后：
 * - 复问：候选版本出了错卡、上线版本这题没错（新出的错）→ 不用缓存再问 reaskTimes 次，
 *   至少 reaskConfirm 次（含第一次）都错才算真的变差（模型偶尔抖一下不冤枉卡片）；
 * - 漂移抽查：从命中缓存的题里按 (题号, 版本) 的哈希挑 driftSample 道，不读缓存重问一遍（写回新结果），
 *   结果和缓存给的不一样的超过 driftMax 道 → 缓存可能过期，这次检查不算数。
 * 花费到 budgetUsd 就停；被顶替（progress 返回 false / signal）就停。
 */
export type RunLimits = {
  concurrency: number;
  budgetUsd: number;
  reaskTimes: number;
  reaskConfirm: number;
  /** 至多复问这么多道（新出的错再多也是坏了，不必每道都确认）。 */
  reaskMax: number;
  driftSample: number;
  progressEvery: number;
};

export type AskRecord = {
  q: EvalQuestion;
  got: ReleaseEvalAnswer;
  score: ModelEvalScore;
};

export type QuestionResult = {
  q: EvalQuestion;
  candidate: AskRecord;
  live: AskRecord | null;
  /** 新出的错：复问几次里错了几次（含第一次）；不是新出的错 = null。 */
  reasked: { wrong: number; of: number } | null;
};

export type RunResult = {
  results: QuestionResult[];
  planned: number;
  stopped: null | 'budget' | 'replaced';
  spend: {
    total: number;
    model: number;
    rerank: number;
    embed: number;
    /** 候选版本 / 上线版本 / 复问与漂移抽查各花多少。 */
    candidate: number;
    live: number;
    checks: number;
  };
  unpricedCalls: number;
  cache: EvalAskStats;
  drift: { checked: number; changed: number; ids: string[] };
};

type Progress = (done: number, total: number) => Promise<boolean | void>;

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** 并发跑一串任务；shouldStop 为真就不再开新任务（已开的跑完）。 */
async function pool<T>(
  items: readonly T[],
  concurrency: number,
  shouldStop: () => boolean,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (!shouldStop() && next < items.length) await work(items[next++]);
  };
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, () => worker()),
  );
}

const sameAnswer = (a: ReleaseEvalAnswer, b: ReleaseEvalAnswer) =>
  a.kind === b.kind &&
  a.nodeId === b.nodeId &&
  (a.more ?? []).join() === (b.more ?? []).join();

const anyHit = (stats: EvalAskStats | undefined) =>
  stats !== undefined &&
  (stats.step.hits > 0 || stats.rerank.hits > 0 || stats.embed.hits > 0);

export async function runReleaseQuestions(input: {
  questions: readonly EvalQuestion[];
  candidate: ReleaseEvalSession;
  live: ReleaseEvalSession | null;
  version: number;
  limits: RunLimits;
  signal?: AbortSignal;
  progress?: Progress;
}): Promise<RunResult> {
  const { limits } = input;
  const spend = {
    total: 0,
    model: 0,
    rerank: 0,
    embed: 0,
    candidate: 0,
    live: 0,
    checks: 0,
  };
  const cache = emptyAskStats();
  let unpricedCalls = 0;
  let stopped: RunResult['stopped'] = null;
  const shouldStop = () => {
    if (stopped) return true;
    if (input.signal?.aborted) stopped = 'replaced';
    else if (spend.total >= limits.budgetUsd) stopped = 'budget';
    return stopped !== null;
  };
  const ask = async (
    session: ReleaseEvalSession,
    q: EvalQuestion,
    mode: EvalCacheMode,
    bucket: 'candidate' | 'live' | 'checks',
  ): Promise<AskRecord> => {
    const got = await session.ask({
      message: q.message,
      locale: q.locale,
      signal: input.signal,
      cache: mode,
      ...(q.screen
        ? {
            screen: {
              nodeId: q.screen.nodeId,
              recentTurns: q.screen.recentTurns,
            },
          }
        : {}),
    });
    spend.total += got.costUsd;
    spend[bucket] += got.costUsd;
    spend.model += got.spend?.model ?? got.costUsd;
    spend.rerank += got.spend?.rerank ?? 0;
    spend.embed += got.spend?.embed ?? 0;
    unpricedCalls += got.unpricedCalls;
    if (got.cache) addAskStats(cache, got.cache);
    return { q, got, score: scoreModelAnswer(q, got) };
  };

  let total = input.questions.length;
  let done = 0;
  const tick = async () => {
    done += 1;
    if (done % limits.progressEvery === 0 || done === total) {
      const alive = await input.progress?.(done, total);
      if (alive === false) stopped = 'replaced';
    }
  };
  await input.progress?.(0, total);

  // 1. 每题问两个版本
  const results: QuestionResult[] = [];
  await pool(input.questions, limits.concurrency, shouldStop, async (q) => {
    const [candidate, live] = await Promise.all([
      ask(input.candidate, q, 'use', 'candidate'),
      input.live ? ask(input.live, q, 'use', 'live') : Promise.resolve(null),
    ]);
    results.push({ q, candidate, live, reasked: null });
    await tick();
  });

  // 2. 新出的错：不用缓存再问几次
  const newlyWrong = results
    .filter(
      (r) =>
        r.candidate.score.wrongCard &&
        r.live !== null &&
        !r.live.score.wrongCard &&
        !r.live.score.error,
    )
    .slice(0, limits.reaskMax);
  total += newlyWrong.length * limits.reaskTimes;
  await pool(newlyWrong, limits.concurrency, shouldStop, async (r) => {
    let wrong = 1;
    for (let i = 0; i < limits.reaskTimes && !shouldStop(); i += 1) {
      const again = await ask(input.candidate, r.q, 'bypass', 'checks');
      if (again.score.wrongCard) wrong += 1;
      await tick();
    }
    r.reasked = { wrong, of: 1 + limits.reaskTimes };
  });

  // 3. 漂移抽查：命中缓存的题里挑几道，不读缓存重问
  const drift = { checked: 0, changed: 0, ids: [] as string[] };
  const sample = results
    .filter((r) => !r.candidate.score.error && anyHit(r.candidate.got.cache))
    .sort((a, b) => {
      const x = sha(`${a.q.id}:${input.version}`);
      const y = sha(`${b.q.id}:${input.version}`);
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .slice(0, limits.driftSample);
  total += sample.length;
  await pool(sample, limits.concurrency, shouldStop, async (r) => {
    const fresh = await ask(input.candidate, r.q, 'refresh', 'checks');
    if (!fresh.score.error) {
      drift.checked += 1;
      if (!sameAnswer(fresh.got, r.candidate.got)) {
        drift.changed += 1;
        drift.ids.push(r.q.id);
      }
    }
    await tick();
  });

  results.sort((a, b) => (a.q.id < b.q.id ? -1 : a.q.id > b.q.id ? 1 : 0));
  return {
    results,
    planned: input.questions.length,
    stopped,
    spend,
    unpricedCalls,
    cache,
    drift,
  };
}
