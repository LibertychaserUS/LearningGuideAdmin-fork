import { Logger } from '@nestjs/common';

import { HELPDESK_DEFAULTS, HELPDESK_OFF } from './helpdesk-defaults';

/**
 * Helpdesk 的运行配置（环境变量 HELPDESK_*）只在这里读（owner 2026-11-09：「抽象不够高导致的读数问题」）。
 *
 * 以前 18 个变量散在 15 处，各写各的解析：有的写错回缺省，有的写错关掉，有的抛错；有的分大小写，有的不分；
 * Number('') 是 0，所以「0.8,」被当成 0.8 / 0。现在分三层，调用方只拿到类型化的值：
 * 1. 取词：原文去首尾空白；空 = 没设 → 缺省。解析器拿到的永远是非空的一段字（不会把空当 0）。
 * 2. 解析器：一个值是什么样子只定义一次（开关、枚举、模型名、整数、小数、「关或 X」、逗号隔开的一组），
 *    组合出每个变量；数字只认十进制写法（不收 1e3、0x10、空格、正负号以外的东西）。
 * 3. 声明表 HELPDESK_SETTINGS：每个变量一行（名字、解析器、缺省、用途），全仓库只有这一张表。
 *
 * 写错的统一策略：线上读（readHelpdeskSetting）回到缺省并告警一次（同一个变量的同一个写法只报一次，
 * 改对了或换个写法会再报）；评测 / 命令行工具读（readHelpdeskSettingStrict）直接抛错、说明正确写法。
 * 每次调用都现读环境变量（配置热更新，不用重新部署）。
 */

export type SettingResult<T> =
  { ok: true; value: T } | { ok: false; expected: string };

export type SettingParser<T> = {
  /** 正确写法的说明（告警与报错里用）。 */
  readonly expected: string;
  /** token：已去首尾空白、非空。 */
  parse(token: string): SettingResult<T>;
};

const ok = <T>(value: T): SettingResult<T> => ({ ok: true, value });

function parser<T>(
  expected: string,
  parse: (token: string) => T | undefined,
): SettingParser<T> {
  return {
    expected,
    parse: (token) => {
      const value = parse(token);
      return value === undefined ? { ok: false, expected } : ok(value);
    },
  };
}

/** 十进制写法：可带一个小数点，不收空、指数、十六进制、正号、空格。 */
const DECIMAL = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;
const WHOLE = /^\d+$/;
/** OpenRouter 的模型 id：厂商/模型（可带 :free 之类的后缀）。 */
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

type Range = {
  min: number;
  max: number;
  /** 不含端点（缺省两端都含）。 */
  minExclusive?: boolean;
  maxExclusive?: boolean;
};

function rangeText(range: Range): string {
  return `${range.min}${range.minExclusive ? ' (exclusive)' : ''} to ${range.max}${range.maxExclusive ? ' (exclusive)' : ''}`;
}

function inRange(n: number, range: Range): boolean {
  return (
    (range.minExclusive ? n > range.min : n >= range.min) &&
    (range.maxExclusive ? n < range.max : n <= range.max)
  );
}

