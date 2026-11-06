/**
 * Helpdesk FAQ 的跨域契约（Tickets v2 Figma addendum §1 / §2）。
 *
 * - FAQ 库（helpdesk_faqs）归 BackOffice（admin 角色）写，是唯一写入方；
 * - 推荐（helpdesk_suggestions）归 Agent（agent 角色）写；
 * 两边互不 import 实现（eslint no-restricted-imports），Agent 只经这里的 HelpdeskQaSource
 * 读已发布的 FAQ（候选检索、按 id 取一条）。具体实现由 app.module.ts 组装。
 */
export const HELPDESK_LOCALES = ['en-GB', 'zh-CN'] as const;
export type HelpdeskLocale = (typeof HELPDESK_LOCALES)[number];

/** 工单的 Enquiry Type（Figma 1216:6，Portal 的工单 category）。 */
export const HELPDESK_CATEGORIES = [
  'technical_support',
  'course_content',
  'payments_subscriptions',
  'other',
] as const;
export type HelpdeskCategory = (typeof HELPDESK_CATEGORIES)[number];

/** FAQ 的分类（Figma 1379:2 / 1387:2；v2 §1）。 */
export const FAQ_CATEGORIES = [
  'account_technical',
  'courses_learning',
  'payments_subscriptions',
  'other',
] as const;
export type FaqCategory = (typeof FAQ_CATEGORIES)[number];

/** 工单类型 → 同一主题的 FAQ 分类（推荐时同类加权用）。 */
const TICKET_TO_FAQ: Record<HelpdeskCategory, FaqCategory> = {
  technical_support: 'account_technical',
  course_content: 'courses_learning',
  payments_subscriptions: 'payments_subscriptions',
  other: 'other',
};

export function isHelpdeskLocale(value: unknown): value is HelpdeskLocale {
  return (HELPDESK_LOCALES as readonly unknown[]).includes(value);
}

export function isHelpdeskCategory(value: unknown): value is HelpdeskCategory {
  return (HELPDESK_CATEGORIES as readonly unknown[]).includes(value);
}

export function isFaqCategory(value: unknown): value is FaqCategory {
  return (FAQ_CATEGORIES as readonly unknown[]).includes(value);
}

/** 工单类型或 FAQ 分类 → FAQ 分类；都不是返回 null。 */
export function faqCategoryFor(value: unknown): FaqCategory | null {
  if (isFaqCategory(value)) return value;
  if (isHelpdeskCategory(value)) return TICKET_TO_FAQ[value];
  return null;
}

export type HelpdeskQaCandidate = {
  id: string;
  category: FaqCategory;
  /** 该语言的问题。 */
  question: string;
  /** 该语言的已审核答案（Markdown 子集）；展示给学员时一字不改。 */
  answer: string;
  /** 检索得分，越大越相关（只用于排序与日志）。 */
  score: number;
  /**
   * v5 问题树（helpdesk-v5-faq-graph-design §4，增量；旧的调用方不读）：节点类型、是否入口、
   * 该语言的答案块（answer 节点；发布版本里是冻结时切好的，之前按同一规则现切）、
   * 哪些 choice 节点把它当选项（「几个候选都是同一个 choice 节点的选项」时显示那个 choice 节点），
   * 以及它为什么在候选里：child = 屏幕上那张卡片的子节点，sibling = 同一棵树上的近亲（父节点的其它
   * 子节点，以及更上层的祖先和祖先的其它子节点，只在检索命中时进来），search = 检索命中。
   */
  type?: FaqNodeType;
  entry?: boolean;
  blocks?: FaqBlock[];
  optionOf?: string[];
  relation?: 'child' | 'sibling' | 'search';
  /** 精排分数（ai/helpdesk/rerank.ts，只在开了 HELPDESK_RERANK_MODEL 时有），越大越相关。 */
  rerankScore?: number;
  /**
   * 追问卡片：它跟在哪张卡片下面（发布版本里那张父卡片的问题，同一语言）。追问的问题是接着父卡片问的
   * （如「手机上也有吗？」），单独看缺上下文；HELPDESK_CARD_CONTEXT=on 时给精排和挑卡模型一起看。
   */
  under?: string;
};

