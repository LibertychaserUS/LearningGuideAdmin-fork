import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { startTrace } from '../../../../common/traceparent';
import { isUuid, uuidv7 } from '../../../../common/uuidv7';
import type { SqlClient, SqlDb } from '../faqs/faqRepository';
import { HelpdeskError } from '../portalHelpdeskClient';

/**
 * Helpdesk FAQ 写入流水线（设计文档「后端架构：接口、编排与中间件」，2026-11-09）。
 *
 * 所有写卡库的入口（BackOffice、OKF 导入、飞轮接受、种子……）都把一次写入当成一个有名字的命令交给这里；
 * 横切的事只在这里做一次，顺序只在 PIPELINE 里声明一次：
 *   1 追踪（W3C traceparent）→ 2 执行者 → 3 修改上下文（change_id、起因）→ 4 幂等快路径 →
 *   5 解析与校验（一次报全）→ 6 工作单元：BEGIN、设本事务的 change_id、库级锁、处理器、
 *     按修订表数出改了什么、helpdesk_faq_changes 一行、幂等记录、pg_notify、COMMIT → 7 结构化日志。
 * 处理器只拿到绑在这一个事务上的 db：它照常用已有的仓库和服务（它们的 withTransaction 在这里变成「就用
 * 这个事务」），所以一个命令里改多少张卡、多少条边都在同一个事务里，要么全写进去，要么一行不留。
 *
 * 改了什么不由处理器自己报：每次写入都会落一行修订，修订的 change_id 缺省就是本事务的改动号，
 * 所以提交前按改动号数一遍各修订表就是事实。一行修订都没有 = 什么都没改（PUT 内容相同、边已存在），
 * 不记改动、不发通知。
 * 提交后的通知只有一条路：pg_notify。每个实例（包括发出它的这个）都用 LISTEN 收，不另设进程内回调。
 */

export const FAQ_CHANGE_CAUSES = [
  'ui',
  'import',
  'flywheel',
  'rewrite',
  'seed',
  'release',
  'system',
] as const;
export type FaqChangeCause = (typeof FAQ_CHANGE_CAUSES)[number];

/** 谁在写：员工 human:<id>、程序 process:<名字>、AI 工具 <工具>/<版本>（与 OKF 的 actor 写法相同）。 */
export type CommandActor = {
  employeeId: string | null;
  /** 不给 = 由 employeeId 推出 human:<id>；没有员工时必须给。 */
  label?: string;
};

export type CommandMeta = {
  actor: CommandActor;
  cause: { kind: FaqChangeCause; ref?: string | null; note?: string | null };
  /** 走流水线幂等的命令才看（UUID）。 */
  idempotencyKey?: string | null;
  traceparent?: string | null;
};

/** 绑在这一个事务上的 db：query 走这条连接，withTransaction 直接用这条连接（不再开新事务）。 */
export function transactionDb(client: SqlClient): SqlDb {
  return {
    query: async (sql, params) =>
      (await client.query(sql, params ? [...params] : undefined)).rows,
    withTransaction: (fn) => fn(client),
  };
}

export type CommandContext = {
  readonly command: string;
  readonly changeId: string;
  readonly actor: Required<CommandActor>;
  readonly cause: CommandMeta['cause'];
  readonly traceId: string;
  /** 只在工作单元里有：绑在本事务上的 db。 */
  db: SqlDb;
};

export type FaqCommand<I, O> = {
  readonly name: string;
  /**
   * 库级锁：shared = 只动几张卡的普通写入（彼此不挡）；exclusive = 整库的写入（导入、发布冻结），
   * 进行时普通写入排队等它做完，不会混进去。
   */
  readonly lock: 'shared' | 'exclusive';
  /** true：Idempotency-Key 由流水线处理（同键同请求原样返回，同键不同请求 422）。 */
  readonly idempotent?: boolean;
  /** 原样的输入 → 带类型的输入；有问题抛 HelpdeskError（400/422，消息里列全）。 */
  parse(raw: unknown): I;
  run(input: I, ctx: CommandContext): Promise<O>;
};

export type CommandOutcome<O> = {
  result: O;
  /** null = 这次什么都没改（没落下任何修订），所以没有改动记录。 */
  changeId: string | null;
  /** true = 同一个幂等键的重放，没有再写。 */
  replayed: boolean;
};

/** 库级锁的两个键（与飞轮任务 719320、Portal 719310 不同号）。 */
export const FAQ_LIBRARY_LOCK: readonly [number, number] = [719330, 1];
/**
 * 改动记录的尾锁：写 helpdesk_faq_changes 之前拿，提交时放。它让 seq 的先后 = 提交的先后，
 * 按 seq 往后读的消费者不会漏掉「号小、提交晚」的一行。只罩住事务最后几条语句，排队很短。
 */
export const FAQ_CHANGE_LOG_LOCK: readonly [number, number] = [719330, 2];

/**
 * 每张修订表 = 一种改动（迁移 20261109000000 给它们加了 change_id，缺省取本事务的改动号）。
 * 新的修订表要加进来，测试会对照数据库里所有带 change_id 的表。
 */
