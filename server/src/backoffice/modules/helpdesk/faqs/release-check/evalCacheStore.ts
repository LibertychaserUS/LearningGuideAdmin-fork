import {
  EVAL_CACHE,
  type EvalCacheEntry,
  type EvalCacheStore,
} from '../../../../../contracts/helpdesk-eval-cache';
import { query, withTransaction } from '../../../../lib/db';
import type { SqlDb } from '../faqRepository';

/**
 * 分层结果缓存的库表实现（helpdesk_eval_stage_cache，迁移 20261106000000）。读只取 ttlDays 天内的；
 * 写同键覆盖（refresh 用新的替换旧的）。一次至多 PUT_BATCH 行，大批精排分数分几次写。
 */
const PUT_BATCH = 500;

const defaultDb: SqlDb = {
  query: (sql, params) => query(sql, params),
  withTransaction: (fn) => withTransaction((client) => fn(client)),
};

export function createPgEvalCacheStore(db: SqlDb = defaultDb): EvalCacheStore {
  return {
    async get(layer, keys) {
      const found = new Map<string, EvalCacheEntry>();
      if (keys.length === 0) return found;
      const rows = await db.query(
        `SELECT key, value, latency_ms, cost_usd FROM helpdesk_eval_stage_cache
          WHERE layer = $1 AND key = ANY($2::text[])
            AND created_at > now() - make_interval(days => $3)`,
        [layer, [...new Set(keys)], EVAL_CACHE.ttlDays],
      );
      for (const row of rows)
        found.set(String(row.key), {
          value: row.value,
          latencyMs: Number(row.latency_ms),
          costUsd: Number(row.cost_usd),
        });
      return found;
    },

    async put(layer, entries) {
      for (let at = 0; at < entries.length; at += PUT_BATCH) {
        const batch = entries.slice(at, at + PUT_BATCH);
        await db.query(
          `INSERT INTO helpdesk_eval_stage_cache (layer, key, value, latency_ms, cost_usd)
           SELECT $1, r.key, r.value, r.latency_ms, r.cost_usd
             FROM jsonb_to_recordset($2::jsonb)
                  AS r(key text, value jsonb, latency_ms integer, cost_usd double precision)
           ON CONFLICT (layer, key) DO UPDATE
             SET value = EXCLUDED.value, latency_ms = EXCLUDED.latency_ms,
                 cost_usd = EXCLUDED.cost_usd, created_at = now()`,
          [
            layer,
            JSON.stringify(
              // 同一批里重复的键只留最后一个（ON CONFLICT 不能在一条语句里改同一行两次）
              [
                ...new Map(
                  batch.map(({ key, entry }) => [
                    key,
                    {
                      key,
                      value: entry.value,
                      latency_ms: Math.max(0, Math.round(entry.latencyMs)),
                      cost_usd: Math.max(0, entry.costUsd),
                    },
                  ]),
                ).values(),
              ],
            ),
          ],
        );
      }
    },

    async prune() {
      const rows = await db.query(
        `WITH gone AS (
           DELETE FROM helpdesk_eval_stage_cache
            WHERE created_at <= now() - make_interval(days => $1)
           RETURNING 1)
         SELECT count(*)::int AS n FROM gone`,
        [EVAL_CACHE.ttlDays],
      );
      return Number(rows[0]?.n ?? 0);
    },
  };
}