export type HelpdeskQaSearch = {
  locale: string;
  /** 同类加权用的 FAQ 分类；没有则不加权。 */
  category: FaqCategory | null;
  text: string;
  limit: number;
  /**
   * v5 问题树（增量，都可不给）：
   * - nodeId：屏幕上的卡片（context.nodeId）。给了 → 先是它的子节点（全部，按得分、再按顺序），
   *   再是树上近亲（父节点的其它子节点、祖先、祖先的其它子节点）里命中的，最后才是普通检索；
   * - entryOnly：普通检索只要入口节点（缺省 true；子节点 / 近亲不受它限制）；
   * - types：普通检索要哪些节点类型（缺省 ['answer']：旧的 Portal 不会渲染 choice 节点）；
   * - deepReserved：entryOnly 时另给检索命中的非入口 answer 节点留至多这么多个位置（缺省 0）：
   *   用户一上来就问到只有某个追问才答的细节。
   */
  nodeId?: string;
  entryOnly?: boolean;
  types?: FaqNodeType[];
  deepReserved?: number;
  /**
   * 前文（HELPDESK_QUERY_CONTEXT）：学员的上一条原文。只给向量与精排那一路用（另按「前文 → 本句」再查一次，
   * 取两次中更高的分），字词检索不看它：「微信支付呢」「要多久」这种短追问单看找不到卡。
   */
  context?: string;
};

/** 热门已发布 FAQ（v3 §1「你可能想问」：检索不到候选时的兜底）。 */
export type HelpdeskQaPopularSearch = {
  locale: string;
  /** 这一类排在前面；null 不分先后。 */
  category: FaqCategory | null;
  /** 不要这些 FAQ（刚给学员看过的）。 */
  excludeIds: string[];
  limit: number;
};

export const HELPDESK_QA_SOURCE = Symbol('HELPDESK_QA_SOURCE');

/** 已发布 FAQ 的只读来源（实现归 BackOffice）。 */
export interface HelpdeskQaSource {
  /** 候选检索（全文 + 关键词 + 中文双字 + 同类加权）；没有匹配返回空数组。 */
  findCandidates(search: HelpdeskQaSearch): Promise<HelpdeskQaCandidate[]>;
  /** 按 id 取一条已发布 FAQ 的该语言版本（score 为 0）；没有或已归档返回 null。 */
  findPublished(
    id: string,
    locale: string,
  ): Promise<HelpdeskQaCandidate | null>;
  /**
   * 热门（popular）的已发布 FAQ 的该语言版本（score 为 0）：category 那一类在前，再按更新时间倒序；
   * 不含 excludeIds。只用代码，不问模型。
   */
  findPopular(search: HelpdeskQaPopularSearch): Promise<HelpdeskQaCandidate[]>;
  /**
   * v5：运行时读的是哪个发布版本（assist log 的 release_version）；第一版发布之前 null。
   * 可选：旧的实现与单测的假来源不必提供。
   */
  releaseVersion?(): Promise<number | null>;
  /**
   * 分级 L1 的向量那一路（精排开着时才用）：发布版本里和问题最像的至多 limit 个 answer / choice 节点
   * （含非入口），按相似度从高到低，score 为相似度。没有向量模型、还没算好、失败或超时 → []。
   * 可选：没有向量检索的来源不必提供。
   */
  findVectorCandidates?(search: {
    locale: string;
    text: string;
    limit: number;
  }): Promise<HelpdeskQaCandidate[]>;
}

// ---------------------------------------------------------------------------
// Helpdesk v5（契约 fixture v6，2026-10-30）：学员情境信号、FAQ 问题树的发布快照、推荐的
// 新字段。全部是增量：旧的 Portal 不发 context、不读新字段；旧的 Admin 不认 context。
// 规范：lg-helpdesk/helpdesk-v5-context-chips-and-smalltalk.md（Part A/B/D/H）与
// helpdesk-v5-faq-graph-design.md（§1、§2.2、§4、§6）。
// ---------------------------------------------------------------------------

/**
 * Part A：学员情境信号。Portal 只用代码、只读 Portal 自己的数据算出来（每个只是真 / 假，不存值），
 * 从不经过模型；Admin 与模型都收不到学员的信号，只有 FAQ 上打的标签（见 FAQ_SIGNALS）。
 * 顺序 = 规范 Part A §1 的表。
 */
export const SITUATION_SIGNALS = [
  'trial_ending',
  'payment_failed',
  'payment_pending',
  'recent_purchase',
  'subscription_cancelled',
  'subscription_expired',
  'email_unverified',
  'open_ticket_waiting',
  'from_order',
] as const;
export type SituationSignal = (typeof SITUATION_SIGNALS)[number];

/**
 * FAQ 可打的信号标签（helpdesk_faqs.signals），顺序就是 Portal 选「你可能遇到的问题」时的优先级
 * （Part A §3）。open_ticket_waiting 不是 FAQ（Portal 显示固定的工单卡片），不能打在 FAQ 上。
 */