export const REVISION_TABLES = {
  cards: 'helpdesk_faq_revisions',
  edges: 'helpdesk_faq_edge_revisions',
  phrasings: 'helpdesk_faq_phrasing_revisions',
  map: 'helpdesk_faq_map_revisions',
  reviews: 'helpdesk_faq_reviews',
  candidates: 'helpdesk_faq_candidate_revisions',
} as const;

export type ChangeSummary = Partial<
  Record<keyof typeof REVISION_TABLES, number>
>;

const COUNT_REVISIONS = `SELECT ${Object.entries(REVISION_TABLES)
  .map(
    ([name, table]) =>
      `(SELECT count(*) FROM ${table} WHERE change_id = $1)::int AS ${name}`,
  )
  .join(', ')}`;

/** 本事务里落下了哪些修订（只列不为 0 的）。 */
async function changedRows(
  client: SqlClient,
  changeId: string,
): Promise<ChangeSummary> {
  const [row] = (await client.query(COUNT_REVISIONS, [changeId])).rows;
  const summary: ChangeSummary = {};
  for (const name of Object.keys(
    REVISION_TABLES,
  ) as (keyof typeof REVISION_TABLES)[]) {
    const n = Number(row?.[name] ?? 0);
    if (n > 0) summary[name] = n;
  }
  return summary;
}
/** pg_notify 的频道：负载 = change_id；各实例的长连接收到后自己重读。 */
export const FAQ_CHANGE_CHANNEL = 'helpdesk_faq_changes';

/** 中间件的顺序（锁住在测试里）。 */
export const PIPELINE = [
  'trace',
  'actor',
  'change',
  'idempotency',
  'parse',
  'unitOfWork',
  'log',
] as const;

type Stage = (typeof PIPELINE)[number];

