import {
  isHelpdeskLocale,
  type FaqEdge,
  type FaqNode,
  type HelpdeskLocale,
} from '../../../../contracts/helpdesk-qa';
import { createPgCandidateRepository } from '../flywheel/candidateRepository';
import { HelpdeskError } from '../portalHelpdeskClient';
import type { FaqActor } from './faqContracts';
import { checkFaqGraph, type FaqGraphCheckResult } from './faqGraphChecks';
import {
  createPgFaqGraphRepository,
  type FaqGraphRepository,
  type FaqReleaseRow,
  type PublishReadiness,
  type FaqReleaseWithSnapshot,
} from './faqGraphRepository';
import {
  diffSnapshots,
  freezeSnapshot,
  publicRelease,
  snapshotHash,
  type FaqReleaseSnapshot,
  type FaqReleaseSource,
  type FaqSnapshotDiff,
  type PublishedFaqRelease,
} from './faqRelease';
import {
  createFaqReleaseGate,
  createRetrievalGate,
  type FaqReleaseEvalReport,
  type FaqReleaseGate,
} from './faqReleaseGate';
import { createPgFaqRepository } from './faqRepository';
import { uuidv7 } from '../../../../common/uuidv7';
import { createEnvFaqVectorIndexer, type FaqVectorIndexer } from './faqVectors';
import type { FaqCheckEstimate } from './release-check/estimate';

/**
 * FAQ 问题树的发布（helpdesk-v5-faq-graph-design §2.2）：
 * - 新建（「发布新版本」）：一致地读工作表 → 冻结快照（答案块此时切好）→ 图检查 → 写入版本（与它的
 *   检索行同一事务）→ 检查过了才跑评测门（状态 evaluating）→ 过 = draft（可以发布），不过 = rejected。
 *   工作表和最新的那个版本一模一样 → 不新建，原样返回那一版（幂等：重复点击、重试都只有一个版本）；
 * - 重新检查：对 draft / rejected / 卡在 evaluating 的版本再跑一次检查与评测门（快照不变）；
 * - 发布：只有 draft（检查与评测都过了）能发布；同一事务里旧的 → superseded、这一版 → published。
 *   已经是 published 的再发布一次直接成功（幂等）；
 * - 回滚：把一个曾经上线过的版本（published / superseded）的快照复制成新版本并立刻发布，历史不改写。
 *   快照当时已经过了评测门，所以不再跑评测（报告写明来源版本），但图检查照跑。当前上线的就是从
 *   这个版本回滚来的（或者就是这个版本）→ 原样返回（幂等）；
 * - 历史、单个版本、两个版本（或工作表）之间的差异、工作表的检查（树视图的内联警告）。
 */

function invalid(message: string): HelpdeskError {
  return new HelpdeskError(400, 'INVALID_INPUT', message);
}

function notFound(): HelpdeskError {
  return new HelpdeskError(
    404,
    'FAQ_RELEASE_NOT_FOUND',
    'FAQ release not found',
  );
}

/** 版本号参数：正整数。 */
function versionNumber(raw: unknown): number {
  const text = typeof raw === 'number' ? String(raw) : raw;
  if (typeof text !== 'string' || !/^\d{1,9}$/.test(text) || Number(text) < 1)
    throw invalid('version must be a positive integer');
  return Number(text);
}

function evalPassed(report: unknown): boolean {
  return (
    typeof report === 'object' &&
    report !== null &&
    (report as { passed?: unknown }).passed === true
  );
}

function baselineOf(report: unknown): number | null | undefined {
  if (typeof report !== 'object' || report === null) return undefined;
  if (!('baselineVersion' in report)) return undefined;
  const value = (report as { baselineVersion?: unknown }).baselineVersion;
  return typeof value === 'number' ? value : null;
}