export const FAQ_SIGNALS = [
  'payment_failed',
  'payment_pending',
  'recent_purchase',
  'trial_ending',
  'subscription_expired',
  'subscription_cancelled',
  'email_unverified',
  'from_order',
] as const satisfies readonly SituationSignal[];
export type FaqSignal = (typeof FAQ_SIGNALS)[number];

export function isSituationSignal(value: unknown): value is SituationSignal {
  return (SITUATION_SIGNALS as readonly unknown[]).includes(value);
}

export function isFaqSignal(value: unknown): value is FaqSignal {
  return (FAQ_SIGNALS as readonly unknown[]).includes(value);
}

/** 问题树（DAG）的节点类型：answer = FAQ 卡片；choice = 一句提问 + 2–4 个选项（不陈述事实）。 */
export const FAQ_NODE_TYPES = ['answer', 'choice'] as const;
export type FaqNodeType = (typeof FAQ_NODE_TYPES)[number];

/** 边：follow_up = 答案下的追问 chip；option = choice 节点的 A/B/C/D 按钮。 */
export const FAQ_EDGE_KINDS = ['follow_up', 'option'] as const;
export type FaqEdgeKind = (typeof FAQ_EDGE_KINDS)[number];

/** 发布版本的状态（helpdesk_faq_releases.status；至多一行 published）。 */
export const FAQ_RELEASE_STATUSES = [
  'draft',
  'evaluating',
  'published',
  'rejected',
  'superseded',
] as const;
export type FaqReleaseStatus = (typeof FAQ_RELEASE_STATUSES)[number];

/**
 * 答案块（Part H）：发布时由代码把每条答案切成块（faqBlocks.ts splitAnswerBlocks：每段一块、
 * 每组编号步骤一块、每个列表一块），id 按顺序 b1..bn，同一快照里稳定。text 是该块的 Markdown 原文，
 * 单独渲染与它在整条答案里渲染完全相同。Portal 按 id 原样渲染，不切、不改。
 */
export type FaqBlock = { id: string; text: string };

/** 快照里的一个节点，某一种语言（与 PublicFaq 一样按 ?locale= 挑好字段）。 */
export type FaqNode = {
  id: string;
  /** 稳定的 slug，改文字也不变（helpdesk_faqs.key）。 */
  key: string;
  type: FaqNodeType;
  /** true：可被新问题直接命中、可做 starter / 情境 chip；false：只能经边到达。 */
  entry: boolean;
  category: FaqCategory;
  popular: boolean;
  question: string;
  /** answer 节点：已审核答案（Markdown 子集）；choice 节点：那句提问（不含事实、数字、链接）。 */
  answer: string;
  /** answer 节点的块（至少 1 个）；choice 节点为 []。 */
  blocks: FaqBlock[];
  signals: FaqSignal[];
};

/** 快照里的一条边，某一种语言；label 已解析好（没有覆盖文字就是子节点的问题）。 */
export type FaqEdge = {
  parentId: string;
  childId: string;
  kind: FaqEdgeKind;
  /** 同一父节点下从 0 开始的顺序。 */
  position: number;
  label: string;
};

/**
 * GET /api/integration/helpdesk/faq-release/current?locale= 的回包（Bearer ADMIN_HELPDESK_TOKEN）：
 * 当前已发布的整张图，ETag "v<version>"，If-None-Match 命中 → 304；还没有任何发布版本 → 404
 * problem+json code no_release（Portal 照旧用逐条发布的 FAQ 列表）。
 */
export type FaqRelease = {
  version: number;
  publishedAt: string;
  locale: HelpdeskLocale;
  nodes: FaqNode[];
  edges: FaqEdge[];
};

/** 发布快照的 ETag（强校验值，与语言无关：同一版本两种语言内容都不变）。 */
export function faqReleaseEtag(version: number): string {
  return `"v${version}"`;
}

/** 推荐回包的 kind（Part B/D）：answer = 出 FAQ（或 choice 节点）；smalltalk = 寒暄；clarify = 解释刚给的卡片；no_match。 */
export const SUGGEST_KINDS = [
  'answer',
  'smalltalk',
  'clarify',
  'no_match',
] as const;
export type SuggestKind = (typeof SUGGEST_KINDS)[number];

/**
 * pick_faq 的 intent（v5）：v2 的七个 + greeting（你好、在吗、how are you）、farewell（谢谢、再见：
 * Portal 在答过之后接评分卡，所以与 greeting 分开）、vague（想求助但还没说问题）、clarify（问刚给的那张卡
 * 的意思、细节或条件）。
 */
