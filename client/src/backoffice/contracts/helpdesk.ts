/**
 * HelpDesk（设计文档 §4A / §5.4，Figma 1324:2 / 1379:2 / 1379:299；Tickets v2）：BackOffice Server
 * `/api/helpdesk/**` 返回的形状，与 server/src/backoffice/modules/helpdesk/contracts.ts、
 * faqs/faqContracts.ts 保持一致。
 */
export const TICKET_STATUSES = [
  "OPEN",
  "ASSIGNED",
  "WAITING_USER",
  "PENDING_CONFIRM",
  "CLOSED",
  "CANCELLED",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** 工单的 Enquiry Type（Figma 1216:6）。 */
export const HELPDESK_CATEGORIES = [
  "technical_support",
  "course_content",
  "payments_subscriptions",
  "other",
] as const;
export type HelpdeskCategory = (typeof HELPDESK_CATEGORIES)[number];

export const HELPDESK_LOCALES = ["en-GB", "zh-CN"] as const;
export type HelpdeskLocale = (typeof HELPDESK_LOCALES)[number];

/** 列表筛选：Portal 只接受一个状态值，或 needs_reply / all。 */
export const LIST_STATUS_FILTERS = ["all", "needs_reply", ...TICKET_STATUSES] as const;
export type ListStatusFilter = (typeof LIST_STATUS_FILTERS)[number];

export type AuthorKind = "learner" | "agent" | "system";

export type Agent = { id: string; name: string };

export type AvailableActions = {
  claim: boolean;
  reply: boolean;
  internalNote: boolean;
  /** Figma「Mark as reviewed」。 */
  proposeResolution: boolean;
  tag: boolean;
  markRead: boolean;
  /** Figma「Flag follow-up」（v2：任何状态都可用）。 */
  flag: boolean;
};

export type EnquiryRow = {
  id: string;
  number: string;
  subject: string;
  category: string;
  status: TicketStatus;
  locale: string;
  learner: { id: string; email: string; name: string };
  contactEmail: string | null;
  /** 第一条消息的前 120 字。 */
  preview: string;
  unreadByAgent: boolean;
  tags: string[];
  needsReply: boolean;
  assignee: Agent | null;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  lastMessageBy: AuthorKind | null;
  confirmDueAt?: string | null;
  closedAt?: string | null;
  closeReason?: string | null;
  /** 学员关闭后给工单的评分 1–5；没评为 null。BackOffice 卡片显示「评分 n/5 / 未评分」（v3 §2）。 */
  rating?: number | null;
  /** v2：员工标了「Flag follow-up」。 */
  flagged: boolean;
  /** v4 Part A：学员从付款记录发起咨询时关联的订单号；没有订单为 null（旧服务端没有这个字段）。 */
  orderId?: string | null;
  /** 每一行都带可用操作：学员时间线上的每张卡片都有操作栏。 */
  available: AvailableActions;
};

export type TicketAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  /** 图片内联；其它文件下载。 */
  inline: boolean;
};

export type TicketMessage = {
  id: string;
  authorKind: AuthorKind;
  authorName: string;
  body: string;
  internal: boolean;
  attachments: TicketAttachment[];
  createdAt: string;
};

export type TicketEvent = {
  id: string;
  type: string;
  time: string;
  sequence: number;
  data: {
    fromState: string | null;
    toState: string | null;
    actor: { kind: string; id: string | null; name: string | null } | null;
    reason: string | null;
    messageId: string | null;
  };
};

export type TicketStudent = {
  id: string;
  name: string;
  accountEmail: string;
  contactEmail: string | null;
  joinedAt: string | null;
  totalEnquiries: number | null;
  currentCourse: { id: string; title: string } | null;
};

export type TicketSubscription = {
  planName: string;
  billingCycle: string;
  status: string;
  renewalDate: string | null;
};

/** AI 助手回答的学员反馈（v2 §4a）；没有反馈为 null。 */
export const ASSIST_FEEDBACK = ["helpful", "not_helpful", "solved", "declined", "edited"] as const;
export type AssistFeedback = (typeof ASSIST_FEEDBACK)[number];

/** 工单关联的 AI 助手回答（v2 §4a aiAssist，旧的在前）；answer 是当时展示给学员的原文。 */
export type TicketAiAssist = {
  id: string;
  source: string;
  question: string;
  faqId: string | null;
  faqQuestion: string | null;
  answer: string | null;
  feedback: AssistFeedback | null;
  createdAt: string;
  /** v3 §2：学员给这次 AI 回答的评分 1–5（「本次服务满意吗？」）；没评或跳过为 null（旧服务端没有这个字段）。 */
  rating?: number | null;
};