/**
 * 能不能发布（publishedVersion = 现在上线的版本号，没有 → null）：
 * - not_ready：不是 draft，或图检查 / 评测门没过；
 * - stale：比上线的版本旧（发布它会悄悄丢掉更新的内容），或评测时对比的不是现在上线的那一版
 *   （recall 退步没跟它比过，要重新检查）。回滚版本不看后者（它不跑评测，立即发布）。
 */
export function releaseReadiness(
  release: FaqReleaseRow,
  publishedVersion: number | null,
): PublishReadiness {
  if (
    release.status !== 'draft' ||
    release.checks?.passed !== true ||
    !evalPassed(release.evalReport)
  )
    return 'not_ready';
  if (publishedVersion !== null && release.version < publishedVersion)
    return 'stale';
  const baseline = baselineOf(release.evalReport);
  if (
    release.sourceVersion === null &&
    baseline !== undefined &&
    baseline !== publishedVersion
  )
    return 'stale';
  return 'ok';
}

/** 能不能发布（列表里的 publishable）。 */
export function releaseReady(
  release: FaqReleaseRow,
  publishedVersion: number | null,
): boolean {
  return releaseReadiness(release, publishedVersion) === 'ok';
}

/** 后台检查：心跳这么久没动 → 「检查中断」（可以重新检查）。 */
export const EVAL_STALE_MS = 3 * 60_000;
/** 检查跑着时至少这么久写一次心跳（一个问题慢也不会被当成中断）。 */
export const EVAL_HEARTBEAT_MS = 30_000;

/** evaluating 的版本：running = 检查在跑；interrupted = 心跳停了（进程重启、部署打断）。 */
export type FaqReleaseEvaluation = {
  state: 'running' | 'interrupted';
  startedAt: string | null;
  progress: { stage: string; done: number; total: number } | null;
};

/** 列表 / 详情里的一个版本（不含快照；counts 来自检查结果）。 */
export type FaqReleaseSummary = FaqReleaseRow & {
  publishable: boolean;
  /** 只有 status = evaluating 时有。 */
  evaluation: FaqReleaseEvaluation | null;
};

export function evaluationOf(
  release: FaqReleaseRow,
  at: Date,
  staleMs = EVAL_STALE_MS,
): FaqReleaseEvaluation | null {
  if (release.status !== 'evaluating') return null;
  const beat = release.evalRun?.heartbeatAt
    ? Date.parse(release.evalRun.heartbeatAt)
    : null;
  return {
    state:
      beat !== null && at.getTime() - beat < staleMs
        ? 'running'
        : 'interrupted',
    startedAt: release.evalRun?.startedAt ?? null,
    progress: release.evalRun?.progress ?? null,
  };
}

/**
 * 「对话预览」（graph design §5.3）读到的图：与 Portal 读 faq-release/current 同一个投影（publicRelease：
 * 按语言挑字段、答案块、解析好的边文字），来源是工作副本（缺省）或某一个版本的快照。
 */
export type FaqGraphPreview = {
  source: 'working' | number;
  /** 当前上线的版本号；还没有任何发布 → null。 */
  published: number | null;
  locale: HelpdeskLocale;
  nodes: FaqNode[];
  edges: FaqEdge[];
};

export type CreateReleaseResult = {
  release: FaqReleaseSummary;
  /** false：工作表和最新的版本一样，没有新建。 */
  created: boolean;
};

/**
 * 已发布快照的只读来源（Portal 的 faq-release/current 与 Agent 的检索开关都用它）：每次读一下当前
 * 发布的版本号（一个索引查询），快照按版本号缓存在进程里（发布 / 回滚都会换版本号，所以不会读旧）。
 */