export const SUGGEST_INTENTS = [
  'question',
  'own_account',
  'someone_else',
  'exception',
  'private_data',
  'instructions',
  'off_topic',
  'greeting',
  'farewell',
  'vague',
  'clarify',
] as const;
export type SuggestIntent = (typeof SUGGEST_INTENTS)[number];

/** pick_faq 的 confidence（graph design §4「who decides」）：unsure → 代码出 choice 节点让学员选。 */
export const CONFIDENCE_LEVELS = ['sure', 'unsure'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** 模型写的短句经代码守卫：passed = 原样用；fallback = 用了固定模板（或 clarify 不展示解释）。 */
export const GUARD_RESULTS = ['passed', 'fallback'] as const;
export type GuardResult = (typeof GUARD_RESULTS)[number];

/** 守卫回退的原因码（只记代码，不记文字）。 */
export const GUARD_REASONS = [
  'missing',
  'too_long',
  'link',
  'email',
  'digit',
  'markup',
  'blocked_phrase',
  'ai_filler',
  'script',
  'ungrounded',
  'not_covered',
  'timeout',
  'error',
] as const;
export type GuardReason = (typeof GUARD_REASONS)[number];

/** 经守卫的字段。 */
export const GUARDED_FIELDS = [
  'opening',
  'closing',
  'reply',
  'explanation',
] as const;
export type GuardedField = (typeof GUARDED_FIELDS)[number];

/** 守卫结果：fallback 列出用了模板的字段，reason 是第一个回退字段的原因。 */
export type SuggestGuard = {
  result: GuardResult;
  reason: GuardReason | null;
  fallback: GuardedField[];
};

/**
 * 守卫的长度上限（字符数，按学员的文字：中文 zh / 拉丁 en）。规则（实现归 Agent 侧的守卫）：
 * 无 URL、邮箱、数字、Markdown / 代码，不含禁用词与 AI 套话，与学员同一种文字；clarify 的解释里每个
 * 数字串、链接、邮箱、**界面文字**、金额都必须出现在那条答案里。任何一条不过 → 固定模板。
 */
export const GUARD_LIMITS = {
  opening: { zh: 30, en: 80 },
  closing: { zh: 30, en: 80 },
  reply: { zh: 80, en: 200 },
  explanation: { zh: 150, en: 350 },
} as const satisfies Record<GuardedField, { zh: number; en: number }>;

/**
 * 摘录规则（Part H）：blocks 是所选答案块 id 的连续子集，1–3 个；答案 ≤3 块或 ≤200 字时给 []
 * （= 整条答案，不显示「查看完整答案」）。
 */
export const EXCERPT_RULES = {
  maxBlocks: 3,
  wholeAnswerMaxBlocks: 3,
  wholeAnswerMaxChars: 200,
} as const;

/** 推荐请求的 context（v5，增量）：有 context 就是 v5 的 Portal。 */
export const SUGGEST_CONTEXT_LIMITS = {
  /** 最近几轮学员原文（只有学员说的话，从不含学员数据）。 */
  recentTurnsMax: 3,
  recentTurnMax: 500,
} as const;

/**
 * v7 学员状态（产品负责人 2026-10-30：课表、上了哪些课、上了多久、哪些没上、课程状态、权益、注册时间，
 * 用 JSON 给 Agent，按实际状态缩小卡片）。Portal 用自己的记录在代码里算（modules/helpdesk/learnerState.ts），
 * 只有粗的数字与枚举：从不含姓名、邮箱、订单号、金额或日期（都是相对提问时刻的整天 / 整小时）。
 */
export const LEARNER_STATE_LIMITS = {
  plansMax: 5,
  coursesMax: 10,
  courseTitleMax: 80,
  daysMax: 3650,
  hoursMax: 720,
  minutesMax: 1_000_000,
  countMax: 999,
} as const;
export const LEARNER_PLAN_STATES = [
  'active',
  'cancel_at_period_end',
  'grace',
  'expired',
  'trial_canceled',
] as const;
export const LEARNER_COURSE_STATUSES = [
  'not_started',
  'in_progress',
  'completed',
] as const;
export const LEARNER_ORDER_STATUSES = [
  'paid',
  'pending',
  'failed',
  'canceled',
  'refunded',
] as const;
/** 一个订阅：endsInDays = 还剩几整天（0 = 不到一天；-1 = 一天内刚结束）。 */
export type LearnerPlanState = {
  source: 'trial' | 'purchase';
  state: (typeof LEARNER_PLAN_STATES)[number];
  scope: 'course' | 'category' | 'everything';
  device: 'pc' | 'mobile' | null;
  endsInDays: number;
};
export type LearnerCourseState = {
  courseId: string;
  title: string;
  status: (typeof LEARNER_COURSE_STATUSES)[number];
  progress: number;
  minutes: number;
  lastStudiedDaysAgo: number | null;
  hasAccess: boolean;
};
export type LearnerState = {
  accountAgeDays: number;
  /** null：账号没有邮箱（例如微信登录）。 */
  emailVerified: boolean | null;
  plans: LearnerPlanState[];
  courses: LearnerCourseState[];
  notStartedWithAccess: number;
  studyGroups: {
    groups: number;
    hosting: number;
    upcomingSessions: number;
    nextSessionInHours: number | null;
  };
  latestOrder: {
    status: (typeof LEARNER_ORDER_STATUSES)[number];
    daysAgo: number;
  } | null;
  tickets: { open: number; waitingOnUser: number };
};

export type SuggestRequestContext = {
  /** 学员屏幕上当前那张卡（节点 / FAQ id，小写 uuid）；Part D 的 shownFaqId 就是它。 */
  nodeId?: string;
  /** Portal 的 helpdesk_chat_sessions.id。 */
  sessionId?: string;
  /** 之前的学员原文，旧的在前，至多 3 条、每条至多 500 字。 */
  recentTurns?: string[];
  /** v7：打字提问时的学员状态（不合法就当没给，从不因为它拒绝请求）。 */
  learnerState?: LearnerState;
};

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;
const oneOf = <T extends string>(values: readonly T[], value: unknown) =>
  (values as readonly unknown[]).includes(value);
const COURSE_ID = /^[A-Za-z0-9_*-]{1,80}$/;

/** 严格校验 v7 学员状态：每个键都得在、类型与范围都对，否则 null（调用方当没给）。只留契约里的键。 */
export function parseLearnerState(raw: unknown): LearnerState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const L = LEARNER_STATE_LIMITS;
  const groups = body.studyGroups as Record<string, unknown> | null;
  const tickets = body.tickets as Record<string, unknown> | null;
  const order = body.latestOrder as Record<string, unknown> | null;
  if (
    !isInt(body.accountAgeDays, 0, L.daysMax) ||
    !(body.emailVerified === null || typeof body.emailVerified === 'boolean') ||
    !Array.isArray(body.plans) ||
    body.plans.length > L.plansMax ||
    !Array.isArray(body.courses) ||
    body.courses.length > L.coursesMax ||
    !isInt(body.notStartedWithAccess, 0, L.countMax) ||
    !groups ||
    typeof groups !== 'object' ||
    !isInt(groups.groups, 0, L.countMax) ||
    !isInt(groups.hosting, 0, L.countMax) ||
    !isInt(groups.upcomingSessions, 0, L.countMax) ||
    !(
      groups.nextSessionInHours === null ||
      isInt(groups.nextSessionInHours, 0, L.hoursMax)
    ) ||
    !tickets ||
    typeof tickets !== 'object' ||
    !isInt(tickets.open, 0, L.countMax) ||
    !isInt(tickets.waitingOnUser, 0, L.countMax) ||
    !(
      order === null ||
      (typeof order === 'object' &&
        oneOf(LEARNER_ORDER_STATUSES, order.status) &&
        isInt(order.daysAgo, 0, L.daysMax))
    )
  )
    return null;
  const plans: LearnerPlanState[] = [];
  for (const item of body.plans as unknown[]) {
    const plan = (item ?? {}) as Record<string, unknown>;
    if (
      !oneOf(['trial', 'purchase'], plan.source) ||
      !oneOf(LEARNER_PLAN_STATES, plan.state) ||
      !oneOf(['course', 'category', 'everything'], plan.scope) ||
      !(plan.device === null || oneOf(['pc', 'mobile'], plan.device)) ||
      !isInt(plan.endsInDays, -L.daysMax, L.daysMax)
    )
      return null;
    plans.push({
      source: plan.source as LearnerPlanState['source'],
      state: plan.state as LearnerPlanState['state'],
      scope: plan.scope as LearnerPlanState['scope'],
      device: plan.device as LearnerPlanState['device'],
      endsInDays: plan.endsInDays,
    });
  }
  const courses: LearnerCourseState[] = [];
  for (const item of body.courses as unknown[]) {
    const course = (item ?? {}) as Record<string, unknown>;
    if (
      typeof course.courseId !== 'string' ||
      !COURSE_ID.test(course.courseId) ||
      typeof course.title !== 'string' ||
      CONTEXT_CONTROL.test(course.title) ||
      [...course.title].length > L.courseTitleMax ||
      !oneOf(LEARNER_COURSE_STATUSES, course.status) ||
      !isInt(course.progress, 0, 100) ||
      !isInt(course.minutes, 0, L.minutesMax) ||
      !(
        course.lastStudiedDaysAgo === null ||
        isInt(course.lastStudiedDaysAgo, 0, L.daysMax)
      ) ||
      typeof course.hasAccess !== 'boolean'
    )
      return null;
    courses.push({
      courseId: course.courseId,
      title: course.title.trim(),
      status: course.status as LearnerCourseState['status'],
      progress: course.progress,
      minutes: course.minutes,
      lastStudiedDaysAgo: course.lastStudiedDaysAgo,
      hasAccess: course.hasAccess,
    });
  }
  return {
    accountAgeDays: body.accountAgeDays,
    emailVerified: body.emailVerified,
    plans,
    courses,
    notStartedWithAccess: body.notStartedWithAccess,
    studyGroups: {
      groups: groups.groups,
      hosting: groups.hosting,
      upcomingSessions: groups.upcomingSessions,
      nextSessionInHours: groups.nextSessionInHours,
    },
    latestOrder: order
      ? {
          status: order.status as NonNullable<
            LearnerState['latestOrder']
          >['status'],
          daysAgo: order.daysAgo as number,
        }
      : null,
    tickets: {
      open: tickets.open,
      waitingOnUser: tickets.waitingOnUser,
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * 解析推荐请求的 context：没给（undefined / null）→ null（旧的 Portal）；给了就严格校验，
 * 不合法抛 Error(message)（调用方转 400 invalid_request）。只留给了的键。
 */
export function parseSuggestContext(
  raw: unknown,
): SuggestRequestContext | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('context must be an object');
  const body = raw as Record<string, unknown>;
  const out: SuggestRequestContext = {};
  for (const key of ['nodeId', 'sessionId'] as const) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !UUID.test(value))
      throw new Error(`context.${key} must be a UUID`);
    out[key] = value.toLowerCase();
  }
  const turns = body.recentTurns;
  if (turns !== undefined && turns !== null) {
    if (
      !Array.isArray(turns) ||
      turns.length > SUGGEST_CONTEXT_LIMITS.recentTurnsMax
    )
      throw new Error(
        `context.recentTurns must be a list of at most ${SUGGEST_CONTEXT_LIMITS.recentTurnsMax} texts`,
      );
    const texts: string[] = [];
    for (const turn of turns) {
      if (typeof turn !== 'string' || CONTEXT_CONTROL.test(turn))
        throw new Error('context.recentTurns must be plain texts');
      const text = turn.trim();
      if ([...text].length > SUGGEST_CONTEXT_LIMITS.recentTurnMax)
        throw new Error(
          `each of context.recentTurns must be at most ${SUGGEST_CONTEXT_LIMITS.recentTurnMax} characters`,
        );
      if (text !== '') texts.push(text);
    }
    out.recentTurns = texts;
  }
  const state = parseLearnerState(body.learnerState);
  if (state) out.learnerState = state;
  return out;
}