export const settingParsers = {
  /** on / off（不分大小写）。 */
  onOff: (): SettingParser<boolean> =>
    parser('on or off', (t) => {
      const v = t.toLowerCase();
      return v === 'on' ? true : v === HELPDESK_OFF ? false : undefined;
    }),

  /** 几个固定的词之一（不分大小写）。 */
  oneOf: <T extends string>(values: readonly T[]): SettingParser<T> =>
    parser(`one of ${values.join(', ')}`, (t) =>
      values.find((v) => v === t.toLowerCase()),
    ),

  /** OpenRouter 模型 id。 */
  model: (): SettingParser<string> =>
    parser('an OpenRouter model id such as vendor/model', (t) =>
      MODEL_ID.test(t) ? t : undefined,
    ),

  wholeNumber: (range: Range): SettingParser<number> =>
    parser(`a whole number from ${rangeText(range)}`, (t) => {
      if (!WHOLE.test(t)) return undefined;
      const n = Number(t);
      return inRange(n, range) ? n : undefined;
    }),

  decimal: (range: Range): SettingParser<number> =>
    parser(`a decimal number from ${rangeText(range)}`, (t) => {
      if (!DECIMAL.test(t)) return undefined;
      const n = Number(t);
      return Number.isFinite(n) && inRange(n, range) ? n : undefined;
    }),

  /** off（不分大小写）= null，其余交给 inner。 */
  offOr: <T>(inner: SettingParser<T>): SettingParser<T | null> => {
    const expected = `off, or ${inner.expected}`;
    return {
      expected,
      parse: (t) => {
        if (t.toLowerCase() === HELPDESK_OFF) return ok(null);
        const r = inner.parse(t);
        return r.ok ? r : { ok: false, expected };
      },
    };
  },

  /** 逗号隔开、个数固定的一组；每一段各自去空白，空的一段算写错。 */
  pair: <A, B>(
    first: SettingParser<A>,
    second: SettingParser<B>,
  ): SettingParser<[A, B]> => {
    const expected = `two values separated by a comma: ${first.expected}, then ${second.expected}`;
    return {
      expected,
      parse: (t) => {
        const parts = t.split(',').map((part) => part.trim());
        if (parts.length !== 2 || parts.some((part) => part === ''))
          return { ok: false, expected };
        const a = first.parse(parts[0]);
        const b = second.parse(parts[1]);
        return a.ok && b.ok ? ok([a.value, b.value]) : { ok: false, expected };
      },
    };
  },

  /** 解析成功后再换个形状（例如数组 → 对象）。 */
  map: <A, B>(inner: SettingParser<A>, fn: (a: A) => B): SettingParser<B> => ({
    expected: inner.expected,
    parse: (t) => {
      const r = inner.parse(t);
      return r.ok ? ok(fn(r.value)) : r;
    },
  }),
} as const;

export type HelpdeskSettingDef<T> = {
  readonly name: `HELPDESK_${string}`;
  readonly parser: SettingParser<T>;
  /** 没设、空、或（线上）写错时的值；函数 = 每次给一份新的（对象类缺省不被调用方改坏）。 */
  readonly fallback: T | (() => T);
  /** 一句话：它管什么。 */
  readonly purpose: string;
  /** 只给评测 / 命令行用（线上代码不读）。 */
  readonly evalOnly?: boolean;
};

function setting<T>(def: HelpdeskSettingDef<T>): HelpdeskSettingDef<T> {
  return def;
}

const p = settingParsers;
const fraction = p.decimal({ min: 0, max: 1 });

/* --------------------------- 配置词表（各模块从这里取） --------------------------- */

