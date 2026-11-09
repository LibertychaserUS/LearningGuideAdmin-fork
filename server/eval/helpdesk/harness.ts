import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  HELPDESK_SETTINGS,
  readHelpdeskSettingStrict,
} from '../../src/contracts/helpdesk-settings';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { Pool } from 'pg';

import { entryAncestorsOf } from './v5-sets';

import {
  HelpdeskSuggestService,
  SUGGEST_CANDIDATES,
  suggestModel,
  suggestThinking,
} from '../../src/ai/helpdesk/helpdesk-suggest.service';
import type { HelpdeskSuggestionLog } from '../../src/ai/helpdesk/helpdesk-suggestion.store';
import { createMemoryAgentEventLog } from '../../src/ai/helpdesk/trace/agent-event.store';
import type {
  AgentStepRunner,
  ThinkingSetting,
} from '../../src/ai/helpdesk/workflow/engine';
import {
  initialFaqState,
  PICK_FAQ_MAX_TOKENS,
} from '../../src/ai/helpdesk/workflow/faq-workflow';
import {
  loadPi,
  openRouterSource,
  PiStepRunner,
  type ModelSource,
} from '../../src/ai/helpdesk/workflow/pi-step-runner';
import { MemoryRateLimitStore } from '../../src/ai/rate-limit.service';
import type { HelpdeskFaq } from '../../src/backoffice/modules/helpdesk/faqs/faqContracts';
import { createPgHelpdeskQaSource } from '../../src/backoffice/modules/helpdesk/faqs/faqQaSource';
import {
  createPgFaqRepository,
  type SqlDb,
} from '../../src/backoffice/modules/helpdesk/faqs/faqRepository';
import { uuidv7 } from '../../src/common/uuidv7';
import {
  FAQ_CATEGORIES,
  faqCategoryFor,
  HELPDESK_CATEGORIES,
  type FaqCategory,
  type HelpdeskCategory,
  type HelpdeskQaCandidate,
  type HelpdeskQaSearch,
  type HelpdeskQaSource,
} from '../../src/contracts/helpdesk-qa';

/**
 * Helpdesk 推荐评测（helpdesk-agent-v2-pi-dsh §5）：每条用例走真正的 HelpdeskSuggestService
 *（同一套工作流、pi Agent 步、3 秒期限），只换掉外部依赖：
 * - 检索：内存近似（缺省）或 --pg 给的 PostgreSQL（真实的候选 SQL，独立 schema，跑完删掉）；
 * - 模型：有 OPENROUTER_API_KEY 时是真模型（HELPDESK_SUGGEST_MODEL），按 HELPDESK_EVAL_BUDGET_USD
 *  （缺省 5 美元）封顶；没有 key 时是假模型（pi 的 faux provider，永远选第一个候选），报告里标明，
 *   它的数字只说明评测本身能跑，不是模型的成绩。
 * 报告：准确率、答错率、none 的精确率 / 召回率、p50 / p95、费用、按 persona / locale 拆分、失败清单，
 * 检索与模型分开看（recall@8、模型 recall、问过模型的条数、没问模型就“答对”的 none、非法调用），
 * 以及闸门（GATE）：只有真模型、整套用例、PostgreSQL 检索的一次运行才可能通过。
 * 另按学员角色（role）、语言（en-GB / zh-CN / zh-TW / mixed）与轮次（单条 / 首轮 / 追问）拆分。
 * --retrieval-only：只跑生产检索（不问模型、不花钱），报 recall@1 / @3 / @8 与检索耗时，同样按切片拆分。
 * zh-TW 用例是繁体字，种子 FAQ 是简体：有几条检索够不着（用例 note 写明），这是生产里同样存在的缺口。
 */

export const EVAL_LOCALES = ['en-GB', 'zh-CN', 'zh-TW'] as const;
export type EvalLocale = (typeof EVAL_LOCALES)[number];
export const EVAL_PERSONAS = [
  'paraphrase',
  'terse',
  'typo',
  'mixed_language',
  'unanswerable',
  'injection',
  'over_reach',
  /** 相邻的 FAQ（取消 / 更改订阅 / 退款 / 付款失败；注销 / 改邮箱；视频 / 课程资料）。 */
  'ambiguous',
  /** 一句话问两件事：expectedFaqId 与 acceptableFaqIds 都算答对。 */
  'multi_intent',
  /** 超过 2000 字（送模型的原文会被截断）。 */
  'long',
] as const;
export type EvalPersona = (typeof EVAL_PERSONAS)[number];
/** 报告里的语言切片：locale，混合语言（persona mixed_language）的用例单独算 mixed。 */
export const EVAL_LANGUAGES = ['en-GB', 'zh-CN', 'zh-TW', 'mixed'] as const;
export type EvalLanguage = (typeof EVAL_LANGUAGES)[number];

export type EvalCase = {
  id: string;
  locale: EvalLocale;
  persona: EvalPersona;
  /** chat（缺省，聊天面板）或 submit（提交工单：带主题与工单类型，走 submit 的限流与同类加权）。 */
  source?: 'chat' | 'submit';
  subject?: string;
  /** submit 的工单类型（HELPDESK_CATEGORIES）。 */
  category?: HelpdeskCategory;
  message: string;
  expectedFaqId: string | null;
  /** 也算答对的 FAQ（多意图、标签可商量的用例）；不在这里的其它 FAQ 都算答错。 */
  acceptableFaqIds?: string[];
  /** 数据集说明（例如为什么检索够不着）。 */
  note?: string;
  /** 用户画像（new_user、low_tech、attacker …；不按学生 / 家长分，产品面向全年龄段），只用于按角色拆分。 */
  role?: string;
  /** 多轮对话：同一个 conversationId 的用例按 turn（1 起）排列；评测仍逐条单独打分，不带上文。 */
  conversationId?: string;
  turn?: number;
  /** 数据集来源（原始批次与行），评测不读。 */
  origin?: string;
};

export function caseLanguage(
  c: Pick<EvalCase, 'locale' | 'persona'>,
): EvalLanguage {
  return c.persona === 'mixed_language' ? 'mixed' : c.locale;
}

export type TurnKind = 'single' | 'first' | 'follow_up';

/** single：不属于多轮对话；first：对话第一轮；follow_up：之后的追问（标签按上文定，评测却不带上文）。 */
export function turnKind(c: {
  conversationId?: string | null;
  turn?: number | null;
}): TurnKind {
  if (!c.conversationId) return 'single';
  return c.turn === 1 ? 'first' : 'follow_up';
}

export type SeedFaq = Pick<
  HelpdeskFaq,
  | 'id'
  | 'category'
  | 'popular'
  | 'questionEn'
  | 'answerEn'
  | 'questionZh'
  | 'answerZh'
  | 'keywords'
>;

/**
 * 闸门：答错率 ≤ 2%、p95 ≤ 3 秒（helpdesk-agent-v2-pi-dsh §3），另加两条防“什么都不答也过”：
 * 出错 / 超时 / 中止 / 限流 / 无 key 结束的不超过 2%；期望的 FAQ 已在候选里的用例，模型至少答对 80%。
 */