/**
 * 推荐回包的 v5 字段（只在请求带 context 时出现；旧请求的回包与 v5 契约逐字相同）。
 * - answer：suggestion 非空，nodeId = suggestion.faqId；answer 节点 opening / closing 必有（模型写的过了守卫，
 *   否则固定模板），blocks = 摘录块 id（[] = 整条）；choice 节点（不确定时让学员选）opening / closing 为 null、
 *   blocks []、guard null。
 * - smalltalk：suggestion null、alternatives []，reply 必有（过守卫或模板），nodeId null。
 * - clarify：suggestion null、alternatives []，nodeId = context.nodeId；covered true 时 explanation 必有，
 *   covered false（答案没写到，或守卫没过）时 explanation null，Portal 显示固定文案 + 转人工卡。
 * - no_match：与 v5 一样的 suggestion null + alternatives。
 * intent / confidence 在没有调用模型时（chip、限流、超时）为 null；releaseVersion 为 null = 还没有发布版本
 * （逐条发布模式）。
 */
/**
 * 一句话问了几件事（answer 才有）：第一张卡以外的卡，按用户问的顺序，最多 SUGGEST_MORE_MAX 张；
 * blocks 与 suggestion 的 blocks 同一条规则（[] = 整条）。旧的 Portal 不认识就只显示第一张。
 */