const ACTOR_LABEL =
  /^(human:[0-9a-f-]{36}|process:[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/;

function invalid(message: string): HelpdeskError {
  return new HelpdeskError(400, 'INVALID_INPUT', message);
}

/** 请求的规范化哈希（键排序后的 JSON），判断「同一个请求」用。 */
export function requestHash(command: string, raw: unknown): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .sort()
              .map((k) => [
                k,
                canonical((value as Record<string, unknown>)[k]),
              ]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify([command, canonical(raw)]))
    .digest('hex');
}

export type FaqCommandBusOptions = {
  db: SqlDb;
  now?: () => Date;
  logger?: Pick<Logger, 'log' | 'warn'>;
  /** 测试用：在某一级之前停下或注入故障。 */
  probe?: (stage: Stage, ctx: Partial<CommandContext>) => void | Promise<void>;
};

export function createFaqCommandBus(options: FaqCommandBusOptions) {
  const logger = options.logger ?? new Logger('HelpdeskFaqCommands');

  async function probe(stage: Stage, ctx: Partial<CommandContext>) {
    if (options.probe) await options.probe(stage, ctx);
  }

  async function replay<O>(
    db: Pick<SqlDb, 'query'>,
    command: string,
    actor: string,
    key: string,
    hash: string,
  ): Promise<CommandOutcome<O> | null> {
    const [row] = await db.query(
      `SELECT request_hash, result, change_id FROM helpdesk_idempotency
        WHERE command = $1 AND actor = $2 AND key = $3`,
      [command, actor, key],
    );
    if (!row) return null;
    if (row.request_hash !== hash)
      throw new HelpdeskError(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request',
      );
    return {
      result: row.result as O,
      changeId: row.change_id == null ? null : (row.change_id as string),
      replayed: true,
    };
  }

  return {
    async execute<I, O>(
      command: FaqCommand<I, O>,
      raw: unknown,
      meta: CommandMeta,
    ): Promise<CommandOutcome<O>> {
      const started = Date.now();
      // 1 追踪
      const trace = startTrace(meta.traceparent);
      await probe('trace', {});

      // 2 执行者：员工 → human:<id>；没有员工就必须写明是哪个程序或工具
      // 员工 id 按小写记（UUID 不分大小写；执行者标签和 OKF 的写法都用小写）
      const employeeId =
        typeof meta.actor.employeeId === 'string'
          ? meta.actor.employeeId.toLowerCase()
          : meta.actor.employeeId;
      if (employeeId !== null && !isUuid(employeeId))
        throw invalid('actor employeeId must be a UUID');
      const label =
        meta.actor.label ?? (employeeId ? `human:${employeeId}` : null);
      if (!label || !ACTOR_LABEL.test(label))
        throw invalid(
          'actor must be human:<employee id>, process:<name> or <tool>/<version>',
        );
      if (label.startsWith('human:') && label !== `human:${employeeId}`)
        throw invalid('a human actor must be the signed-in employee');
      const actor = { employeeId, label };
      await probe('actor', { actor });

      // 3 修改上下文
      if (!FAQ_CHANGE_CAUSES.includes(meta.cause.kind))
        throw invalid(`cause must be one of ${FAQ_CHANGE_CAUSES.join(', ')}`);
      const changeId = uuidv7();
      const ctxBase = {
        command: command.name,
        changeId,
        actor,
        cause: meta.cause,
        traceId: trace.traceId,
      };
      let summary: ChangeSummary = {};
      await probe('change', ctxBase);

      // 4 幂等快路径（权威的检查在事务里再做一次）
      let key: string | null = null;
      let hash = '';
      if (command.idempotent && meta.idempotencyKey) {
        if (!isUuid(meta.idempotencyKey))
          throw invalid('Idempotency-Key must be a UUID');
        key = meta.idempotencyKey.toLowerCase();
        hash = requestHash(command.name, raw);
        const hit = await replay<O>(options.db, command.name, label, key, hash);
        if (hit) return hit;
      }
      await probe('idempotency', ctxBase);

      // 5 解析与校验（处理器自己的 parse，一次报全）
      const input = command.parse(raw);
      await probe('parse', ctxBase);

      // 6 工作单元
      let outcome: CommandOutcome<O>;
      try {
        outcome = await options.db.withTransaction(async (client) => {
          const db = transactionDb(client);
          const ctx: CommandContext = { ...ctxBase, db };
          await client.query(
            `SELECT set_config('helpdesk.change_id', $1, true)`,
            [changeId],
          );
          await client.query(
            command.lock === 'exclusive'
              ? 'SELECT pg_advisory_xact_lock($1, $2)'
              : 'SELECT pg_advisory_xact_lock_shared($1, $2)',
            [...FAQ_LIBRARY_LOCK],
          );
          if (key) {
            const hit = await replay<O>(db, command.name, label, key, hash);
            if (hit) return hit;
          }
          await probe('unitOfWork', ctx);
          const result = await command.run(input, ctx);
          summary = await changedRows(client, changeId);
          const changed = Object.keys(summary).length > 0;
          if (!changed) {
            // 什么都没改：不记改动、不发通知；幂等键照样记下结果，重放时原样返回
            if (key)
              await client.query(
                `INSERT INTO helpdesk_idempotency (command, key, actor, request_hash, result, change_id)
                 VALUES ($1, $2, $3, $4, $5, NULL)`,
                [
                  command.name,
                  key,
                  label,
                  hash,
                  JSON.stringify(result ?? null),
                ],
              );
            return { result, changeId: null, replayed: false };
          }
          await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
            ...FAQ_CHANGE_LOG_LOCK,
          ]);
          await client.query(
            `INSERT INTO helpdesk_faq_changes
               (id, command, actor, employee_id, cause_kind, cause_ref, note, trace_id, summary)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              changeId,
              command.name,
              label,
              employeeId,
              meta.cause.kind,
              meta.cause.ref ?? null,
              meta.cause.note ?? null,
              trace.traceId,
              JSON.stringify(summary),
            ],
          );
          if (key)
            await client.query(
              `INSERT INTO helpdesk_idempotency (command, key, actor, request_hash, result, change_id)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                command.name,
                key,
                label,
                hash,
                JSON.stringify(result ?? null),
                changeId,
              ],
            );
          // NOTIFY 随事务提交才发出；回滚就不发
          await client.query('SELECT pg_notify($1, $2)', [
            FAQ_CHANGE_CHANNEL,
            changeId,
          ]);
          return { result, changeId, replayed: false };
        });
      } catch (error) {
        // 同一个键的两个请求同时到：后到的撞主键，回头按重放处理
        if (
          key &&
          (error as { code?: string }).code === '23505' &&
          String((error as { constraint?: string }).constraint) ===
            'helpdesk_idempotency_pkey'
        ) {
          const hit = await replay<O>(
            options.db,
            command.name,
            label,
            key,
            hash,
          );
          if (hit) return hit;
        }
        // 4xx 是请求被拒（校验、冲突、权限），不是故障
        const rejected =
          error instanceof HelpdeskError &&
          error.status >= 400 &&
          error.status < 500;
        (rejected ? logger.log.bind(logger) : logger.warn.bind(logger))(
          JSON.stringify({
            type: 'helpdesk',
            event: rejected ? 'faq_command_rejected' : 'faq_command_failed',
            command: command.name,
            changeId,
            actor: label,
            traceId: trace.traceId,
            ms: Date.now() - started,
            error:
              error instanceof HelpdeskError
                ? error.code
                : error instanceof Error
                  ? error.name
                  : 'unknown',
          }),
        );
        throw error;
      }
      if (outcome.replayed) return outcome;

      // 7 记录
      await probe('log', ctxBase);
      logger.log(
        JSON.stringify({
          type: 'helpdesk',
          event: 'faq_command',
          command: command.name,
          changeId: outcome.changeId,
          actor: label,
          cause: meta.cause.kind,
          traceId: trace.traceId,
          ms: Date.now() - started,
          summary,
        }),
      );
      return outcome;
    },
  };
}

export type FaqCommandBus = ReturnType<typeof createFaqCommandBus>;