/**
 * 「查看链路」：GET /api/helpdesk/agent-runs/:runId（helpdesk-agent-v2-pi-dsh §2）。
 * 一次 AI 推荐 = 一个 run（id 就是 AI 块的 id）；事件是 dsh SessionEvent 的导出副本，学员原文已脱敏。
 */
export type AgentRunEvent = {
  runId: string;
  seq: number;
  type: string;
  time: string;
  data: Record<string, unknown>;
};

export type AgentRun = {
  runId: string;
  /** 同一段对话的第一个 run；自己就是第一个时为 null。 */
  parentRunId: string | null;
  chain: string[];
  events: AgentRunEvent[];
};

/**
 * v4 Part A：工单关联订单的只读投影（Portal 用代码从学员自己的订单记录构建，Admin Server 只保留这 8 个字段，
 * 格式不对的字段为 null）。AI 助手从不接触订单。
 */
export const ORDER_STATUSES = ["paid", "pending", "failed", "canceled", "refunded"] as const;
export const ORDER_KINDS = ["purchase", "trial_activation", "upgrade"] as const;
export const PAYMENT_MODES = ["demo", "stripe"] as const;

export type TicketOrder = {
  id: string;
  /** ORDER_STATUSES 之一；Portal 以后新增的值原样显示。 */
  status: string | null;
  /** 整数，最小货币单位（3900 = 39.00）。 */
  amount: number | null;
  /** ISO 4217，小写（"usd"）。 */
  currency: string | null;
  planName: string | null;
  kind: string | null;
  createdAt: string | null;
  paymentMode: string | null;
};

export type EnquiryDetail = EnquiryRow & {
  student: TicketStudent | null;
  subscription: TicketSubscription | null;
  /** v4 Part A：没有订单为 null；有 orderId 却为 null = Portal 这次没读到订单（旧服务端没有这个字段）。 */
  order?: TicketOrder | null;
  messages: TicketMessage[];
  events: TicketEvent[];
  aiAssist: TicketAiAssist[];
};

export type EnquiryCounts = Record<TicketStatus, number> & { needsReply: number; all: number };

export type EnquiryList = {
  tickets: EnquiryRow[];
  nextCursor: string | null;
  counts: EnquiryCounts;
};

export type AgentActionInput =
  | { action: "claim" | "propose_resolution" | "flag" | "unflag"; expectedSequence: number }
  | { action: "add_tag" | "remove_tag"; tag: string; expectedSequence: number }
  | { action: "mark_read"; expectedSequence?: number };

/** 与服务端一致的常量。 */
export const MESSAGE_BODY_MAX = 5000;
export const CONFIRM_WINDOW_HOURS = 72;
export const TAG_MAX_LENGTH = 32;
export const TAGS_PER_TICKET_MAX = 10;
export const SEARCH_MAX = 120;
export const PAGE_SIZE = 30;

/** 学员时间线：选中工单的学员最多 10 条工单（新的在前）。 */
export const TIMELINE_LIMIT = 10;

/* ----------------------------------- FAQs ----------------------------------- */

/** FAQ 分类（Figma 1379:2 / 1387:2；v2 §1）。 */
export const FAQ_CATEGORIES = ["account_technical", "courses_learning", "payments_subscriptions", "other"] as const;
export type FaqCategory = (typeof FAQ_CATEGORIES)[number];

/**
 * v5 Part A：FAQ 可打的学员情境信号（服务端 FAQ_SIGNALS，契约 fixture v6 的 faqSignal；顺序 = Portal 选
 * 「你可能遇到的问题」的优先级）。open_ticket_waiting 不是 FAQ，不在这里。
 */
export const FAQ_SIGNALS = [
  "payment_failed",
  "payment_pending",
  "recent_purchase",
  "trial_ending",
  "subscription_expired",
  "subscription_cancelled",
  "email_unverified",
  "from_order",
] as const;
export type FaqSignal = (typeof FAQ_SIGNALS)[number];