export type SuggestMoreCard = {
  faqId: string;
  question: string;
  answer: string;
  blocks: string[];
};
export const SUGGEST_MORE_MAX = 2;

export type SuggestTurnFields = {
  kind: SuggestKind;
  intent: SuggestIntent | null;
  confidence: ConfidenceLevel | null;
  nodeId: string | null;
  blocks: string[];
  opening: string | null;
  closing: string | null;
  reply: string | null;
  explanation: string | null;
  covered: boolean | null;
  guard: SuggestGuard | null;
  releaseVersion: number | null;
  /** 一句多问时其余的卡（answer 才有，有才给；没有这个键 = 只有一张）。 */
  more?: SuggestMoreCard[];
  /** 一句多问时有几件事没找到卡（answer 才有，> 0 才给；Portal 说明并给转人工）。 */
  missed?: number;
};

/** 必有的键（more、missed 只在一句多问时出现，不在这里）。 */
export const SUGGEST_TURN_FIELDS = [
  'kind',
  'intent',
  'confidence',
  'nodeId',
  'blocks',
  'opening',
  'closing',
  'reply',
  'explanation',
  'covered',
  'guard',
  'releaseVersion',
] as const satisfies readonly (keyof SuggestTurnFields)[];

const BLOCK_ID = /^b[1-9]\d*$/;