export const GATE = {
  wrongAnswerRateMax: 0.02,
  p95MaxMs: 3_000,
  failedRateMax: 0.02,
  modelRecallMin: 0.8,
} as const;
/** 这些结束原因说明模型没给出结果（不是“模型说 none”）。 */
const FAILED_REASONS = new Set([
  'error',
  'timeout',
  'aborted',
  'rate_limited',
  'no_key',
]);
/** 评测缺省封顶（声明在 contracts/helpdesk-settings.ts，这里只是取出来给报告与测试用）。 */
export const DEFAULT_BUDGET_USD = readHelpdeskSettingStrict(
  HELPDESK_SETTINGS.evalBudgetUsd,
  {},
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function loadFaqs(path: string): SeedFaq[] {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { faqs?: unknown };
  if (!Array.isArray(doc.faqs)) throw new Error(`${path}: no faqs array`);
  return doc.faqs.map((raw, index) => {
    const faq = raw as SeedFaq;
    if (!UUID.test(faq.id) || !FAQ_CATEGORIES.includes(faq.category))
      throw new Error(`${path}: FAQ ${index} has a bad id or category`);
    return faq;
  });
}

const filled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

export function loadCases(path: string): EvalCase[] {
  const loaded = readFileSync(path, 'utf8')
    .split('\n')
    .map((line, index) => ({ line: line.trim(), at: index + 1 }))
    .filter(({ line }) => line !== '')
    .map(({ line, at }) => {
      const value = JSON.parse(line) as EvalCase;
      const source = value.source ?? 'chat';
      const ok =
        filled(value.id) &&
        EVAL_LOCALES.includes(value.locale) &&
        EVAL_PERSONAS.includes(value.persona) &&
        typeof value.message === 'string' &&
        (value.expectedFaqId === null || UUID.test(value.expectedFaqId)) &&
        (value.acceptableFaqIds ?? []).every((id) => UUID.test(id)) &&
        (value.role === undefined || filled(value.role)) &&
        (value.conversationId === undefined) === (value.turn === undefined) &&
        (value.conversationId === undefined || filled(value.conversationId)) &&
        (value.turn === undefined ||
          (Number.isInteger(value.turn) && value.turn >= 1)) &&
        (source === 'chat'
          ? filled(value.message) &&
            value.subject === undefined &&
            value.category === undefined
          : source === 'submit' &&
            (filled(value.subject) || filled(value.message)) &&
            (value.category === undefined ||
              HELPDESK_CATEGORIES.includes(value.category)));
      if (!ok) throw new Error(`${path}:${at}: malformed case`);
      return value;
    });
  if (loaded.length === 0) throw new Error(`${path}: no cases`);
  return loaded;
}

/** Portal 只有 en-GB / zh-CN 两个界面语言：繁体中文的学员用的是 zh-CN 站点。 */
export function serviceLocale(locale: EvalLocale): 'en-GB' | 'zh-CN' {
  return locale === 'en-GB' ? 'en-GB' : 'zh-CN';
}

/* ---------------------------------- 检索 ---------------------------------- */

const STOP = new Set(
  'the a an and or to of in on for my me i is it do does how can what where why when with from at be are was this that you your we our am not no'.split(
    ' ',
  ),
);
const HAN = /[㐀-鿿豈-﫿]/;

/** 英文词（≥ 2 字母、去停用词）+ 中文双字。 */
function terms(text: string): Set<string> {
  const lower = text.toLowerCase();
  const out = new Set<string>();
  for (const word of lower.match(/[a-z0-9]+/g) ?? [])
    if (word.length >= 2 && !STOP.has(word)) out.add(word);
  const han = [...lower].filter((ch) => HAN.test(ch));
  for (let i = 0; i + 1 < han.length; i += 1) out.add(han[i] + han[i + 1]);
  return out;
}

/**
 * 内存检索：近似生产的候选 SQL（全文 + 关键词 + 中文双字 + 同类加权），用于没有数据库时。
 * 报告里写明是近似；要和生产一致用 --pg。
 */
export function memoryQaSource(faqs: SeedFaq[]): HelpdeskQaSource {
  const localised = (faq: SeedFaq, locale: string) =>
    locale === 'zh-CN'
      ? { question: faq.questionZh, answer: faq.answerZh }
      : { question: faq.questionEn, answer: faq.answerEn };
  return {
    findCandidates(search) {
      const wanted = terms(search.text);
      const scored: HelpdeskQaCandidate[] = [];
      for (const faq of faqs) {
        const text = localised(faq, search.locale);
        const question = terms(text.question);
        const body = terms(`${text.answer}\n${faq.keywords.join(' ')}`);
        let score = 0;
        for (const term of wanted) {
          if (question.has(term)) score += 2;
          else if (body.has(term)) score += 1;
        }
        if (score === 0) continue;
        if (search.category && faq.category === search.category) score += 1;
        scored.push({ id: faq.id, category: faq.category, ...text, score });
      }
      scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      return Promise.resolve(scored.slice(0, search.limit));
    },
    // 热门 FAQ：同类在前，其余按文件顺序（种子库没有更新时间）
    findPopular(search) {
      const popular = faqs.filter(
        (faq) => faq.popular && !search.excludeIds.includes(faq.id),
      );
      const ordered = [
        ...popular.filter((faq) => faq.category === search.category),
        ...popular.filter((faq) => faq.category !== search.category),
      ];
      return Promise.resolve(
        ordered.slice(0, search.limit).map((faq) => ({
          id: faq.id,
          category: faq.category,
          ...localised(faq, search.locale),
          score: 0,
        })),
      );
    },
    findPublished(id, locale) {
      const faq = faqs.find((item) => item.id === id);
      return Promise.resolve(
        faq
          ? {
              id: faq.id,
              category: faq.category,
              ...localised(faq, locale),
              score: 0,
            }
          : null,
      );
    },
  };
}

/** prisma/migrations 里所有 helpdesk 迁移的 SQL（按名字即时间顺序）。 */
export function helpdeskMigrationSql(
  dir = join(__dirname, '..', '..', 'prisma', 'migrations'),
): string {
  return readdirSync(dir)
    .filter((name) => name.includes('helpdesk'))
    .sort()
    .map((name) => readFileSync(join(dir, name, 'migration.sql'), 'utf8'))
    .join('\n');
}

/** 真实的 PostgreSQL 候选检索：独立 schema 里跑 helpdesk 迁移、写入种子 FAQ；close() 删掉 schema。 */
export async function pgQaSource(
  url: string,
  faqs: SeedFaq[],
  migrationSql: string,
): Promise<{ qa: HelpdeskQaSource; close: () => Promise<void> }> {
  const schema = `hdeval_${process.pid}_${Date.now()}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
  });
  const close = async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  };
  try {
    await pool.query(migrationSql);
    const db: SqlDb = {
      query: async (sql, params = []) =>
        (await pool.query<Record<string, unknown>>(sql, params as unknown[]))
          .rows,
      withTransaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const value = await fn(client);
          await client.query('COMMIT');
          return value;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    };
    const repository = createPgFaqRepository(db);
    for (const faq of faqs) {
      await repository.insert(
        {
          // v5 Part A: the eval library carries no signals yet; v5 graph: every eval FAQ is an
          // entry answer, and the database derives its key from the English question
          signals: [],
          popularRank: null,
          key: '',
          type: 'answer',
          entry: true,
          ...faq,
          status: 'published',
          version: 1,
          createdBy: null,
          updatedBy: null,
          createdAt: '',
          updatedAt: '',
        },
        null,
        null,
      );
    }
    return { qa: createPgHelpdeskQaSource(repository, db), close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * --release：直接用 --pg 那个库里已经导入并发布的 FAQ（seed-faq-library.ts 建的发布版本），和生产同一个
 * 来源（发布快照里的节点与边：追问、兄弟节点都在候选里）。只读，不建 schema、不写 FAQ。
 * idOfKey：FAQ key → id，给按 key 标注的评测集用。
 */
export async function pgReleaseQaSource(url: string): Promise<{
  qa: HelpdeskQaSource;
  release: number;
  idOfKey: Map<string, string>;
  entryAncestors: Map<string, string[]>;
  close: () => Promise<void>;
}> {
  const pool = new Pool({ connectionString: url });
  try {
    const db: SqlDb = {
      query: async (sql, params = []) =>
        (await pool.query<Record<string, unknown>>(sql, params as unknown[]))
          .rows,
      withTransaction: () =>
        Promise.reject(new Error('the released library is read-only here')),
    };
    const published = await pool.query<{
      version: number;
      snapshot: {
        nodes: { id: string; entry: boolean }[];
        edges: { parentId: string; childId: string }[];
      };
    }>(
      "SELECT version, snapshot FROM helpdesk_faq_releases WHERE status = 'published'",
    );
    const release = published.rows[0]?.version;
    if (release === undefined)
      throw new Error('--release: the database has no published FAQ release');
    const keys = await pool.query<{ key: string; id: string }>(
      'SELECT key, id FROM helpdesk_faqs',
    );
    return {
      qa: createPgHelpdeskQaSource(undefined, db),
      release,
      idOfKey: new Map(keys.rows.map((row) => [row.key, row.id])),
      entryAncestors: entryAncestorsOf(
        published.rows[0].snapshot.nodes,
        published.rows[0].snapshot.edges,
      ),
      close: () => pool.end(),
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

/* ---------------------------------- 模型 ---------------------------------- */

export type EvalModel =
  | {
      kind: 'real';
      model: string;
      thinking?: ThinkingSetting;
      /** 评测放宽的总期限（HELPDESK_EVAL_DEADLINE_MS）；没有 = 线上的期限。 */
      deadlineMs?: number;
      /** 评测改的思考截断（HELPDESK_EVAL_CUTOFF_MS，0 = 不发后备）；没有 = 线上的截断。只有聊天。 */
      cutoffMs?: number;
    }
  | { kind: 'fake'; model: string };

export const FAKE_MODEL_ID = 'fake/top-candidate';

/** 报告与日志里真模型的思考档位（没设 = off）。 */
export function thinkingLabel(model: {
  kind: string;
  thinking?: ThinkingSetting;
  deadlineMs?: number;
  cutoffMs?: number;
}): string {
  if (model.kind !== 'real') return '';
  const deadline = model.deadlineMs ? `, deadline ${model.deadlineMs} ms` : '';
  const cutoff =
    model.cutoffMs === undefined
      ? ''
      : model.cutoffMs === 0
        ? ', no backup'
        : `, cut-off ${model.cutoffMs} ms`;
  return `, thinking ${model.thinking ?? 'off'}${deadline}${cutoff}`;
}

/**
 * 评测才有的总期限（HELPDESK_EVAL_DEADLINE_MS，毫秒）：看思考档位不截时限时的质量与延迟，
 * 慢的那些线上会超时，报告里按延迟另算。不给就是线上的期限。
 */
export function evalDeadline(env: NodeJS.ProcessEnv): number | undefined {
  return (
    readHelpdeskSettingStrict(HELPDESK_SETTINGS.evalDeadlineMs, env) ??
    undefined
  );
}

/**
 * 评测才有的思考截断（HELPDESK_EVAL_CUTOFF_MS，毫秒）：线上思考截在 6.3 秒、同时发不思考的后备；
 * 0 = 只跑思考那一路、不发后备（配合 HELPDESK_EVAL_DEADLINE_MS 看不截断的质量）。不给就是线上的截断。
 */
export function evalCutoff(env: NodeJS.ProcessEnv): number | undefined {
  return (
    readHelpdeskSettingStrict(HELPDESK_SETTINGS.evalCutoffMs, env) ?? undefined
  );
}

/** 放宽期限时，模型那一步的时限也一起放宽；思考截断照给。 */
export function deadlineDeps(env: NodeJS.ProcessEnv): {
  deadlineMs?: number;
  timeoutMs?: number;
  cutoffMs?: number;
} {
  const deadlineMs = evalDeadline(env);
  const cutoffMs = evalCutoff(env);
  return {
    ...(deadlineMs ? { deadlineMs, timeoutMs: deadlineMs } : {}),
    ...(cutoffMs !== undefined ? { cutoffMs } : {}),
  };
}

/**
 * 一次 pick_faq 请求最多多少 token 的提示：系统提示 + 学员原文（≤ 2000 字）+ 主题 + 8 个候选
 *（问题 + ≤ 600 字答案）约一万字；按最坏的一字一 token 计。
 */
export const CALL_PROMPT_TOKENS_MAX = 10_000;

/**
 * 一次请求的费用上限（美元），按 pi 价目里的模型价格；不在价目里为 null（价格未知）。
 * 请求被 abort（超时、调用方断开）时拿不到 usage，OpenRouter 照样计费：按这个上限记账。
 */
export async function callCeilingUsd(model: string): Promise<number | null> {
  const pi = await loadPi();
  const { model: priced, priced: known } = openRouterSource(pi, {
    provider: 'openrouter',
    model,
    apiKey: '',
    baseUrl: 'https://openrouter.ai/api/v1',
  });
  if (known === false) return null;
  return (
    (priced.cost.input * CALL_PROMPT_TOKENS_MAX +
      priced.cost.output * PICK_FAQ_MAX_TOKENS) /
    1e6
  );
}

/**
 * 有 OPENROUTER_API_KEY 就用真模型（和生产选同一个：suggestModel），否则用假模型。思考档位也和生产
 * 一样：聊天（v5 对话集）按 suggestThinking，提交工单那条路（用例集）不思考。
 */
export function chooseModel(
  env: NodeJS.ProcessEnv,
  surface: 'chat' | 'ticket' = 'chat',
): EvalModel {
  if (env.OPENROUTER_API_KEY?.trim()) {
    const deadlineMs = evalDeadline(env);
    const cutoffMs = evalCutoff(env);
    return {
      kind: 'real',
      model: suggestModel(env),
      ...(surface === 'chat' ? { thinking: suggestThinking(env) } : {}),
      ...(deadlineMs ? { deadlineMs } : {}),
      ...(surface === 'chat' && cutoffMs !== undefined ? { cutoffMs } : {}),
    };
  }
  return { kind: 'fake', model: FAKE_MODEL_ID };
}

/** 提示是哪一种：v2 的 pick_faq（enquiry）、v5 的 pick_faq（message）、v5 的 explain（card）。 */
type PromptShape = { kind: 'pick' | 'pick_v5' | 'explain'; ids: string[] };

/** 从提示里取出候选 id（按检索顺序）与提示的种类。 */
function promptShape(prompt: string): PromptShape {
  try {
    const body = JSON.parse(prompt) as {
      candidates?: { id?: unknown }[];
      card?: unknown;
      message?: unknown;
    };
    const ids = (body.candidates ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string');
    if (body.card !== undefined) return { kind: 'explain', ids };
    return { kind: body.message !== undefined ? 'pick_v5' : 'pick', ids };
  } catch {
    return { kind: 'pick', ids: [] };
  }
}

/**
 * 假模型：pi 自带的 faux provider，每一步都调用 pick_faq 选第一个候选（检索排第一的那条），confidence sure；
 * v5 的提示（请求带 context）同样选第一个、tone none（于是用默认的开头结尾），explain 一律 covered false。
 * 走的是同一个 PiStepRunner（同样的工具、枚举、闸），只是不连网、不花钱。
 */
export async function fakeTopCandidateSource(): Promise<ModelSource> {
  const pi = await loadPi();
  const handle = pi.ai.fauxProvider({});
  const models = pi.ai.createModels();
  models.setProvider(handle.provider);
  return () => {
    handle.setResponses([
      (context) => {
        const last = context.messages[context.messages.length - 1];
        const content = last?.role === 'user' ? last.content : '';
        const prompt =
          typeof content === 'string'
            ? content
            : content.map((part) => ('text' in part ? part.text : '')).join('');
        const shape = promptShape(prompt);
        const [first] = shape.ids;
        const call =
          shape.kind === 'explain'
            ? pi.ai.fauxToolCall('explain', { covered: 'no' })
            : pi.ai.fauxToolCall('pick_faq', {
                intent: 'question',
                faqId: first ?? 'none',
                confidence: 'sure',
              });
        return pi.ai.fauxAssistantMessage([call], { stopReason: 'toolUse' });
      },
    ]);
    return { models, model: handle.getModel() };
  };
}

/* ---------------------------------- 运行 ---------------------------------- */

export type CaseResult = {
  id: string;
  locale: EvalLocale;
  persona: EvalPersona;
  role: string | null;
  conversationId: string | null;
  turn: number | null;
  message: string;
  expectedFaqId: string | null;
  acceptableFaqIds: string[];
  gotFaqId: string | null;
  /** turn/end.reason（answered / no_match / timeout …）。 */
  reason: string | null;
  latencyMs: number;
  /** 有价格的回复的费用之和。 */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** retrieve 步给出的候选（按检索顺序）。 */
  candidateIds: string[];
  /** 发出过模型请求（request/context）。 */
  asked: boolean;
  /** 正好一次工具调用，且结果没有错误。 */
  validCall: boolean;
  /** 发出了却没有带价格回复的请求（被 abort、或模型不在价目里）。 */
  unpricedCalls: number;
  /** 你可能想问（v3 §1）：没有答案时给学员的 FAQ，按给出的顺序。 */
  alternativeIds: string[];
};

export type RunOptions = {
  cases: EvalCase[];
  qa: HelpdeskQaSource;
  runner: AgentStepRunner;
  /** 给服务的环境（key、模型、base URL）。 */
  env: NodeJS.ProcessEnv;
  budgetUsd: number;
  /** 模型要花钱（真模型，缺省）：有请求拿不到价格、又没有单次上限可记时就停，守不住上限。假模型传 false。 */
  paid?: boolean;
  /** 没有带价格回复的请求按这个记账（callCeilingUsd）；null（缺省）= 价格未知。 */
  callCeilingUsd?: number | null;
  /** 每条用例跑完调一次（打印进度用）。并发时按完成顺序调。 */
  onCase?: (result: CaseResult, index: number) => void;
  /** 同时跑几条（缺省 1）。每个 worker 开跑下一条前查预算，所以最多比串行多花 concurrency - 1 条。 */
  concurrency?: number;
};

export type RunOutcome = {
  results: CaseResult[];
  spentUsd: number;
  /** null：全部跑完；budget：花到上限（每条开跑前检查，最多超出一条的费用）；unknown_cost：有请求的价格未知，无法守住上限。 */
  stopped: null | 'budget' | 'unknown_cost';
};

const noopLog: HelpdeskSuggestionLog = {
  record: () => Promise.resolve(),
  setOutcome: () =>
    Promise.resolve({ kind: 'recorded', outcome: 'helpful', changed: false }),
  purgeQueryText: () => Promise.resolve(0),
};

const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

export async function runCases(options: RunOptions): Promise<RunOutcome> {
  const events = createMemoryAgentEventLog();
  const service = new HelpdeskSuggestService({
    qa: options.qa,
    runner: options.runner,
    rateLimit: new MemoryRateLimitStore(),
    log: noopLog,
    events,
    env: () => options.env,
    ...deadlineDeps(options.env),
  });
  const done: (CaseResult | undefined)[] = [];
  let spentUsd = 0;
  let stopped: RunOutcome['stopped'] = null;
  let next = 0;
  const runOne = async (index: number, item: EvalCase): Promise<void> => {
    const runId = uuidv7();
    const started = performance.now();
    const submit = item.source === 'submit';
    const answer = await service.suggest({
      learnerId: `eval-${item.id}`,
      locale: serviceLocale(item.locale),
      source: submit ? 'submit' : 'chat',
      ...(submit ? { subject: item.subject, category: item.category } : {}),
      message: item.message,
      runId,
    });
    const latencyMs = performance.now() - started;
    await service.flushTraces();
    const log = await events.read(runId);
    const of = (type: string) => log.filter((e) => e.type === type);
    const replies = of('assistant/message');
    const usage = (data: Record<string, unknown>) =>
      (data.usage ?? {}) as Record<string, unknown>;
    const requests = of('request/context').length;
    const priced = replies.filter(
      (e) => typeof e.data.costUsd === 'number',
    ).length;
    const retrieve = log.find(
      (e) => e.type === 'step/end' && e.data.name === 'retrieve',
    );
    const found = (
      retrieve?.data.output as { candidates?: { id: string }[] } | undefined
    )?.candidates;
    const calls = of('tool/call');
    const toolResults = of('tool/result');
    const result: CaseResult = {
      id: item.id,
      locale: item.locale,
      persona: item.persona,
      role: item.role ?? null,
      conversationId: item.conversationId ?? null,
      turn: item.turn ?? null,
      message: item.message,
      expectedFaqId: item.expectedFaqId,
      acceptableFaqIds: item.acceptableFaqIds ?? [],
      gotFaqId: answer.suggestion?.faqId ?? null,
      reason: (log.find((e) => e.type === 'turn/end')?.data.reason ?? null) as
        string | null,
      latencyMs,
      costUsd: replies.reduce((sum, e) => sum + num(e.data.costUsd), 0),
      inputTokens: replies.reduce(
        (sum, e) => sum + num(usage(e.data).inputTokens),
        0,
      ),
      outputTokens: replies.reduce(
        (sum, e) => sum + num(usage(e.data).outputTokens),
        0,
      ),
      candidateIds: (found ?? []).map((c) => c.id),
      asked: requests > 0,
      validCall:
        calls.length === 1 &&
        toolResults.length === 1 &&
        toolResults[0].data.error === undefined,
      unpricedCalls: Math.max(0, requests - priced),
      alternativeIds: answer.alternatives.map((a) => a.faqId),
    };
    done[index] = result;
    const ceiling = options.callCeilingUsd ?? null;
    spentUsd += result.costUsd + result.unpricedCalls * (ceiling ?? 0);
    options.onCase?.(result, index);
    if ((options.paid ?? true) && result.unpricedCalls > 0 && ceiling === null)
      stopped = 'unknown_cost';
  };
  const worker = async (): Promise<void> => {
    while (stopped === null && next < options.cases.length) {
      if (spentUsd >= options.budgetUsd) {
        stopped = 'budget';
        return;
      }
      const index = next++;
      await runOne(index, options.cases[index]);
    }
  };
  const width = Math.max(1, Math.floor(options.concurrency ?? 1));
  await Promise.all(Array.from({ length: width }, () => worker()));
  // 并发时可能有空位（停下时别的 worker 还没跑到）：只留跑完的，按用例顺序
  const results = done.filter((r): r is CaseResult => r !== undefined);
  return { results, spentUsd, stopped };
}

/** 真模型：生产同款 PiStepRunner；假模型：同一个 runner 换成 faux provider。 */
export async function runnerFor(model: EvalModel): Promise<{
  runner: AgentStepRunner;
  env: (base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}> {
  if (model.kind === 'real')
    return {
      runner: new PiStepRunner(),
      env: (base) => ({ ...base, HELPDESK_SUGGEST_MODEL: model.model }),
    };
  const source = await fakeTopCandidateSource();
  return {
    runner: new PiStepRunner({ source }),
    env: () => ({
      // 假模型不连网：这些只是让工作流走到 pick_faq 那一步
      OPENROUTER_API_KEY: 'fake-key-local-only',
      OPENROUTER_BASE_URL: 'http://fake-model.invalid/api/v1',
      HELPDESK_SUGGEST_MODEL: FAKE_MODEL_ID,
    }),
  };
}

/* ---------------------------------- 报告 ---------------------------------- */

export type Slice = {
  cases: number;
  accuracy: number;
  wrongAnswerRate: number;
};

export type EvalReport = {
  generatedAt: string;
  model: EvalModel & { note: string | null };
  retrieval: 'memory' | 'postgresql';
  budget: {
    capUsd: number;
    spentUsd: number;
    stopped: RunOutcome['stopped'];
  };
  cases: { total: number; run: number };
  metrics: {
    accuracy: number;
    wrongAnswerRate: number;
    none: { precision: number | null; recall: number | null };
    latencyMs: { p50: number; p95: number };
    costUsd: number;
    tokens: { input: number; output: number };
    /** 发出过模型请求的用例数。 */
    modelAsked: number;
    /** 该有答案的用例里，期望的 FAQ（或可接受的）在候选中的比例（recall@8）。 */
    retrievalRecall: number | null;
    /** 上一项里模型答对的比例：只衡量模型。 */
    modelRecall: number | null;
    /**
     * 你可能想问的召回（v3 §1）：该有答案却没答（gotFaqId 为 null）的用例里，期望的 FAQ
     * （或可接受的）在 alternatives 中的比例。
     */
    alternativesRecall: number | null;
    /** 上一项的分子：期望的 FAQ 在 alternatives 中的用例数。 */
    alternativesOffered: number;
    /** 上一项的分母：该有答案却没答的用例数。 */
    unansweredAnswerable: number;
    /** 该是 none、也是 none，但模型根本没被问到（检索没有候选）。 */
    noneWithoutModel: number;
    /** 问了模型、没出错，却没有恰好一次合法调用。 */
    invalidCalls: number;
    /** 以 error / timeout / aborted / rate_limited / no_key 结束。 */
    failedRuns: number;
  };
  byPersona: Record<string, Slice>;
  byLocale: Record<string, Slice>;
  /** 学员角色；没写角色的用例归 (none)。 */
  byRole: Record<string, Slice>;
  /** en-GB / zh-CN / zh-TW，混合语言的用例归 mixed。 */
  byLanguage: Record<string, Slice>;
  /** single / first / follow_up（追问按上文标注，评测不带上文）。 */
  byTurn: Record<string, Slice>;
  failures: (Pick<
    CaseResult,
    | 'id'
    | 'locale'
    | 'persona'
    | 'message'
    | 'expectedFaqId'
    | 'gotFaqId'
    | 'reason'
    | 'latencyMs'
  > & {
    kind: 'wrong_answer' | 'missed';
    /** error：没有结果；retrieval：期望的 FAQ 不在候选里；model：模型选错或说 none。 */
    stage: 'error' | 'retrieval' | 'model';
  })[];
  gate: typeof GATE & {
    pass: boolean;
    reasons: string[];
  };
};

/** 最近秩百分位（p ∈ (0, 1]）。 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

const isRight = (r: CaseResult) =>
  r.gotFaqId === r.expectedFaqId ||
  (r.gotFaqId !== null && r.acceptableFaqIds.includes(r.gotFaqId));
const isWrong = (r: CaseResult) => r.gotFaqId !== null && !isRight(r);
const isFailed = (r: CaseResult) =>
  r.reason !== null && FAILED_REASONS.has(r.reason);
const isReachable = (r: CaseResult) =>
  r.expectedFaqId !== null &&
  [r.expectedFaqId, ...r.acceptableFaqIds].some((id) =>
    r.candidateIds.includes(id),
  );
const isOffered = (r: CaseResult) =>
  r.expectedFaqId !== null &&
  [r.expectedFaqId, ...r.acceptableFaqIds].some((id) =>
    r.alternativeIds.includes(id),
  );
const round = (value: number, digits = 4) =>
  Math.round(value * 10 ** digits) / 10 ** digits;
const share = (part: number, whole: number) =>
  whole ? round(part / whole) : null;

function slice(results: CaseResult[]): Slice {
  return {
    cases: results.length,
    accuracy: round(results.filter(isRight).length / results.length),
    wrongAnswerRate: round(results.filter(isWrong).length / results.length),
  };
}

/** 切片的键：locale、case type、角色、语言、轮次。 */
export type SliceKey = 'locale' | 'persona' | 'role' | 'language' | 'turn';

type Sliceable = Pick<
  CaseResult,
  'locale' | 'persona' | 'role' | 'conversationId' | 'turn'
>;

function sliceName(item: Sliceable, key: SliceKey): string {
  switch (key) {
    case 'role':
      return item.role ?? '(none)';
    case 'language':
      return caseLanguage(item);
    case 'turn':
      return turnKind(item);
    default:
      return item[key];
  }
}

/** 按切片分组（名字按字母序）。 */
export function groupBy<T extends Sliceable>(
  items: T[],
  key: SliceKey,
): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = sliceName(item, key);
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function sliceBy(results: CaseResult[], key: SliceKey): Record<string, Slice> {
  return Object.fromEntries(
    groupBy(results, key).map(([name, items]) => [name, slice(items)]),
  );
}

export function summarize(input: {
  outcome: RunOutcome;
  totalCases: number;
  model: EvalModel;
  retrieval: EvalReport['retrieval'];
  budgetUsd: number;
  now?: Date;
}): EvalReport {
  const { results } = input.outcome;
  const n = results.length;
  const predictedNone = results.filter((r) => r.gotFaqId === null);
  const expectedNone = results.filter((r) => r.expectedFaqId === null);
  const trueNone = results.filter(
    (r) => r.gotFaqId === null && r.expectedFaqId === null,
  ).length;
  const latencies = results.map((r) => r.latencyMs);
  const unanswered = results.filter(
    (r) => r.expectedFaqId !== null && r.gotFaqId === null,
  );
  const metrics: EvalReport['metrics'] = {
    accuracy: n ? round(results.filter(isRight).length / n) : 0,
    wrongAnswerRate: n ? round(results.filter(isWrong).length / n) : 0,
    none: {
      precision: predictedNone.length
        ? round(trueNone / predictedNone.length)
        : null,
      recall: expectedNone.length
        ? round(trueNone / expectedNone.length)
        : null,
    },
    latencyMs: {
      p50: Math.round(percentile(latencies, 0.5)),
      p95: Math.round(percentile(latencies, 0.95)),
    },
    costUsd: round(input.outcome.spentUsd, 6),
    tokens: {
      input: results.reduce((sum, r) => sum + r.inputTokens, 0),
      output: results.reduce((sum, r) => sum + r.outputTokens, 0),
    },
    modelAsked: results.filter((r) => r.asked).length,
    retrievalRecall: share(
      results.filter(isReachable).length,
      results.filter((r) => r.expectedFaqId !== null).length,
    ),
    modelRecall: share(
      results.filter((r) => isReachable(r) && isRight(r)).length,
      results.filter(isReachable).length,
    ),
    alternativesRecall: share(
      unanswered.filter(isOffered).length,
      unanswered.length,
    ),
    alternativesOffered: unanswered.filter(isOffered).length,
    unansweredAnswerable: unanswered.length,
    noneWithoutModel: results.filter(
      (r) => r.expectedFaqId === null && r.gotFaqId === null && !r.asked,
    ).length,
    invalidCalls: results.filter((r) => r.asked && !r.validCall && !isFailed(r))
      .length,
    failedRuns: results.filter(isFailed).length,
  };
  const reasons: string[] = [];
  if (metrics.wrongAnswerRate > GATE.wrongAnswerRateMax)
    reasons.push(
      `wrong-answer rate ${(metrics.wrongAnswerRate * 100).toFixed(2)}% > ${GATE.wrongAnswerRateMax * 100}%`,
    );
  if (metrics.latencyMs.p95 > GATE.p95MaxMs)
    reasons.push(`p95 ${metrics.latencyMs.p95} ms > ${GATE.p95MaxMs} ms`);
  if (n && metrics.failedRuns / n > GATE.failedRateMax)
    reasons.push(
      `${metrics.failedRuns} of ${n} cases ended in error, timeout, aborted, rate_limited or no_key (${((metrics.failedRuns / n) * 100).toFixed(2)}%) > ${GATE.failedRateMax * 100}%`,
    );
  if ((metrics.modelRecall ?? 0) < GATE.modelRecallMin)
    reasons.push(
      `model recall ${((metrics.modelRecall ?? 0) * 100).toFixed(1)}% < ${GATE.modelRecallMin * 100}% (answerable cases whose FAQ was retrieved)`,
    );
  if (input.outcome.stopped)
    reasons.push(
      `stopped early (${input.outcome.stopped}) after ${n} of ${input.totalCases} cases`,
    );
  else if (n < input.totalCases)
    reasons.push(`partial run: ${n} of ${input.totalCases} cases (--limit)`);
  if (input.retrieval === 'memory')
    reasons.push(
      'in-memory retrieval only approximates production: rerun with --pg',
    );
  if (input.model.kind === 'fake')
    reasons.push('fake model: not a real-model result');
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    model: {
      ...input.model,
      note:
        input.model.kind === 'fake'
          ? 'No OPENROUTER_API_KEY: fake model (pi faux provider, always the top retrieval candidate). These numbers check the harness, not a model.'
          : null,
    },
    retrieval: input.retrieval,
    budget: {
      capUsd: input.budgetUsd,
      spentUsd: metrics.costUsd,
      stopped: input.outcome.stopped,
    },
    cases: { total: input.totalCases, run: n },
    metrics,
    byPersona: sliceBy(results, 'persona'),
    byLocale: sliceBy(results, 'locale'),
    byRole: sliceBy(results, 'role'),
    byLanguage: sliceBy(results, 'language'),
    byTurn: sliceBy(results, 'turn'),
    failures: results
      .filter((r) => !isRight(r))
      .map((r) => ({
        id: r.id,
        locale: r.locale,
        persona: r.persona,
        message: r.message,
        expectedFaqId: r.expectedFaqId,
        gotFaqId: r.gotFaqId,
        reason: r.reason,
        latencyMs: Math.round(r.latencyMs),
        kind: isWrong(r) ? ('wrong_answer' as const) : ('missed' as const),
        stage: isFailed(r)
          ? ('error' as const)
          : r.expectedFaqId !== null && !isReachable(r)
            ? ('retrieval' as const)
            : ('model' as const),
      })),
    gate: {
      ...GATE,
      pass: reasons.length === 0,
      reasons,
    },
  };
}

const pct = (value: number | null) =>
  value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;

export function markdownReport(report: EvalReport): string {
  const rows = (slices: Record<string, Slice>) =>
    Object.entries(slices)
      .map(
        ([name, s]) =>
          `| ${name} | ${s.cases} | ${pct(s.accuracy)} | ${pct(s.wrongAnswerRate)} |`,
      )
      .join('\n');
  const lines = [
    `# Helpdesk suggestion eval`,
    '',
    `- Generated: ${report.generatedAt}`,
    `- Model: ${report.model.kind} \`${report.model.model}\`${thinkingLabel(report.model)}${report.model.note ? ` (${report.model.note})` : ''}`,
    `- Retrieval: ${report.retrieval}`,
    `- Cases: ${report.cases.run} of ${report.cases.total}`,
    `- Budget: $${report.budget.spentUsd.toFixed(4)} of $${report.budget.capUsd.toFixed(2)}${report.budget.stopped ? ` (stopped: ${report.budget.stopped})` : ''}`,
    '',
    `## Gate: ${report.gate.pass ? 'PASS' : 'FAIL'}`,
    '',
    `Wrong-answer rate ≤ ${report.gate.wrongAnswerRateMax * 100}%, p95 ≤ ${report.gate.p95MaxMs} ms, ` +
      `error / timeout ≤ ${report.gate.failedRateMax * 100}%, model recall ≥ ${report.gate.modelRecallMin * 100}%, ` +
      'on the full set with PostgreSQL retrieval and a real model.',
    ...report.gate.reasons.map((reason) => `- ${reason}`),
    '',
    '## Metrics',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Accuracy | ${pct(report.metrics.accuracy)} |`,
    `| Wrong-answer rate | ${pct(report.metrics.wrongAnswerRate)} |`,
    `| none precision | ${pct(report.metrics.none.precision)} |`,
    `| none recall | ${pct(report.metrics.none.recall)} |`,
    `| Latency p50 / p95 | ${report.metrics.latencyMs.p50} / ${report.metrics.latencyMs.p95} ms |`,
    `| Cost | $${report.metrics.costUsd.toFixed(6)} |`,
    `| Tokens in / out | ${report.metrics.tokens.input} / ${report.metrics.tokens.output} |`,
    `| Model asked | ${report.metrics.modelAsked} of ${report.cases.run} |`,
    `| Retrieval recall@8 | ${pct(report.metrics.retrievalRecall)} |`,
    `| Model recall (FAQ retrieved) | ${pct(report.metrics.modelRecall)} |`,
    `| Alternatives recall (answerable, no answer) | ${pct(report.metrics.alternativesRecall)} (${report.metrics.alternativesOffered} of ${report.metrics.unansweredAnswerable}) |`,
    `| none without the model | ${report.metrics.noneWithoutModel} |`,
    `| Invalid tool calls | ${report.metrics.invalidCalls} |`,
    `| Ended in error / timeout | ${report.metrics.failedRuns} |`,
    '',
    '## By persona',
    '',
    '| Persona | Cases | Accuracy | Wrong |',
    '| --- | --- | --- | --- |',
    rows(report.byPersona),
    '',
    '## By locale',
    '',
    '| Locale | Cases | Accuracy | Wrong |',
    '| --- | --- | --- | --- |',
    rows(report.byLocale),
    '',
    '## By language',
    '',
    'Locale, with mixed-language cases (persona `mixed_language`) counted as `mixed`.',
    '',
    '| Language | Cases | Accuracy | Wrong |',
    '| --- | --- | --- | --- |',
    rows(report.byLanguage),
    '',
    '## By role',
    '',
    '| Role | Cases | Accuracy | Wrong |',
    '| --- | --- | --- | --- |',
    rows(report.byRole),
    '',
    '## By turn',
    '',
    '`follow_up` turns are labelled in the context of their conversation, but every turn is scored on its own, without the earlier turns.',
    '',
    '| Turn | Cases | Accuracy | Wrong |',
    '| --- | --- | --- | --- |',
    rows(report.byTurn),
    '',
    `## Failures (${report.failures.length})`,
    '',
    '| Case | Kind | Stage | Expected | Got | Reason |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.failures.map(
      (f) =>
        `| ${f.id} | ${f.kind} | ${f.stage} | ${f.expectedFaqId ?? 'none'} | ${f.gotFaqId ?? 'none'} | ${f.reason ?? ''} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

/* ------------------------------ 只跑检索（--retrieval-only） ------------------------------ */

/** recall@k 的 k：第一个候选、前三个、送给模型的全部 8 个。 */
export const RETRIEVAL_KS = [1, 3, SUGGEST_CANDIDATES] as const;

/** 和推荐工作流（faq-workflow 的 retrieve 步）完全相同的检索请求。 */
export function retrievalQuery(item: EvalCase): HelpdeskQaSearch {
  const submit = item.source === 'submit';
  return {
    locale: serviceLocale(item.locale),
    category: submit ? faqCategoryFor(item.category) : null,
    text: initialFaqState({
      locale: serviceLocale(item.locale),
      category: null,
      subject: submit ? (item.subject ?? '').trim() : '',
      message: item.message.trim(),
    }).queryText,
    limit: SUGGEST_CANDIDATES,
  };
}

export type RetrievalResult = Pick<
  CaseResult,
  | 'id'
  | 'locale'
  | 'persona'
  | 'role'
  | 'conversationId'
  | 'turn'
  | 'message'
  | 'expectedFaqId'
  | 'acceptableFaqIds'
  | 'candidateIds'
  | 'latencyMs'
>;

/** 每条用例只调一次检索（不问模型、不写日志、不限流），记下候选顺序与耗时。 */
export async function runRetrieval(options: {
  cases: EvalCase[];
  qa: HelpdeskQaSource;
  onCase?: (result: RetrievalResult, index: number) => void;
}): Promise<RetrievalResult[]> {
  const results: RetrievalResult[] = [];
  for (const [index, item] of options.cases.entries()) {
    const query = retrievalQuery(item);
    const started = performance.now();
    const found =
      query.text === '' ? [] : await options.qa.findCandidates(query);
    const latencyMs = performance.now() - started;
    const result: RetrievalResult = {
      id: item.id,
      locale: item.locale,
      persona: item.persona,
      role: item.role ?? null,
      conversationId: item.conversationId ?? null,
      turn: item.turn ?? null,
      message: item.message,
      expectedFaqId: item.expectedFaqId,
      acceptableFaqIds: item.acceptableFaqIds ?? [],
      candidateIds: found.slice(0, query.limit).map((c) => c.id),
      latencyMs,
    };
    results.push(result);
    options.onCase?.(result, index);
  }
  return results;
}

export type RecallSlice = {
  cases: number;
  /** expectedFaqId 不为 null 的用例：recall 只在这些上算。 */
  answerable: number;
  recallAt1: number | null;
  recallAt3: number | null;
  recallAt8: number | null;
  /** 找到时（前 8 内），第一个可接受的 FAQ 的平均名次（1 起）。 */
  meanRank: number | null;
  /** 该是 none 的用例里，检索一个候选都没给（不会问模型）的比例。 */
  noneEmpty: number | null;
};

export type RetrievalReport = {
  kind: 'retrieval-only';
  generatedAt: string;
  retrieval: 'memory' | 'postgresql';
  note: string;
  faqs: number;
  cases: { total: number; run: number };
  overall: RecallSlice;
  latencyMs: { p50: number; p95: number; max: number };
  byLocale: Record<string, RecallSlice>;
  byLanguage: Record<string, RecallSlice>;
  byPersona: Record<string, RecallSlice>;
  byRole: Record<string, RecallSlice>;
  byTurn: Record<string, RecallSlice>;
  /** 该有答案、可接受的 FAQ 却都不在 8 个候选里的用例。 */
  misses: Pick<
    RetrievalResult,
    | 'id'
    | 'locale'
    | 'persona'
    | 'role'
    | 'message'
    | 'expectedFaqId'
    | 'acceptableFaqIds'
    | 'candidateIds'
  >[];
};

/** 第一个可接受的 FAQ（expected 或 acceptable）在候选里的名次（1 起）；没有为 null。 */
export function acceptedRank(r: RetrievalResult): number | null {
  if (r.expectedFaqId === null) return null;
  const accepted = new Set([r.expectedFaqId, ...r.acceptableFaqIds]);
  const index = r.candidateIds.findIndex((id) => accepted.has(id));
  return index < 0 ? null : index + 1;
}

function recallSlice(results: RetrievalResult[]): RecallSlice {
  const answerable = results.filter((r) => r.expectedFaqId !== null);
  const ranks = answerable.map(acceptedRank);
  const at = (k: number) =>
    share(
      ranks.filter((rank) => rank !== null && rank <= k).length,
      answerable.length,
    );
  const found = ranks.filter((rank): rank is number => rank !== null);
  const none = results.filter((r) => r.expectedFaqId === null);
  return {
    cases: results.length,
    answerable: answerable.length,
    recallAt1: at(RETRIEVAL_KS[0]),
    recallAt3: at(RETRIEVAL_KS[1]),
    recallAt8: at(RETRIEVAL_KS[2]),
    meanRank: found.length
      ? round(found.reduce((sum, rank) => sum + rank, 0) / found.length, 2)
      : null,
    noneEmpty: share(
      none.filter((r) => r.candidateIds.length === 0).length,
      none.length,
    ),
  };
}

function recallBy(
  results: RetrievalResult[],
  key: SliceKey,
): Record<string, RecallSlice> {
  return Object.fromEntries(
    groupBy(results, key).map(([name, items]) => [name, recallSlice(items)]),
  );
}

export function summarizeRetrieval(input: {
  results: RetrievalResult[];
  totalCases: number;
  retrieval: RetrievalReport['retrieval'];
  faqs: number;
  now?: Date;
}): RetrievalReport {
  const { results } = input;
  const latencies = results.map((r) => r.latencyMs);
  return {
    kind: 'retrieval-only',
    generatedAt: (input.now ?? new Date()).toISOString(),
    retrieval: input.retrieval,
    note:
      'Retrieval only: no model was asked. ' +
      (input.retrieval === 'postgresql'
        ? 'Candidates come from the production candidate SQL on PostgreSQL.'
        : 'In-memory retrieval only approximates the production SQL: rerun with --pg.'),
    faqs: input.faqs,
    cases: { total: input.totalCases, run: results.length },
    overall: recallSlice(results),
    latencyMs: {
      p50: Math.round(percentile(latencies, 0.5)),
      p95: Math.round(percentile(latencies, 0.95)),
      max: Math.round(Math.max(0, ...latencies)),
    },
    byLocale: recallBy(results, 'locale'),
    byLanguage: recallBy(results, 'language'),
    byPersona: recallBy(results, 'persona'),
    byRole: recallBy(results, 'role'),
    byTurn: recallBy(results, 'turn'),
    misses: results
      .filter((r) => r.expectedFaqId !== null && acceptedRank(r) === null)
      .map((r) => ({
        id: r.id,
        locale: r.locale,
        persona: r.persona,
        role: r.role,
        message: r.message,
        expectedFaqId: r.expectedFaqId,
        acceptableFaqIds: r.acceptableFaqIds,
        candidateIds: r.candidateIds,
      })),
  };
}

const EVAL_FAQ_ID = /^0192f0e0-0000-7000-8000-0{9}(\d{3})$/;
/** 评测库的 id 只显示末三位（001 … 035）；别的 id 原样显示。 */
const shortId = (id: string) => EVAL_FAQ_ID.exec(id)?.[1] ?? id;
const cell = (text: string, max = 80) => {
  const flat = text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function markdownRetrievalReport(report: RetrievalReport): string {
  const o = report.overall;
  const rows = (slices: Record<string, RecallSlice>) =>
    Object.entries(slices)
      .map(
        ([name, s]) =>
          `| ${name} | ${s.cases} | ${s.answerable} | ${pct(s.recallAt1)} | ${pct(s.recallAt3)} | ${pct(s.recallAt8)} | ${s.meanRank === null ? 'n/a' : s.meanRank.toFixed(1)} | ${pct(s.noneEmpty)} |`,
      )
      .join('\n');
  const table = (
    title: string,
    label: string,
    slices: Record<string, RecallSlice>,
    intro?: string,
  ) => [
    `## ${title}`,
    '',
    ...(intro ? [intro, ''] : []),
    `| ${label} | Cases | Answerable | Recall@1 | Recall@3 | Recall@8 | Mean rank | none: no candidates |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    rows(slices),
    '',
  ];
  return [
    '# Helpdesk retrieval eval (retrieval only, no model)',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Retrieval: ${report.retrieval}`,
    `- FAQs: ${report.faqs}`,
    `- Cases: ${report.cases.run} of ${report.cases.total}`,
    `- ${report.note}`,
    '',
    'Recall@k: share of answerable cases (expectedFaqId not null) whose expected FAQ, or an acceptable one, is among the first k candidates. The model sees 8.',
    '',
    '## Overall',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Answerable cases | ${o.answerable} of ${o.cases} |`,
    `| Recall@1 / @3 / @8 | ${pct(o.recallAt1)} / ${pct(o.recallAt3)} / ${pct(o.recallAt8)} |`,
    `| Mean rank when found | ${o.meanRank === null ? 'n/a' : o.meanRank.toFixed(2)} |`,
    `| none cases with no candidates (model not asked) | ${pct(o.noneEmpty)} |`,
    `| Retrieval latency p50 / p95 / max | ${report.latencyMs.p50} / ${report.latencyMs.p95} / ${report.latencyMs.max} ms |`,
    '',
    ...table('By locale', 'Locale', report.byLocale),
    ...table(
      'By language',
      'Language',
      report.byLanguage,
      'Locale, with mixed-language cases (persona `mixed_language`) counted as `mixed`.',
    ),
    ...table('By case type', 'Case type', report.byPersona),
    ...table('By role', 'Role', report.byRole),
    ...table(
      'By turn',
      'Turn',
      report.byTurn,
      '`follow_up` turns are labelled in the context of their conversation but retrieved on their own text.',
    ),
    `## Misses (${report.misses.length})`,
    '',
    'Answerable cases whose expected or acceptable FAQ is not among the 8 candidates.',
    '',
    '| Case | Locale | Case type | Expected | Also accepted | Candidates | Message |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.misses.map(
      (m) =>
        `| ${m.id} | ${m.locale} | ${m.persona} | ${m.expectedFaqId ? shortId(m.expectedFaqId) : 'none'} | ${m.acceptableFaqIds.length ? m.acceptableFaqIds.map(shortId).join(', ') : '—'} | ${m.candidateIds.length ? m.candidateIds.map(shortId).join(', ') : '—'} | ${cell(m.message)} |`,
    ),
    '',
  ].join('\n');
}

/** .md 写 Markdown，其它写 JSON（推荐评测或只跑检索的报告）。 */
export function writeReport(
  path: string,
  report: EvalReport | RetrievalReport,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const markdown = () =>
    'kind' in report && report.kind === 'retrieval-only'
      ? markdownRetrievalReport(report)
      : markdownReport(report as EvalReport);
  writeFileSync(
    path,
    path.endsWith('.md') ? markdown() : `${JSON.stringify(report, null, 2)}\n`,
  );
}

export function budgetFrom(env: NodeJS.ProcessEnv): number {
  return readHelpdeskSettingStrict(HELPDESK_SETTINGS.evalBudgetUsd, env);
}

export type { FaqCategory };