export const THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export type ThinkingSetting = (typeof THINKING_LEVELS)[number];
export const RETRIEVAL_MODES = ['lexical', 'vector', 'hybrid'] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];
export const LOCATOR_MODES = ['flat', 'hybrid'] as const;
export type LocatorMode = (typeof LOCATOR_MODES)[number];
export const SEARCH_SCOPES = ['tree', 'all'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/** 精排直出的两个界（score：第一名的分数下限；margin：领先第二名的差距下限）。 */
export type RerankDirect = { score: number; margin: number };

/**
 * 全部 Helpdesk 配置，一个变量一行。加变量 = 在这里加一行；别处不许直接读 env.HELPDESK_*
 * （helpdesk-settings.spec.ts 扫源码锁住）。
 */
export const HELPDESK_SETTINGS = {
  suggestModel: setting({
    name: 'HELPDESK_SUGGEST_MODEL',
    parser: p.model(),
    fallback: HELPDESK_DEFAULTS.model,
    purpose: 'L3 model that picks the card, explains and makes small talk',
  }),
  suggestThinking: setting({
    name: 'HELPDESK_SUGGEST_THINKING',
    parser: p.oneOf(THINKING_LEVELS),
    fallback: HELPDESK_DEFAULTS.thinking,
    purpose: 'thinking level of the chat model',
  }),
  embedModel: setting({
    name: 'HELPDESK_EMBED_MODEL',
    parser: p.offOr(p.model()),
    fallback: HELPDESK_DEFAULTS.embedModel,
    purpose: 'L1 embedding model; off = no vectors',
  }),
  rerankModel: setting({
    name: 'HELPDESK_RERANK_MODEL',
    parser: p.offOr(p.model()),
    fallback: HELPDESK_DEFAULTS.rerankModel,
    purpose: 'L2 rerank model; off = keep the recall order',
  }),
  rerankKeep: setting({
    name: 'HELPDESK_RERANK_KEEP',
    parser: p.offOr(p.wholeNumber({ min: 1, max: 50 })),
    fallback: HELPDESK_DEFAULTS.rerankKeep,
    purpose: 'candidates kept for the model after rerank; off = all',
  }),
  rerankDirect: setting<RerankDirect | null>({
    name: 'HELPDESK_RERANK_DIRECT',
    parser: p.offOr(
      p.map(p.pair(fraction, fraction), ([score, margin]) => ({
        score,
        margin,
      })),
    ),
    fallback: () => ({ ...HELPDESK_DEFAULTS.rerankDirect }),
    purpose:
      'score,lead at which rerank sends the top card without the model; off = never',
  }),
  searchScope: setting({
    name: 'HELPDESK_SEARCH_SCOPE',
    parser: p.oneOf(SEARCH_SCOPES),
    fallback: HELPDESK_DEFAULTS.searchScope,
    purpose: 'which cards retrieval sees: all (flat) or tree',
  }),
  queryContext: setting({
    name: 'HELPDESK_QUERY_CONTEXT',
    parser: p.onOff(),
    fallback: HELPDESK_DEFAULTS.queryContext,
    purpose: 'vector and rerank also query with the previous message',
  }),
  cardContext: setting({
    name: 'HELPDESK_CARD_CONTEXT',
    parser: p.onOff(),
    fallback: false,
    purpose: 'follow-up candidates carry their parent question',
  }),
  multiAsk: setting({
    name: 'HELPDESK_MULTI_ASK',
    parser: p.onOff(),
    fallback: HELPDESK_DEFAULTS.multiAsk,
    purpose: 'one card per ask when a message asks several things',
  }),
  retrieval: setting<RetrievalMode>({
    name: 'HELPDESK_RETRIEVAL',
    parser: p.oneOf(RETRIEVAL_MODES),
    fallback: 'lexical',
    purpose: 'old single-path retrieval switch (lexical, vector, hybrid)',
  }),
  locator: setting<LocatorMode>({
    name: 'HELPDESK_LOCATOR',
    parser: p.oneOf(LOCATOR_MODES),
    fallback: 'flat',
    purpose: 'card locator: flat retrieval or SOP-tree hybrid',
  }),
  releaseModelEval: setting<boolean | null>({
    name: 'HELPDESK_RELEASE_MODEL_EVAL',
    parser: p.onOff(),
    fallback: null,
    purpose:
      'release check also runs the real-model eval; unset = on when it is assembled',
  }),
  evalCache: setting({
    name: 'HELPDESK_EVAL_CACHE',
    parser: p.onOff(),
    fallback: true,
    purpose: 'release check reuses cached model answers for unchanged inputs',
  }),
  demoData: setting({
    name: 'HELPDESK_DEMO_DATA',
    parser: p.onOff(),
    fallback: true,
    purpose: 'deployed DEV seeds the demo library once',
  }),
  modelHealthAlert: setting({
    name: 'HELPDESK_MODEL_HEALTH_ALERT',
    parser: p.decimal({
      min: 0,
      max: 1,
      minExclusive: true,
      maxExclusive: true,
    }),
    fallback: HELPDESK_DEFAULTS.modelHealthAlert,
    purpose: 'model-health alert threshold (share of failed steps)',
  }),
  evalDeadlineMs: setting<number | null>({
    name: 'HELPDESK_EVAL_DEADLINE_MS',
    parser: p.wholeNumber({ min: 1, max: 600_000 }),
    fallback: null,
    purpose: 'eval only: relaxed total deadline in ms (unset = production)',
    evalOnly: true,
  }),
  evalCutoffMs: setting<number | null>({
    name: 'HELPDESK_EVAL_CUTOFF_MS',
    parser: p.wholeNumber({ min: 0, max: 600_000 }),
    fallback: null,
    purpose:
      'eval only: thinking cutoff in ms, 0 = no fallback (unset = production)',
    evalOnly: true,
  }),
  evalBudgetUsd: setting({
    name: 'HELPDESK_EVAL_BUDGET_USD',
    parser: p.decimal({ min: 0, max: 10_000, minExclusive: true }),
    fallback: 5,
    purpose: 'eval only: spend cap in USD',
    evalOnly: true,
  }),
} as const;

export type HelpdeskSettingKey = keyof typeof HELPDESK_SETTINGS;

/* ---------------------------------- 读取 ---------------------------------- */

export type SettingProblem = {
  name: string;
  /** 写的原文（配置不是密钥；仍截到 80 字，防止日志被灌）。 */
  value: string;
  expected: string;
};

type Outcome<T> = { value: T; problem: SettingProblem | null };

function fallbackOf<T>(def: HelpdeskSettingDef<T>): T {
  return typeof def.fallback === 'function'
    ? (def.fallback as () => T)()
    : def.fallback;
}

function evaluate<T>(
  def: HelpdeskSettingDef<T>,
  env: NodeJS.ProcessEnv,
): Outcome<T> {
  const raw = env[def.name];
  const token = raw?.trim() ?? '';
  if (token === '') return { value: fallbackOf(def), problem: null };
  const parsed = def.parser.parse(token);
  if (parsed.ok) return { value: parsed.value, problem: null };
  return {
    value: fallbackOf(def),
    problem: {
      name: def.name,
      value: token.slice(0, 80),
      expected: parsed.expected,
    },
  };
}

const logger = new Logger('HelpdeskSettings');
/** 已经报过的「变量=写法」（同一个写错只报一次；进程内）。 */
const reported = new Set<string>();

export type SettingReporter = (problem: SettingProblem) => void;

const warnOnce: SettingReporter = (problem) => {
  const id = `${problem.name}=${problem.value}`;
  if (reported.has(id)) return;
  reported.add(id);
  logger.warn(
    `${problem.name}="${problem.value}" is not valid (expected ${problem.expected}); using the default`,
  );
};

/** 线上读：写错 → 缺省 + 告警一次。 */
export function readHelpdeskSetting<T>(
  def: HelpdeskSettingDef<T>,
  env: NodeJS.ProcessEnv = process.env,
  report: SettingReporter = warnOnce,
): T {
  const { value, problem } = evaluate(def, env);
  if (problem) report(problem);
  return value;
}

/** 评测 / 命令行读：写错直接抛错（说明正确写法），不悄悄换成缺省。 */
export function readHelpdeskSettingStrict<T>(
  def: HelpdeskSettingDef<T>,
  env: NodeJS.ProcessEnv = process.env,
): T {
  const { value, problem } = evaluate(def, env);
  if (problem) throw new Error(`${problem.name} must be ${problem.expected}`);
  return value;
}

/** 当前环境里所有写错的配置（启动检查、健康页用）。 */
export function helpdeskSettingProblems(
  env: NodeJS.ProcessEnv = process.env,
): SettingProblem[] {
  return Object.values(HELPDESK_SETTINGS)
    .map((def) => evaluate(def as HelpdeskSettingDef<unknown>, env).problem)
    .filter((problem): problem is SettingProblem => problem !== null);
}