/**
 * 一条 v5 推荐回包违反了上面哪些规则（空数组 = 合规）。纯函数，给两边的测试与 Admin 的自检用；
 * 不看事实（文字是否过守卫由守卫自己的测试锁）。
 */
export function suggestTurnProblems(raw: unknown): string[] {
  const problems: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return ['not an object'];
  const body = raw as Record<string, unknown>;
  for (const key of SUGGEST_TURN_FIELDS)
    if (!(key in body)) problems.push(`${key} is missing`);
  const isText = (value: unknown) =>
    typeof value === 'string' && value.trim() !== '';
  const kind = body.kind;
  if (!(SUGGEST_KINDS as readonly unknown[]).includes(kind))
    problems.push('kind is unknown');
  if (
    body.intent !== null &&
    !(SUGGEST_INTENTS as readonly unknown[]).includes(body.intent)
  )
    problems.push('intent is unknown');
  if (
    body.confidence !== null &&
    !(CONFIDENCE_LEVELS as readonly unknown[]).includes(body.confidence)
  )
    problems.push('confidence is unknown');
  if (
    body.nodeId !== null &&
    (typeof body.nodeId !== 'string' || !UUID.test(body.nodeId))
  )
    problems.push('nodeId must be a UUID or null');
  const blocks = body.blocks;
  if (
    !Array.isArray(blocks) ||
    !blocks.every((id) => BLOCK_ID.test(String(id)))
  )
    problems.push('blocks must be block ids');
  else {
    const numbers = blocks.map((id) => Number(String(id).slice(1)));
    if (numbers.length > EXCERPT_RULES.maxBlocks)
      problems.push(`blocks has more than ${EXCERPT_RULES.maxBlocks} ids`);
    if (numbers.some((n, i) => i > 0 && n !== numbers[i - 1] + 1))
      problems.push('blocks must be contiguous and in order');
  }
  for (const key of ['opening', 'closing', 'reply', 'explanation'] as const)
    if (body[key] !== null && !isText(body[key]))
      problems.push(`${key} must be text or null`);
  if (body.covered !== null && typeof body.covered !== 'boolean')
    problems.push('covered must be true, false or null');
  if (
    body.releaseVersion !== null &&
    !(Number.isInteger(body.releaseVersion) && Number(body.releaseVersion) >= 1)
  )
    problems.push('releaseVersion must be a positive integer or null');
  const guard = body.guard as Record<string, unknown> | null;
  if (guard !== null) {
    if (typeof guard !== 'object' || Array.isArray(guard))
      problems.push('guard must be an object or null');
    else {
      if (!(GUARD_RESULTS as readonly unknown[]).includes(guard.result))
        problems.push('guard.result is unknown');
      if (
        guard.reason !== null &&
        !(GUARD_REASONS as readonly unknown[]).includes(guard.reason)
      )
        problems.push('guard.reason is unknown');
      const fallback = guard.fallback;
      if (
        !Array.isArray(fallback) ||
        !fallback.every((f) =>
          (GUARDED_FIELDS as readonly unknown[]).includes(f),
        )
      )
        problems.push('guard.fallback must list guarded fields');
      else if ((guard.result === 'passed') !== (fallback.length === 0))
        problems.push('guard.fallback is empty exactly when it passed');
      if ((guard.result === 'passed') !== (guard.reason === null))
        problems.push('guard.reason is null exactly when it passed');
    }
  }
  const suggestion = body.suggestion as
    Record<string, unknown> | null | undefined;
  const alternatives = body.alternatives;
  if (!Array.isArray(alternatives)) problems.push('alternatives is missing');
  const none = (keys: readonly string[]) => {
    for (const key of keys)
      if (body[key] !== null)
        problems.push(`${key} must be null for ${String(kind)}`);
  };
  if (kind === 'answer') {
    if (!suggestion || typeof suggestion !== 'object')
      problems.push('answer needs a suggestion');
    else if (body.nodeId !== suggestion.faqId)
      problems.push('nodeId must be the suggestion faqId');
    if (Array.isArray(alternatives) && alternatives.length > 0)
      problems.push('no alternatives next to an answer');
    none(['reply', 'explanation', 'covered']);
    const framed = isText(body.opening) && isText(body.closing);
    const bare = body.opening === null && body.closing === null;
    if (!framed && !bare)
      problems.push('opening and closing come together, or both null (choice)');
    if (bare && (Array.isArray(blocks) ? blocks.length > 0 : false))
      problems.push('a choice node has no blocks');
    if (framed && guard === null) problems.push('answer text needs a guard');
  } else {
    if (suggestion !== null) problems.push(`${String(kind)} has no suggestion`);
    none(['opening', 'closing']);
    if (Array.isArray(blocks) && blocks.length > 0)
      problems.push(`${String(kind)} has no blocks`);
  }
  if (kind === 'smalltalk') {
    if (!isText(body.reply)) problems.push('smalltalk needs a reply');
    none(['nodeId', 'explanation', 'covered']);
    if (guard === null) problems.push('smalltalk needs a guard');
    if (Array.isArray(alternatives) && alternatives.length > 0)
      problems.push('smalltalk has no alternatives');
  }
  if (kind === 'clarify') {
    none(['reply']);
    if (body.nodeId === null) problems.push('clarify names the shown node');
    if (typeof body.covered !== 'boolean')
      problems.push('clarify needs covered');
    if (body.covered === true && !isText(body.explanation))
      problems.push('covered clarify needs an explanation');
    if (body.covered === false && body.explanation !== null)
      problems.push('uncovered clarify shows no explanation');
    if (guard === null) problems.push('clarify needs a guard');
    if (Array.isArray(alternatives) && alternatives.length > 0)
      problems.push('clarify has no alternatives');
  }
  if (kind === 'no_match') {
    none(['nodeId', 'reply', 'explanation', 'covered', 'guard']);
  }
  problems.push(...moreProblems(body, kind));
  return problems;
}