export function createPgFaqReleaseSource(
  graph: Pick<
    FaqGraphRepository,
    'published' | 'release'
  > = createPgFaqGraphRepository(),
): FaqReleaseSource & { publishedVersion(): Promise<number | null> } {
  // 按发布行的 id 缓存（版本号永不复用，id 更保险）
  let cache: { id: string; release: PublishedFaqRelease } | null = null;
  return {
    async publishedVersion() {
      return (await graph.published())?.version ?? null;
    },
    async current() {
      const head = await graph.published();
      if (!head) return null;
      if (cache?.id === head.id) return cache.release;
      const row = await graph.release(head.version);
      if (!row || row.id !== head.id) return null;
      cache = {
        id: head.id,
        release: {
          version: head.version,
          publishedAt: head.publishedAt,
          snapshot: row.snapshot,
        },
      };
      return cache.release;
    },
  };
}

export type FaqReleaseServiceOptions = {
  graph?: FaqGraphRepository;
  gate?: FaqReleaseGate;
  now?: () => Date;
  /**
   * true（生产）：新建与重新检查立刻返回 evaluating，检查在后台跑（真流程抽样要几分钟，HTTP 请求等不了）；
   * 缺省 false：等检查跑完再返回（单测、导入脚本）。
   */
  background?: boolean;
  /** 真流程抽样检查（faqReleaseModelGate.ts；生产由 backoffice.module 组装）。不给 = 只跑检索检查。 */
  modelGate?: FaqReleaseGate;
  /** 后台检查出了没接住的错（缺省记日志）。 */
  onBackgroundError?: (error: unknown) => void;
  staleMs?: number;
  heartbeatMs?: number;
  /** 新版本建好、发布之后给它算向量（不等、不影响结果；没配向量模型 = 什么都不做）。 */
  vectors?: FaqVectorIndexer;
};