/** 一条中英双语 FAQ（保存即发布；删除 = 归档，列表里看不到）。 */
export type HelpdeskFaq = {
  id: string;
  category: FaqCategory;
  popular: boolean;
  questionEn: string;
  answerEn: string;
  questionZh: string;
  answerZh: string;
  keywords: string[];
  /** v5 Part A：服务端总会给（迁移 20261030140000）；编辑器多选（待视觉验收）。 */
  signals?: FaqSignal[];
  /** v5 问题树（迁移 20261030150000；旧服务端没有 → 按 answer / 入口处理）：稳定的 slug。 */
  key?: string;
  type?: FaqNodeType;
  entry?: boolean;
  status: "published" | "archived";
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FaqPage = { faqs: HelpdeskFaq[]; total: number; page: number; pageSize: number };

export type FaqBody = {
  category: FaqCategory;
  popular: boolean;
  questionEn: string;
  answerEn: string;
  questionZh: string;
  answerZh: string;
  keywords: string[];
  /** v5 Part A：不带 = 保留已存的标签（旧的编辑器只改文字不会清掉）。 */
  signals?: FaqSignal[];
  /** v5 问题树：不带 = 保留（新建缺省 answer、入口）。 */
  type?: FaqNodeType;
  entry?: boolean;
};

/* --------------------------- v5 问题树（graph design §5） --------------------------- */

/** answer = FAQ 卡片；choice = 一句提问 + 2–4 个选项（A/B/C/D）。 */
export const FAQ_NODE_TYPES = ["answer", "choice"] as const;
export type FaqNodeType = (typeof FAQ_NODE_TYPES)[number];
export const FAQ_EDGE_KINDS = ["follow_up", "option"] as const;
export type FaqEdgeKind = (typeof FAQ_EDGE_KINDS)[number];

/** 与服务端 faqContracts.ts FAQ_LIMITS 一致的图上限。 */
export const FAQ_GRAPH_LIMITS = {
  optionLabelMaxZh: 24,
  optionLabelMaxEn: 40,
  followUpLabelMax: 200,
  optionsMin: 2,
  optionsMax: 4,
  followUpsMax: 6,
  followUpsShown: 4,
  phrasingMax: 200,
  phrasingsMax: 30,
  depthMax: 4,
} as const;

/** 节点摘要（树、父子清单）。 */
export type FaqNodeSummary = {
  id: string;
  key: string;
  type: FaqNodeType;
  entry: boolean;
  category: FaqCategory;
  questionEn: string;
  questionZh: string;
  status: "published" | "archived";
};

export type FaqEdgeRow = {
  id: string;
  parentId: string;
  childId: string;
  kind: FaqEdgeKind;
  position: number;
  /** null = 用子节点的问题。 */
  labelEn: string | null;
  labelZh: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/** GET /api/helpdesk/faqs/:id/edges 的一行：边、另一端的节点、解析好的文字。 */
export type FaqEdgeView = {
  edge: FaqEdgeRow;
  node: FaqNodeSummary | null;
  label: { en: string; zh: string };
};

export type FaqEdges = { children: FaqEdgeView[]; parents: FaqEdgeView[] };

/** 服务端 faqGraphChecks.ts GRAPH_RULES（新规则没有文案时原样显示）。 */
export const GRAPH_RULES = [
  "edge_endpoint",
  "duplicate_edge",
  "cycle",
  "depth",
  "orphan",
  "option_parent",
  "choice_follow_up",
  "choice_options",
  "choice_prompt",
  "follow_ups",
  "language",
  "label_length",
  "answer_blocks",
  "map_shape",
  "map_placement",
  "map_primary",
] as const;

export type GraphProblem = {
  rule: string;
  nodeId: string | null;
  key: string | null;
  parentId?: string;
  childId?: string;
  detail: string;
};

export type FaqGraphCheckResult = {
  passed: boolean;
  problems: GraphProblem[];
  counts: { nodes: number; entries: number; choices: number; edges: number; phrasings: number };
  maxDepth: number;
};

export type FaqTreeNode = {
  node: FaqNodeSummary;
  edge: FaqEdgeRow | null;
  label: { en: string; zh: string } | null;
  depth: number;
  parentCount: number;
  alsoAppearsIn: { id: string; key: string; questionEn: string; questionZh: string }[];
  warnings: GraphProblem[];
  cycle: boolean;
  truncated: boolean;
  children: FaqTreeNode[];
};

export type FaqTree = { root: FaqTreeNode; nodes: number };

export const PHRASING_LOCALES = ["en-GB", "zh-CN", "zh-TW"] as const;
export type PhrasingLocale = (typeof PHRASING_LOCALES)[number];

export type FaqPhrasing = {
  id: string;
  faqId: string;
  locale: PhrasingLocale;
  text: string;
  source: "staff" | "flywheel" | "seed";
  createdBy: string | null;
  createdAt: string;
};

export const FAQ_RELEASE_STATUSES = ["draft", "evaluating", "published", "rejected", "superseded"] as const;
export type FaqReleaseStatus = (typeof FAQ_RELEASE_STATUSES)[number];

export type FaqReleaseEvalReport = {
  kind: "retrieval" | "model" | "combined" | "rollback" | "skipped" | string;
  passed: boolean;
  summary: string;
  ranAt: string;
  metrics: Record<string, number>;
  /** retrieval：没进前 8 的用例；model（真流程检查）：答错卡或没得到回答的问题（expected / got）。 */
  misses: { nodeId?: string; key?: string; locale: string; source: string; text: string; rank?: number | null; expected?: string; got?: string }[];
  sourceVersion?: number;
  /** combined：检索检查与真流程检查各一份。 */
  parts?: FaqReleaseEvalReport[];
  /** 真流程检查（release check v2）：套件与切片。 */
  suites?: FaqEvalSuite[];
  /** 这次检查用了什么（模型、题集、缓存版本……）。 */
  receipt?: Record<string, string | number>;
  /** 这一版新加的、和别的卡几乎一样的文字（只提醒）。 */
  collisions?: FaqTextCollision[];
};

/** 真流程检查的一个套件或切片：gate = 不过就不能发布；track = 只看（比线上新错仍然拦）。 */
export type FaqEvalSuite = {
  id: string;
  label: string;
  status: 'gate' | 'track';
  /** interval = 95% 上界；point = 点估计（题够多才算）；paired = 只看比线上新错。旧报告没有。 */
  rule?: 'interval' | 'point' | 'paired';
  passed: boolean;
  n: number;
  metrics: Record<string, number>;
  /** 服务端的英文原因（旧报告、拿不到门槛时才直接显示）。 */
  reasons: string[];
};

/** 真流程检查的问题清单（报告的 misses，按轻重排好）。 */
export type FaqModelMiss = {
  id: string;
  set: string;
  locale: string;
  text: string;
  expected: string;
  got: string;
  live?: string;
  onScreen?: string;
  why: 'newly_wrong' | 'wrong_card' | 'timeout' | 'error' | string;
};

export type FaqTextCollision = {
  similarity: number;
  added: { key: string; text: string; source: string };
  other: { key: string; text: string; source: string };
  /** 两张卡靠用户状态（signals）分开：多半是该有的。 */
  byState: boolean;
};

/** 「发布新版本」之前的估计：要问几道题、估计几道真付钱、约多少钱（美元；没有上次的记录 = null）。 */
export type FaqCheckEstimate = {
  questions: number;
  single: number;
  followups: number;
  touchedCards: number;
  paid: number;
  usd: number | null;
  budgetUsd: number;
  basis: 'last_check' | 'no_history';
};

/** 检查进行到哪一步（后台检查，owner 2026-11-03）。 */
export type FaqReleaseEvaluation = {
  /** interrupted：心跳停了（服务重启、部署打断），可以重新检查。 */
  state: 'running' | 'interrupted';
  startedAt: string | null;
  progress: { stage: 'retrieval' | 'vectors' | 'model' | string; done: number; total: number } | null;
};

export type FaqRelease = {
  id: string;
  version: number;
  status: FaqReleaseStatus;
  checks: FaqGraphCheckResult | null;
  evalReport: FaqReleaseEvalReport | null;
  /** 回滚版本：快照复制自哪个版本。 */
  sourceVersion: number | null;
  createdBy: string | null;
  createdAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
  /** draft，且检查与评测都过了。 */
  publishable: boolean;
  /** 只有 status = evaluating 时有（旧的服务端没有这个字段）。 */
  evaluation?: FaqReleaseEvaluation | null;
};

export type FaqReleaseList = { releases: FaqRelease[]; published: number | null };

export type FaqNodeRef = { id: string; key: string; questionEn: string; questionZh: string };

export type FaqSnapshotEdge = {
  parentId: string;
  childId: string;
  kind: FaqEdgeKind;
  position: number;
  labelEn: string | null;
  labelZh: string | null;
};

export type FaqSnapshotDiff = {
  nodes: { added: FaqNodeRef[]; removed: FaqNodeRef[]; changed: (FaqNodeRef & { fields: string[] })[] };
  edges: {
    added: FaqSnapshotEdge[];
    removed: FaqSnapshotEdge[];
    changed: { before: FaqSnapshotEdge; after: FaqSnapshotEdge; fields: string[] }[];
  };
  phrasings: { added: number; removed: number };
  /** 流程树与对象表（节点与挂载）新增、去掉了几条；旧的服务端不给。 */
  map?: { added: number; removed: number };
  same: boolean;
};

/** 「发布新版本」：工作副本的检查与它和当前上线版本的差异。 */
export type FaqWorkingCopy = {
  checks: FaqGraphCheckResult;
  diff: FaqSnapshotDiff;
  published: number | null;
  /** 真流程检查的估计；没有真流程检查（没有 key、关着）或旧的服务端 = null / 不写。 */
  estimate?: FaqCheckEstimate | null;
};

export type FaqReleaseDiff = { base: number | null; head: number | "working"; diff: FaqSnapshotDiff };

/** 对话预览：与 Portal 读 faq-release/current 同一个投影（契约 FaqNode / FaqEdge）。 */
export type FaqBlock = { id: string; text: string };

export type FaqGraphNode = {
  id: string;
  key: string;
  type: FaqNodeType;
  entry: boolean;
  category: FaqCategory;
  popular: boolean;
  question: string;
  answer: string;
  blocks: FaqBlock[];
  signals: FaqSignal[];
};

export type FaqGraphEdge = { parentId: string; childId: string; kind: FaqEdgeKind; position: number; label: string };

export type FaqGraphPreview = {
  source: "working" | number;
  published: number | null;
  locale: HelpdeskLocale;
  nodes: FaqGraphNode[];
  edges: FaqGraphEdge[];
};

/* ------------------------ v5 Part G 数据飞轮（G3 / G4 / G6） ------------------------ */

/**
 * FAQ 候选（服务端 flywheel/candidateRepository.ts、faqCandidateService.ts）：夜间缺口挖掘把 AI 没解决的、
 * Portal 已脱敏的学员问法按意思分组，或员工从已解决的工单「转成 FAQ 候选」。模型只给话题与一个学员式的问题，
 * 从不写答案；答案由员工写（可选的「草稿 待核实」只来自已解决工单里人写的回复）。
 */
export const CANDIDATE_STATUSES = ["new", "accepted", "dismissed", "merged"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];
/** update_faq：已有卡过时或缺细节；retire_faq：卡标记失效（归档，不删除）。见 candidate-review/api-spec.md §1。 */
export const CANDIDATE_SUGGESTIONS = ["new_faq", "add_phrasing", "follow_up", "update_faq", "retire_faq"] as const;
export type CandidateSuggestion = (typeof CANDIDATE_SUGGESTIONS)[number];
export const CANDIDATE_ORIGINS = ["mining", "ticket"] as const;
export type CandidateOrigin = (typeof CANDIDATE_ORIGINS)[number];
export const DISMISS_REASONS = ["duplicate", "not_a_gap", "out_of_scope", "personal_data", "spam", "other"] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];
/** 原因构成的键：六种「AI 没解决」+ ticket（客服从工单转来的）。 */
export const SOURCE_MIX_KEYS = [
  "no_match",
  "not_helpful",
  "clarify_not_covered",
  "handover",
  "ticket_after_chat",
  "low_rating",
  "ticket",
] as const;
export type SourceMixKey = (typeof SOURCE_MIX_KEYS)[number];
export type SourceMix = Partial<Record<SourceMixKey, number>>;

/** 服务端 faqCandidateService.ts 的上限。 */
export const CANDIDATE_LIMITS = { noteMax: 500, qMax: 100, pageSizeMax: 100 } as const;

export type CandidateExample = {
  turnId: string | null;
  /** 已脱敏（占位符 <email>、<phone> …）。 */
  text: string;
  locale: PhrasingLocale;
  reasons: SourceMixKey[];
};

export type FaqCandidate = {
  id: string;
  status: CandidateStatus;
  suggestion: CandidateSuggestion;
  origin: CandidateOrigin;
  topic: string;
  proposedQuestion: string;
  labelSource: "model" | "code";
  category: string | null;
  locale: string;
  turnCount: number;
  examples: CandidateExample[];
  sourceMix: SourceMix;
  /** 已脱敏的、人写的已解决工单回复（只当草稿来源）。 */
  answerSources: string[];
  relatedNodeId: string | null;
  relatedScore: number | null;
  parentNodeId: string | null;
  shownNodeId: string | null;
  ticketId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  reason: DismissReason | null;
  reasonNote: string | null;
  acceptedAs: CandidateSuggestion | null;
  acceptedFaqId: string | null;
  mergedInto: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  actionKey: string | null;
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 审计（helpdesk_faq_candidate_revisions，只追加）。 */
export type CandidateRevision = {
  id: string;
  candidateId: string;
  action: "create" | "grow" | "accept" | "dismiss" | "merge" | string;
  before: unknown;
  after: unknown;
  employeeId: string | null;
  /** 动作当时员工的显示名（之前的行没有）。 */
  employeeName?: string | null;
  at: string;
};

export type CandidateList = {
  candidates: FaqCandidate[];
  total: number;
  counts: Record<CandidateStatus, number>;
  page: number;
  pageSize: number;
  nodes: FaqNodeSummary[];
};

export type CandidateDetail = { candidate: FaqCandidate; revisions: CandidateRevision[]; nodes: FaqNodeSummary[] };

/** GET …/draft：新 FAQ / 追问的预填（答案留空，由员工写）。 */
export type FaqCandidateDraft = {
  candidateId: string;
  version: number;
  suggestion: CandidateSuggestion;
  faq: {
    type: "answer";
    entry: boolean;
    category: string | null;
    questionEn: string;
    questionZh: string;
    answerEn: "";
    answerZh: "";
    keywords: string[];
  };
  parentId: string | null;
  relatedNodeId: string | null;
  phrasings: { index: number; locale: PhrasingLocale; text: string }[];
  /** 只来自已解决工单里人写的回复，标「草稿 待核实」；没有为 null。 */
  answerDraft: { label: { en: string; zh: string }; sources: string[] } | null;
};

export type AcceptCandidateBody = {
  as: CandidateSuggestion;
  faqId: string;
  parentId?: string | null;
  /** 选作问法的例句序号；不带 = 所有不含占位符的。 */
  phrasings?: number[];
  version: number;
  /** 主位置（step / deviation / cell）：new_faq / follow_up 在结构不为空时必填；update_faq 可选（换位置）。 */
  placementNodeId?: string;
  /** retire_faq 可选：把 X 的问法挪到这张卡。 */
  moveTo?: string;
  /** retire_faq 可选：为什么下线（至多 500 字，服务端脱敏）。 */
  note?: string;
};

export type AcceptCandidateResult = {
  candidate: FaqCandidate;
  replayed: boolean;
  phrasingsAdded: number;
  phrasingsSkipped: number;
  evalCasesAdded: number;
  /** 勾选的例句里只当发布检查题、没加成问法的句数（服务端 splitForEval：一句问法、一句检查题轮流）。 */
  heldOut?: number;
  edgeId: string | null;
};

/** 勾选 n 句里会加成问法的句数（和服务端 splitForEval 一致：第 1、3、5… 句；只勾一句就是问法）。 */
export function phrasingsFromPicks(n: number): number {
  return n < 2 ? n : Math.ceil(n / 2);
}

/* ---------------- FAQ 候选审核（candidate-review/api-spec.md §2、§3、§5、§6） ---------------- */

/** 路径上的一级（流程阶段、步骤、对象、规则格）。 */
export type MapPathItem = { key: string; labelZh: string; labelEn: string };

export const FAQ_MAP_KINDS = ["stage", "step", "deviation", "object", "cell"] as const;
export type FaqMapKind = (typeof FAQ_MAP_KINDS)[number];
/** 只有这三种能挂卡（数据库触发器保证）。 */
export const PLACEABLE_KINDS = ["step", "deviation", "cell"] as const;
export type PlaceableKind = (typeof PLACEABLE_KINDS)[number];

export type ReviewHandling = {
  exampleIndex: number;
  shownFaqId: string | null;
  outcome: SourceMixKey;
  /** 固定 null：AI 的回答就是卡片原文。 */
  reply: string | null;
};

export type ReviewSimilar = {
  faqId: string;
  key: string;
  questionEn: string;
  questionZh: string;
  answerExcerptEn: string;
  answerExcerptZh: string;
  entry: boolean;
  score: number;
  samePlace: boolean;
  placePath: MapPathItem[];
  /** 同位置且问题向量相似度 ≥ 0.88：要员工读两张卡的答案再判断（可能重复、矛盾或不同情境）。 */
  closeMatch: boolean;
};

export type ReviewPlace = { nodeId: string; kind: PlaceableKind; path: MapPathItem[]; score: number };
export type ReviewRegion = { key: string; kind: "stage" | "object"; labelZh: string; labelEn: string; score: number };

export const USER_STATE_BUCKETS = [
  "paid_active",
  "trial_active",
  "cancelling",
  "payment_failed",
  "ended",
  "never_had_plan",
  "unknown",
] as const;
export type UserStateBucket = (typeof USER_STATE_BUCKETS)[number];
export type ReviewUserStates = { total: number; buckets: Partial<Record<UserStateBucket, number>> };
export type ReviewNetValue = { releaseVersion: number; gains: number; steals: number; net: number; evalCases: number };

export type CandidateReview = {
  candidateId: string;
  version: number;
  recommendation: {
    action: CandidateSuggestion;
    faqId: string | null;
    rationale: string;
    rationaleZh?: string;
    rationaleEn?: string;
    confidence: number | null;
  };
  handling: ReviewHandling[];
  similaritySource: "text" | "vectors";
  similar: ReviewSimilar[];
  places: ReviewPlace[];
  regions: ReviewRegion[];
  /** 第 3 阶段之前为 null。 */
  userStates: ReviewUserStates | null;
  /** 第 2 阶段之前、或这张卡还没进过建版本时为 null。 */
  netValue: ReviewNetValue | null;
};

export type FaqMapNode = {
  id: string;
  key: string;
  kind: FaqMapKind;
  parentId: string | null;
  labelZh: string;
  labelEn: string;
  position?: number;
  stageKey?: string;
  attribute?: string;
  cards: number;
};
export type FaqMap = { version: number; nodes: FaqMapNode[] };

export type MergeCandidateBody = { targetId: string; version: number };
export type MergeCandidateResult = { source: FaqCandidate; target: FaqCandidate | null; replayed: boolean };

export type DismissCandidateBody = { reason: DismissReason; note?: string | null; version: number };

export type FromTicketResult = { candidate: FaqCandidate; created: boolean; similarCandidateId: string | null };

/** Admin 的夜间缺口挖掘（helpdesk_flywheel_runs）。 */
export const FLYWHEEL_JOBS = ["gap_mining"] as const;
export type FlywheelJob = (typeof FLYWHEEL_JOBS)[number];
export type JobRunStatus = "running" | "succeeded" | "failed";

export type FlywheelJobRun = {
  id: string;
  job: FlywheelJob;
  day: string;
  trigger: "schedule" | "manual";
  status: JobRunStatus;
  attempts: number;
  instance: string;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  stats: Record<string, unknown>;
  moreDue: boolean;
  errorCode: string | null;
  requestedBy: { id: string; name: string } | null;
};

/** Portal 的学员原文保留任务（helpdesk_job_runs，180 天后只留脱敏文字与标签）。 */
export type PortalJobRun = {
  id: string;
  job: "assist_retention";
  day: string;
  trigger: "schedule" | "manual";
  status: JobRunStatus;
  attempts: number;
  startedAt: string;
  finishedAt: string | null;
  cutoff: string | null;
  rowsScrubbed: number;
  moreDue: boolean;
  requestedBy: Agent | null;
  errorCode: string | null;
};

export type PortalJobRuns = { job: "assist_retention"; retentionDays: number; runs: PortalJobRun[] };
export type PortalJobRunResult = { outcome: "completed" | "already_running"; run: PortalJobRun | null };

/** G6 指标（服务端 flywheelMetrics.ts）：全部来自事实表的视图；分母为 0 的比率为 null。 */
export const METRICS_GRANULARITIES = ["day", "week"] as const;
export type MetricsGranularity = (typeof METRICS_GRANULARITIES)[number];
export const METRICS_SPLITS = ["none", "locale", "entry", "signal"] as const;
export type MetricsSplit = (typeof METRICS_SPLITS)[number];

export type MetricsRates = {
  aiSolvedRate: number | null;
  noMatchRate: number | null;
  helpfulRate: number | null;
  avgRating: number | null;
  handoverRate: number | null;
  clarifyCoveredRate: number | null;
  guardFallbackRate: number | null;
};

export type MetricsCounts = {
  turns: number;
  answers: number;
  answersSettled: number;
  aiSolved: number;
  noMatch: number;
  votes: number;
  helpful: number;
  ratings: number;
  ratingSum: number;
  handovers: number;
  clarify: number;
  clarifyCovered: number;
  guarded: number;
  guardFallback: number;
  unsolved: number;
};

export type MetricsRow = MetricsCounts &
  MetricsRates & {
    bucket: string | null;
    segment: string;
    /** 周桶：这段时间只盖住了这一周的一部分。 */
    partial?: boolean;
  };

export type GapGroupRow = {
  candidateId: string;
  topic: string;
  proposedQuestion: string;
  suggestion: string;
  status: string;
  turns: number;
};

export type TicketFaqRow = {
  faqId: string;
  answers: number;
  ticketsAfter: number;
  ticketRate: number | null;
  key: string | null;
  questionEn: string | null;
  questionZh: string | null;
};

export type FlywheelMetrics = {
  granularity: MetricsGranularity;
  split: MetricsSplit;
  from: string;
  to: string;
  lastIngestedAt: string | null;
  source: "portal_insights";
  /** 日与周按 UTC 切，周从周一开始。 */
  timezone?: "UTC";
  weekStartsOn?: "monday";
  series: MetricsRow[];
  totals: MetricsRow[];
  topGaps: GapGroupRow[];
  ticketFaqs: TicketFaqRow[];
};

/* ------------------------- FAQ 修改记录（Change Log，Figma 草案 2.6–2.9） ------------------------- */

/** 与服务端 faqChangeLog.ts 一致。 */
export const FAQ_CHANGE_SUBJECTS = ["faq", "follow_up", "option", "phrasing", "release"] as const;
export type FaqChangeSubject = (typeof FAQ_CHANGE_SUBJECTS)[number];

export type FaqChangeAction =
  | "created"
  | "edited"
  | "archived"
  | "added"
  | "changed"
  | "reordered"
  | "removed"
  | "version_created"
  | "published"
  | "rolled_back";

export type FaqFieldChange = { field: string; before: unknown; after: unknown };

export type FaqChangeNode = {
  id: string;
  key: string;
  questionEn: string;
  questionZh: string;
  status: "published" | "archived";
};

/** name = 登录邮箱 @ 之前（与会话显示名一致）；空 = 账号已不在。 */
export type FaqChangePerson = { id: string; name: string; role: string | null; email: string | null };

export type FaqChange = {
  id: string;
  at: string;
  /** null = 种子脚本 / 系统写入。 */
  employee: FaqChangePerson | null;
  subject: FaqChangeSubject;
  action: FaqChangeAction;
  faq: FaqChangeNode | null;
  child: FaqChangeNode | null;
  phrasing: { locale: string; text: string; source: string } | null;
  release: { version: number; status: FaqReleaseStatus; sourceVersion: number | null; problems: number } | null;
  version: { from: number | null; to: number } | null;
  changes: FaqFieldChange[];
  /** 学员是否已看到（版本事件为 null）。 */
  learners: "live" | "pending" | null;
  liveIn: number | null;
};

export type FaqChangePage = {
  changes: FaqChange[];
  total: number;
  page: number;
  pageSize: number;
  people: FaqChangePerson[];
};

export type FaqHistoryPage = {
  changes: FaqChange[];
  total: number;
  page: number;
  pageSize: number;
  truncated: boolean;
};

/**
 * 「AI 按指令改卡」（像 Claude Artifact，只用 DeepSeek；接口待后端确认）：不保存，只回一份改好的草稿。
 * selection：只改这一段（字段 + 字符位置）。
 */
export type FaqRewriteBody = {
  questionZh: string;
  answerZh: string;
  questionEn: string;
  answerEn: string;
  category: string | null;
  instruction: string;
  lang: "zh" | "en";
  selection?: { field: "questionZh" | "answerZh" | "questionEn" | "answerEn"; start: number; end: number };
};

export type FaqRewriteResult = {
  draft: { questionZh: string; answerZh: string; questionEn: string; answerEn: string; category: string | null };
  changed: string[];
  model: string;
  costUsd: number | null;
  /** 老的后端没有这个字段。 */
  warnings?: FaqRewriteWarning[];
};

/* ------------- 卡片全表逐张审核与改动历史（Admin server faqReview.ts；api-spec 第 8、9 节） ------------- */

export const FAQ_REVIEW_FILTERS = ["unreviewed", "needs_change", "ok", "all"] as const;
export type FaqReviewFilter = (typeof FAQ_REVIEW_FILTERS)[number];
export type FaqReviewStatus = "ok" | "needs_change";

export type HelpdeskPerson = { id: string; name: string };

/** 当前版本上最近的一次审核；faqVersion 小于卡的 version = 审过、后来改过（status 是 unreviewed）。 */
export type FaqReviewState = {
  status: "unreviewed" | FaqReviewStatus;
  faqVersion: number | null;
  note: string | null;
  by: HelpdeskPerson | null;
  at: string | null;
};

export type FaqReviewList = {
  faqs: HelpdeskFaq[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<"unreviewed" | FaqReviewStatus, number>;
  reviews: Record<string, FaqReviewState>;
};

export type FaqReviewBody = { status: FaqReviewStatus; version: number; note?: string };

export type FaqHistoryEntry =
  | {
      kind: "card";
      at: string;
      by: HelpdeskPerson | null;
      action: string;
      version: number;
      changes: { field: string; before: unknown; after: unknown }[];
    }
  | {
      kind: "placement";
      at: string;
      by: HelpdeskPerson | null;
      action: "create" | "update" | "delete";
      nodeKey: string | null;
      primary: { before: boolean | null; after: boolean | null };
    }
  | { kind: "review"; at: string; by: HelpdeskPerson | null; action: FaqReviewStatus; version: number; note: string | null };

export type FaqHistory = { faqId: string; version: number; review: FaqReviewState; history: FaqHistoryEntry[] };

/** AI 改卡的提醒（api-spec 第 10 节）：加了原卡和指令里都没有的数字 / 链接 / 邮箱，或者某一栏改坏了已保留原文。 */
export type FaqRewriteWarning =
  | { field: "questionZh" | "answerZh" | "questionEn" | "answerEn"; kind: "number" | "link" | "email"; text: string }
  | { field: "questionZh" | "answerZh" | "questionEn" | "answerEn"; kind: "dropped"; reason: "empty" | "too_long" | "language" };

/** 工单每日数字（api-spec §11，Portal 算，Admin 转一层）：按 UTC 日，没有工单的天也在，用时没有是 null。 */
export type TicketStatsDay = {
  day: string;
  created: number;
  resolved: number;
  cancelled: number;
  openAtEnd: number;
  firstReplies: number;
  firstReplyMedianMinutes: number | null;
  firstReplyP90Minutes: number | null;
};

export type TicketStats = {
  from: string;
  to: string;
  timeZone: "UTC";
  days: TicketStatsDay[];
  totals: {
    created: number;
    resolved: number;
    cancelled: number;
    firstReplies: number;
    firstReplyMedianMinutes: number | null;
    firstReplyP90Minutes: number | null;
  };
};