/** 一句多问的 more / missed：只在 answer 里，有才给；卡不重复、不是第一张、摘录块合规。 */
function moreProblems(body: Record<string, unknown>, kind: unknown): string[] {
  const problems: string[] = [];
  if ('more' in body) {
    const more = body.more;
    if (kind !== 'answer') problems.push(`${String(kind)} has no more cards`);
    if (
      !Array.isArray(more) ||
      more.length === 0 ||
      more.length > SUGGEST_MORE_MAX
    )
      problems.push(`more lists 1 to ${SUGGEST_MORE_MAX} cards`);
    else {
      const ids = new Set<unknown>([body.nodeId]);
      for (const card of more as unknown[]) {
        const c = (card ?? {}) as Record<string, unknown>;
        if (typeof c.faqId !== 'string' || !UUID.test(c.faqId))
          problems.push('more cards need a faqId');
        else if (ids.has(c.faqId))
          problems.push('more cards are all different');
        ids.add(c.faqId);
        for (const key of ['question', 'answer'] as const)
          if (typeof c[key] !== 'string' || c[key].trim() === '')
            problems.push(`more cards need a ${key}`);
        const blocks = c.blocks;
        if (
          !Array.isArray(blocks) ||
          !blocks.every((id) => BLOCK_ID.test(String(id))) ||
          blocks.length > EXCERPT_RULES.maxBlocks ||
          blocks
            .map((id) => Number(String(id).slice(1)))
            .some((n, i, all) => i > 0 && n !== all[i - 1] + 1)
        )
          problems.push('more cards need contiguous block ids');
      }
    }
  }
  if ('missed' in body) {
    if (kind !== 'answer') problems.push(`${String(kind)} has no missed asks`);
    const missed = body.missed;
    if (
      !Number.isInteger(missed) ||
      Number(missed) < 1 ||
      Number(missed) > SUGGEST_MORE_MAX
    )
      problems.push(`missed is 1 to ${SUGGEST_MORE_MAX}`);
  }
  return problems;
}