export function createFaqReleaseService(
  options: FaqReleaseServiceOptions = {},
) {
  const graph = options.graph ?? createPgFaqGraphRepository();
  const now = options.now ?? (() => new Date());
  const vectors = options.vectors ?? createEnvFaqVectorIndexer();
  // 幂等，失败只记日志；下一次发布或 npm run helpdesk:faq-vectors 会补上
  const indexVectors = (version: number) => void vectors.index(version);
  const background = options.background ?? false;
  const staleMs = options.staleMs ?? EVAL_STALE_MS;
  const heartbeatMs = options.heartbeatMs ?? EVAL_HEARTBEAT_MS;
  const onBackgroundError =
    options.onBackgroundError ??
    ((error: unknown) =>
      console.error(
        '[helpdesk] FAQ release check failed:',
        error instanceof Error ? error.message : error,
      ));
  // 版本列表变了（开始 / 进度 / 结果 / 发布）：通知这个进程里开着的长连接（faqReleaseStream.ts）
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // 一个连接出错不影响别的
      }
    }
  };
  const summary = (
    release: FaqReleaseRow,
    publishedVersion: number | null,
  ): FaqReleaseSummary => ({
    ...release,
    publishable: releaseReady(release, publishedVersion),
    evaluation: evaluationOf(release, now(), staleMs),
  });
  const gate =
    options.gate ??
    createFaqReleaseGate({
      // 检索评测带上员工从数据飞轮接受过的回归用例（v5 Part G5）
      retrieval: createRetrievalGate(createPgFaqRepository(), now, {
        regressionCases: () => createPgCandidateRepository().evalCases(),
      }),
      model: options.modelGate,
      now,
    });

  async function workingSnapshot(): Promise<FaqReleaseSnapshot> {
    const { faqs, edges, phrasings, map } = await graph.working();
    return freezeSnapshot(faqs, edges, phrasings, map);
  }

  async function publishedRelease(): Promise<FaqReleaseWithSnapshot | null> {
    const head = await graph.published();
    return head ? graph.release(head.version) : null;
  }

  async function required(version: number): Promise<FaqReleaseWithSnapshot> {
    const found = await graph.release(version);
    if (!found) throw notFound();
    return found;
  }

  /**
   * 检查过了 → evaluating（新的 run）→ 评测门 → draft / rejected；检查没过 → rejected（不跑评测）。
   * background：开始之后立刻返回 evaluating 的那一行，评测门在后台跑；否则等它跑完。
   * 别的检查正在跑（心跳没停）→ 409，不重复跑、不重复花钱。
   */
  async function evaluate(
    release: FaqReleaseWithSnapshot,
    checks: FaqGraphCheckResult,
  ): Promise<FaqReleaseRow> {
    if (!checks.passed) {
      const report: FaqReleaseEvalReport = {
        kind: 'skipped',
        passed: false,
        summary: 'The graph checks failed, so the eval did not run',
        ranAt: now().toISOString(),
        metrics: {},
        misses: [],
      };
      const rejected = await graph.setStatus(
        release.version,
        ['draft', 'evaluating', 'rejected'],
        'rejected',
        report,
      );
      changed();
      return rejected ?? release;
    }
    const runId = uuidv7();
    const at = now();
    const started = await graph.startEval(
      release.version,
      ['draft', 'rejected'],
      runId,
      at,
      new Date(at.getTime() - staleMs),
    );
    if (!started)
      throw new HelpdeskError(
        409,
        'FAQ_RELEASE_EVALUATING',
        `v${release.version} is being checked right now; wait for the result`,
      );
    changed();
    const work = runEval(release, runId);
    if (background) {
      work.catch(onBackgroundError);
      return started;
    }
    return (await work) ?? started;
  }

  /** 跑评测门（一个 run）：定时心跳；结束时只有这个 run 还在才写结果（被顶替了就丢掉）。 */
  async function runEval(
    release: FaqReleaseWithSnapshot,
    runId: string,
  ): Promise<FaqReleaseRow | null> {
    const controller = new AbortController();
    const beat = () =>
      graph
        .evalHeartbeat(release.version, runId, now())
        .then((alive) => {
          if (!alive) controller.abort();
        })
        .catch(() => undefined);
    const timer = setInterval(() => void beat(), heartbeatMs);
    timer.unref?.();
    let report: FaqReleaseEvalReport;
    let baseline: FaqReleaseWithSnapshot | null = null;
    try {
      const previous = await publishedRelease();
      baseline =
        previous && previous.version !== release.version ? previous : null;
      report = {
        ...(await gate.evaluate({
          version: release.version,
          snapshot: release.snapshot,
          previous: baseline
            ? {
                version: baseline.version,
                evalReport: baseline.evalReport,
                snapshot: baseline.snapshot,
              }
            : null,
          signal: controller.signal,
          progress: async (progress) => {
            const alive = await graph
              .evalHeartbeat(release.version, runId, now(), progress)
              .catch(() => true);
            if (!alive) controller.abort();
            else changed();
            return alive;
          },
        })),
        baselineVersion: baseline?.version ?? null,
      };
    } catch (error) {
      report = {
        kind: 'skipped',
        passed: false,
        summary: `The eval could not run: ${error instanceof Error ? error.message.slice(0, 200) : 'error'}`,
        ranAt: now().toISOString(),
        metrics: {},
        misses: [],
        baselineVersion: baseline?.version ?? null,
      };
    } finally {
      clearInterval(timer);
    }
    const finished = await graph.finishEval(
      release.version,
      runId,
      report.passed ? 'draft' : 'rejected',
      report,
      now(),
    );
    changed();
    return finished;
  }

  async function publish(
    actor: FaqActor,
    version: number,
  ): Promise<FaqReleaseSummary> {
    const result = await graph.publish(
      version,
      releaseReadiness,
      actor.employeeId,
    );
    if (result.kind === 'not_found') throw notFound();
    if (result.kind === 'stale')
      throw new HelpdeskError(
        409,
        'FAQ_RELEASE_STALE',
        result.published !== null && result.release.version < result.published
          ? `v${result.release.version} is older than the live v${result.published}; create a new release or roll back instead`
          : `v${result.release.version} was evaluated against another live release; re-check it before publishing`,
      );
    if (result.kind === 'not_ready')
      throw new HelpdeskError(
        409,
        'FAQ_RELEASE_NOT_READY',
        result.release.status === 'draft'
          ? 'This release has not passed the graph checks and the eval'
          : `Only a release that passed the checks and the eval can be published (this one is ${result.release.status})`,
      );
    // published / already：这一版就是上线的
    indexVectors(result.release.version);
    changed();
    return summary(result.release, result.release.version);
  }

  async function liveVersion(): Promise<number | null> {
    return (await graph.published())?.version ?? null;
  }

  return {
    /** 订阅版本列表的变化（只在这个进程里；别的实例上的变化由长连接自己定时对数据库补上）。 */
    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async list(): Promise<{
      releases: FaqReleaseSummary[];
      published: number | null;
    }> {
      const releases = await graph.releases();
      const published =
        releases.find((release) => release.status === 'published')?.version ??
        null;
      return {
        releases: releases.map((release) => summary(release, published)),
        published,
      };
    },

    async get(rawVersion: unknown): Promise<FaqReleaseSummary> {
      const { snapshot: _snapshot, ...release } = await required(
        versionNumber(rawVersion),
      );
      void _snapshot;
      return summary(release, await liveVersion());
    },

    /** 「发布新版本」页面：工作表的检查与它和当前发布版本的差异（什么都不写）。 */
    async working(): Promise<{
      checks: FaqGraphCheckResult;
      diff: FaqSnapshotDiff;
      published: number | null;
      /** 「发布新版本」之前：真流程检查要问几道、估计几道真付钱、约多少钱；没有真流程检查 → null。 */
      estimate: FaqCheckEstimate | null;
    }> {
      const [snapshot, published] = await Promise.all([
        workingSnapshot(),
        publishedRelease(),
      ]);
      // 估计失败不影响页面（只是不显示估计）
      const estimate =
        (await gate
          .estimate?.({
            snapshot,
            previous: published
              ? {
                  version: published.version,
                  evalReport: published.evalReport,
                  snapshot: published.snapshot,
                }
              : null,
          })
          .catch(() => null)) ?? null;
      return {
        checks: checkFaqGraph(snapshot),
        diff: diffSnapshots(published?.snapshot ?? null, snapshot),
        published: published?.version ?? null,
        estimate,
      };
    },

    /** 对话预览：工作副本（version 缺省）或某个版本的快照，按 Portal 的样子投影成一种语言（什么都不写）。 */
    async preview(
      rawLocale: unknown,
      rawVersion?: unknown,
    ): Promise<FaqGraphPreview> {
      if (!isHelpdeskLocale(rawLocale))
        throw invalid('locale must be en-GB or zh-CN');
      const working =
        rawVersion === undefined ||
        rawVersion === '' ||
        rawVersion === 'working';
      const [release, published] = await Promise.all([
        working ? null : required(versionNumber(rawVersion)),
        graph.published(),
      ]);
      const snapshot = release ? release.snapshot : await workingSnapshot();
      const { nodes, edges } = publicRelease(
        { version: release?.version ?? 1, publishedAt: '', snapshot },
        rawLocale,
      );
      return {
        source: release ? release.version : 'working',
        published: published?.version ?? null,
        locale: rawLocale,
        nodes,
        edges,
      };
    },

    /**
     * 两个版本之间的差异。head = 版本号（缺省：工作表，即 'working'）；base = 版本号（缺省：当前发布的；
     * head 自己就是发布的那一版时，缺省是它的前一个版本）。
     */
    async diff(
      rawHead: unknown,
      rawBase?: unknown,
    ): Promise<{
      base: number | null;
      head: number | 'working';
      diff: FaqSnapshotDiff;
    }> {
      const working =
        rawHead === undefined || rawHead === '' || rawHead === 'working';
      const head = working ? null : await required(versionNumber(rawHead));
      const headSnapshot = head ? head.snapshot : await workingSnapshot();
      let base: FaqReleaseWithSnapshot | null;
      if (rawBase !== undefined && rawBase !== '')
        base = await required(versionNumber(rawBase));
      else {
        base = await publishedRelease();
        if (base && head && base.version === head.version)
          base =
            head.version > 1 ? await graph.release(head.version - 1) : null;
      }
      return {
        base: base?.version ?? null,
        head: head?.version ?? 'working',
        diff: diffSnapshots(base?.snapshot ?? null, headSnapshot),
      };
    },

    /** 冻结工作表成新版本，跑检查与评测门；工作表与最新版本一样 → 不新建。 */
    async create(actor: FaqActor): Promise<CreateReleaseResult> {
      const snapshot = await workingSnapshot();
      const checks = checkFaqGraph(snapshot);
      // 和最新的版本、或当前发布的版本一模一样 → 没有改动，不新建（在仓库的锁里判断）
      const { release: inserted, created } = await graph.insertRelease({
        snapshot,
        snapshotHash: snapshotHash(snapshot),
        checks,
        status: 'draft',
        evalReport: null,
        sourceVersion: null,
        employeeId: actor.employeeId,
        dedupe: true,
      });
      if (!created)
        return {
          release: summary(inserted, await liveVersion()),
          created: false,
        };
      indexVectors(inserted.version);
      const evaluated = await evaluate({ ...inserted, snapshot }, checks);
      return {
        release: summary(evaluated, await liveVersion()),
        created: true,
      };
    },

    /** 对 draft / rejected / 检查中断的版本重跑检查与评测门（快照不变；正在检查的 → 409）。 */
    async check(rawVersion: unknown): Promise<FaqReleaseSummary> {
      const release = await required(versionNumber(rawVersion));
      if (release.status === 'published' || release.status === 'superseded')
        throw new HelpdeskError(
          409,
          'FAQ_RELEASE_LOCKED',
          'This release has already been published; create a new one instead',
        );
      if (release.sourceVersion !== null)
        throw new HelpdeskError(
          409,
          'FAQ_RELEASE_LOCKED',
          'A rollback release is not re-evaluated',
        );
      const evaluated = await evaluate(
        release,
        checkFaqGraph(release.snapshot),
      );
      return summary(evaluated, await liveVersion());
    },

    publish(actor: FaqActor, rawVersion: unknown): Promise<FaqReleaseSummary> {
      return publish(actor, versionNumber(rawVersion));
    },

    /** 回滚到一个曾经上线过的版本：复制成新版本并立刻发布。 */
    async rollback(
      actor: FaqActor,
      rawVersion: unknown,
    ): Promise<CreateReleaseResult> {
      const target = await required(versionNumber(rawVersion));
      if (target.status !== 'published' && target.status !== 'superseded')
        throw new HelpdeskError(
          409,
          'FAQ_RELEASE_NOT_PUBLISHED',
          'Only a release that was published before can be rolled back to',
        );
      const current = await publishedRelease();
      if (
        current &&
        (current.version === target.version ||
          current.sourceVersion === target.version)
      )
        return { release: summary(current, current.version), created: false };
      const checks = checkFaqGraph(target.snapshot);
      if (!checks.passed)
        throw new HelpdeskError(
          409,
          'FAQ_RELEASE_CHECKS_FAILED',
          'That release no longer passes the graph checks',
        );
      const report: FaqReleaseEvalReport = {
        kind: 'rollback',
        passed: true,
        summary: `Rollback to v${target.version}: the snapshot passed the eval when v${target.version} was created`,
        ranAt: now().toISOString(),
        metrics: {},
        misses: [],
        sourceVersion: target.version,
        sourceReport: target.evalReport,
      };
      const { release: inserted } = await graph.insertRelease({
        snapshot: target.snapshot,
        snapshotHash: target.snapshotHash,
        checks,
        status: 'draft',
        evalReport: report,
        sourceVersion: target.version,
        employeeId: actor.employeeId,
        dedupe: false,
      });
      return { release: await publish(actor, inserted.version), created: true };
    },
  };
}

export type FaqReleaseService = ReturnType<typeof createFaqReleaseService>;
