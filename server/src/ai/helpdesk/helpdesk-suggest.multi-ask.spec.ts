import {
  suggestTurnProblems,
  type FaqBlock,
  type HelpdeskQaCandidate,
  type HelpdeskQaSearch,
  type HelpdeskQaSource,
} from '../../contracts/helpdesk-qa';
import type { JsonObject } from '../../contracts/helpdesk-trace';
import { MemoryRateLimitStore } from '../rate-limit.service';
import { HelpdeskSuggestService } from './helpdesk-suggest.service';
import type {
  HelpdeskSuggestionLog,
  SuggestionLogEntry,
} from './helpdesk-suggestion.store';
import { createMemoryAgentEventLog } from './trace/agent-event.store';
import type {
  AgentCallExtras,
  AgentStepContext,
  AgentStepOutcome,
  AgentStepSpec,
} from './workflow/engine';
import { ANSWER_LINES } from './workflow/guard';
import {
  PICK_ASKS_SYSTEM,
  SEVERAL_OPENING,
  SPLIT_ASKS_SYSTEM,
} from './workflow/multi-ask';

/**
 * 一句话问了几件事（multi-ask.ts，HELPDESK_MULTI_ASK）：拆开、每件事各自检索挑卡、按问的顺序组回复。
 * 模型是假的 runner（按工具名回话），从不连真模型；每个回包都用契约的 suggestTurnProblems 自检。
 */
const LEARNER = 'portal-user-multi';
const id = (n: number) =>
  `0192dddd-0000-7000-8000-${String(n).padStart(12, '0')}`;
const blocksOf = (texts: string[]): FaqBlock[] =>
  texts.map((text, i) => ({ id: `b${i + 1}`, text }));

const card = (
  n: number,
  question: string,
  answer: string,
  extra: Partial<HelpdeskQaCandidate> = {},
): HelpdeskQaCandidate => ({
  id: id(n),
  category: 'account_technical',
  question,
  answer,
  score: 1,
  type: 'answer',
  entry: true,
  blocks: blocksOf([answer]),
  optionOf: [],
  relation: 'search',
  ...extra,
});

const RESET = card(
  1,
  'How do I reset my password?',
  'Use **Forgot password** on the sign-in page.',
);
const FAILED = card(2, 'My payment failed', 'Try another card.', {
  category: 'payments_subscriptions',
});
const EMAIL = card(
  3,
  'How do I change my email?',
  'Open **Personal settings** and edit **Email**.',
);
const CHOICE = card(9, 'Having trouble?', 'Which is it?', { type: 'choice' });

const MESSAGE =
  'How do I reset my password? Also my payment failed, what should I do?';
const ASK_RESET = 'How do I reset my password?';
const ASK_FAILED = 'What should I do when my payment failed?';

type Reply = (
  spec: AgentStepSpec,
  context: AgentStepContext,
) => Promise<AgentStepOutcome>;

function called(
  args: Record<string, string>,
  extras: Partial<AgentCallExtras> = {},
): Promise<AgentStepOutcome> {
  return Promise.resolve({
    kind: 'called',
    args,
    extras: { lists: {}, texts: {}, flags: {}, ...extras },
  });
}

const split =
  (...asks: string[]): Reply =>
  () =>
    called(
      { count: String(Math.max(1, asks.length)) },
      {
        texts: Object.fromEntries(asks.map((text, i) => [`ask${i + 1}`, text])),
      },
    );

function setup(
  options: {
    split?: Reply;
    pickAsks?: Reply;
    pick?: Reply;
    multiAsk?: 'on' | 'off' | undefined;
    byText?: Record<string, HelpdeskQaCandidate[]>;
  } = {},
) {
  const byText: Record<string, HelpdeskQaCandidate[]> = options.byText ?? {
    [MESSAGE]: [RESET, FAILED, EMAIL, CHOICE],
    [ASK_RESET]: [RESET, EMAIL],
    [ASK_FAILED]: [FAILED, RESET],
  };
  const findCandidates = jest.fn((search: HelpdeskQaSearch) =>
    Promise.resolve(byText[search.text] ?? [EMAIL]),
  );
  const qa: HelpdeskQaSource = {
    findCandidates,
    findPublished: () => Promise.resolve(null),
    findPopular: () => Promise.resolve([]),
    releaseVersion: () => Promise.resolve(4),
  };
  const run = jest.fn<
    Promise<AgentStepOutcome>,
    [AgentStepSpec, AgentStepContext]
  >((spec, context) => {
    if (spec.tool.name === 'split_asks')
      return (options.split ?? split(ASK_RESET, ASK_FAILED))(spec, context);
    if (spec.tool.name === 'pick_asks')
      return (
        options.pickAsks ??
        (() =>
          called({
            intent: 'question',
            card1: RESET.id,
            confidence1: 'sure',
            card2: FAILED.id,
            confidence2: 'sure',
          }))
      )(spec, context);
    return (
      options.pick ??
      (() =>
        called({ intent: 'question', faqId: RESET.id, confidence: 'sure' }))
    )(spec, context);
  });
  const rows: SuggestionLogEntry[] = [];
  const log: HelpdeskSuggestionLog = {
    record: (entry) => {
      rows.push(entry);
      return Promise.resolve();
    },
    setOutcome: () => Promise.resolve({ kind: 'not_found' }),
    purgeQueryText: () => Promise.resolve(0),
  };
  const events = createMemoryAgentEventLog();
  const env: NodeJS.ProcessEnv = {
    OPENROUTER_API_KEY: 'test-openrouter-key-local-only',
    OPENROUTER_BASE_URL: 'http://llm.test/v1',
    HELPDESK_SUGGEST_MODEL: 'test/cheap-model',
    HELPDESK_RERANK_MODEL: 'off',
    ...(options.multiAsk ? { HELPDESK_MULTI_ASK: options.multiAsk } : {}),
  };
  const service = new HelpdeskSuggestService({
    qa,
    runner: { run },
    rateLimit: new MemoryRateLimitStore(),
    log,
    events,
    env: () => env,
  });
  const tools = () => run.mock.calls.map(([spec]) => spec.tool.name);
  const specOf = (name: string) =>
    run.mock.calls.map(([spec]) => spec).find((s) => s.tool.name === name);
  return { service, run, rows, events, findCandidates, tools, specOf };
}

const chat = (
  message: string,
  context: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  learnerId: LEARNER,
  locale: 'en-GB',
  source: 'chat',
  message,
  context,
  ...extra,
});

async function ask(service: HelpdeskSuggestService, body: unknown) {
  const result = await service.suggest(body);
  expect(suggestTurnProblems(result)).toEqual([]);
  return result as unknown as Record<string, unknown>;
}

describe('multi-ask is off unless HELPDESK_MULTI_ASK=on', () => {
  it('by default a two-question message goes through pick_faq alone, with no more / missed keys', async () => {
    const { service, tools } = setup();
    const result = await ask(service, chat(MESSAGE));
    expect(tools()).toEqual(['pick_faq']);
    expect(result).toMatchObject({ kind: 'answer', nodeId: RESET.id });
    expect('more' in result).toBe(false);
    expect('missed' in result).toBe(false);
  });
});

describe('multi-ask on: several asks, one card each, in the order asked', () => {
  it('splits while retrieving, retrieves answer cards per ask, and gives the first card plus the rest in more', async () => {
    const { service, tools, findCandidates, specOf } = setup({
      multiAsk: 'on',
    });
    const result = await ask(service, chat(MESSAGE));
    // 拆问不挡单问题的路：pick_faq 照常问；route 要出卡前才等拆问，拆出两件事 → pick_asks
    expect(tools()).toEqual(['split_asks', 'pick_faq', 'pick_asks']);
    expect(result).toMatchObject({
      kind: 'answer',
      intent: 'question',
      confidence: 'sure',
      suggestion: { faqId: RESET.id, question: RESET.question },
      nodeId: RESET.id,
      alternatives: [],
      // 几张卡：开场白说按问的顺序，收尾照旧
      opening: SEVERAL_OPENING.en,
      closing: ANSWER_LINES.problem.closing.en,
      more: [
        {
          faqId: FAILED.id,
          question: FAILED.question,
          answer: FAILED.answer,
          blocks: [],
        },
      ],
    });
    expect('missed' in result).toBe(false);
    // 每件事各查一次，只要答案卡
    const searches = findCandidates.mock.calls.map(([s]) => s);
    expect(searches.map((s) => s.text)).toEqual([
      MESSAGE,
      ASK_RESET,
      ASK_FAILED,
    ]);
    expect(searches.slice(1).every((s) => s.types?.join() === 'answer')).toBe(
      true,
    );
    // 拆问只看这一句；挑卡每件事只能选它自己的候选或 none
    const splitSpec = specOf('split_asks') as AgentStepSpec;
    expect(splitSpec.system).toBe(SPLIT_ASKS_SYSTEM);
    expect(JSON.parse(splitSpec.prompt)).toEqual({ message: MESSAGE });
    const pickSpec = specOf('pick_asks') as AgentStepSpec;
    expect(pickSpec.system).toBe(PICK_ASKS_SYSTEM);
    // 只有拆问走最快的 provider（owner 2026-11-06）；挑卡照旧只选最便宜
    expect(splitSpec.routing).toBe('fastest');
    expect(pickSpec.routing).toBeUndefined();
    expect((specOf('pick_faq') as AgentStepSpec).routing).toBeUndefined();
    // 几件事共用一个候选池：各件事的候选与整句的答案卡按名次轮流取（choice 卡片不进来）
    const poolIds = [RESET.id, FAILED.id, EMAIL.id, 'none'];
    expect(pickSpec.tool.enumArgs).toMatchObject({
      card1: poolIds,
      card2: poolIds,
      confidence1: ['sure', 'unsure'],
    });
    const prompt = JSON.parse(pickSpec.prompt) as {
      asks: { n: number; text: string }[];
    };
    expect(prompt.asks).toEqual([
      { n: 1, text: ASK_RESET },
      { n: 2, text: ASK_FAILED },
    ]);
  });

  it('keeps the order the user asked in, even when the second ask is the closer match', async () => {
    const { service } = setup({
      multiAsk: 'on',
      split: split(ASK_FAILED, ASK_RESET),
      pickAsks: () =>
        called({
          intent: 'question',
          card1: FAILED.id,
          confidence1: 'sure',
          card2: RESET.id,
          confidence2: 'sure',
        }),
    });
    const result = await ask(service, chat(MESSAGE));
    expect(result.nodeId).toBe(FAILED.id);
    expect((result.more as { faqId: string }[]).map((c) => c.faqId)).toEqual([
      RESET.id,
    ]);
  });

  it('counts an ask with no card (none or unsure) as missed, and still answers the other', async () => {
    const { service } = setup({
      multiAsk: 'on',
      pickAsks: () =>
        called({
          intent: 'question',
          card1: 'none',
          confidence1: 'sure',
          card2: FAILED.id,
          confidence2: 'sure',
        }),
    });
    const result = await ask(service, chat(MESSAGE));
    expect(result).toMatchObject({
      kind: 'answer',
      nodeId: FAILED.id,
      missed: 1,
    });
    expect('more' in result).toBe(false);
    const unsure = setup({
      multiAsk: 'on',
      pickAsks: () =>
        called({
          intent: 'question',
          card1: RESET.id,
          confidence1: 'sure',
          card2: FAILED.id,
          confidence2: 'unsure',
        }),
    });
    expect(await ask(unsure.service, chat(MESSAGE))).toMatchObject({
      nodeId: RESET.id,
      missed: 1,
    });
  });

  it('shows a card picked for two asks once, without counting the second ask as missed', async () => {
    const { service } = setup({
      multiAsk: 'on',
      pickAsks: () =>
        called({
          intent: 'question',
          card1: RESET.id,
          confidence1: 'sure',
          card2: RESET.id,
          confidence2: 'sure',
        }),
    });
    const result = await ask(service, chat(MESSAGE));
    expect(result.nodeId).toBe(RESET.id);
    expect('more' in result).toBe(false);
    expect('missed' in result).toBe(false);
    // 一张卡：开场白与单问一样
    expect(result.opening).not.toBe(SEVERAL_OPENING.en);
  });

  it('no card for any ask, or not a real question: no_match with alternatives from the whole message', async () => {
    const none = setup({
      multiAsk: 'on',
      pickAsks: () =>
        called({
          intent: 'question',
          card1: 'none',
          confidence1: 'sure',
          card2: 'none',
          confidence2: 'sure',
        }),
    });
    const result = await ask(none.service, chat(MESSAGE));
    expect(result).toMatchObject({ kind: 'no_match', suggestion: null });
    expect(
      (result.alternatives as { faqId: string }[]).map((a) => a.faqId),
    ).toEqual([RESET.id, FAILED.id, EMAIL.id]);
    const someoneElse = setup({
      multiAsk: 'on',
      pickAsks: () =>
        called({
          intent: 'someone_else',
          card1: RESET.id,
          confidence1: 'sure',
          card2: FAILED.id,
          confidence2: 'sure',
        }),
    });
    expect(await ask(someoneElse.service, chat(MESSAGE))).toMatchObject({
      kind: 'no_match',
      intent: 'someone_else',
      suggestion: null,
    });
  });

  it('ignores a card id that is not in the pool', async () => {
    const { service } = setup({
      multiAsk: 'on',
      pickAsks: () =>
        called({
          intent: 'question',
          card1: RESET.id,
          confidence1: 'sure',
          card2: CHOICE.id,
          confidence2: 'sure',
        }),
    });
    expect(await ask(service, chat(MESSAGE))).toMatchObject({
      nodeId: RESET.id,
      missed: 1,
    });
  });
});

describe('multi-ask on: when it does not split', () => {
  it('one ask (count 1), a broken split or a split that times out: the usual pick_faq turn', async () => {
    for (const reply of [
      split(),
      split(ASK_RESET, ''),
      split(ASK_RESET, ASK_RESET),
      () => Promise.resolve({ kind: 'error', message: 'boom' } as const),
      () => Promise.resolve({ kind: 'aborted' } as const),
    ] satisfies Reply[]) {
      const { service, tools } = setup({ multiAsk: 'on', split: reply });
      const result = await ask(service, chat(MESSAGE));
      expect(tools()).toEqual(['split_asks', 'pick_faq']);
      expect(result).toMatchObject({ kind: 'answer', nodeId: RESET.id });
      expect('more' in result).toBe(false);
    }
  });

  it('does not ask to split a short or single-question message, or a follow-up on the card on screen', async () => {
    const short = setup({ multiAsk: 'on' });
    await ask(short.service, chat('reset password'));
    expect(short.tools()).toEqual(['pick_faq']);
    const shown = setup({ multiAsk: 'on' });
    await shown.service.suggest(chat(MESSAGE, { nodeId: RESET.id }));
    expect(shown.tools()).not.toContain('split_asks');
  });

  it('a request that is not a question does not wait for the split, which is cancelled', async () => {
    const { service, events } = setup({
      multiAsk: 'on',
      split: () => new Promise(() => undefined),
      pick: () =>
        called({ intent: 'someone_else', faqId: 'none', confidence: 'sure' }),
    });
    const runId = id(701);
    const started = Date.now();
    const result = await ask(service, { ...chat(MESSAGE), runId });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({ kind: 'no_match', intent: 'someone_else' });
    await service.flushTraces();
    const splitEnd = (await events.read(runId)).find(
      (e) => e.type === 'step/end' && e.data.name === 'split_asks',
    );
    expect(splitEnd?.data.outcome).toBe('cancelled');
  });

  it('a failed pick_asks call ends the turn like a failed pick_faq (no card)', async () => {
    const { service } = setup({
      multiAsk: 'on',
      pickAsks: () => Promise.resolve({ kind: 'error', message: 'boom' }),
    });
    expect(await service.suggest(chat(MESSAGE))).toMatchObject({
      kind: 'no_match',
      suggestion: null,
    });
  });
});

describe('multi-ask logging', () => {
  it('logs the split as its own step (ask texts only by length), the asks on turn/end and every ask’s candidates', async () => {
    const { service, events, rows } = setup({ multiAsk: 'on' });
    const runId = id(700);
    await service.suggest({ ...chat(MESSAGE), runId });
    await service.flushTraces();
    const log = await events.read(runId);
    const steps = log
      .filter((e) => e.type === 'step/start')
      .map((e) => [e.data.name, e.data.parent ?? null]);
    expect(steps).toEqual([
      ['retrieve', null],
      ['split_asks', 1],
      ['pick_faq', null],
      ['route', null],
      ['retrieve_asks', null],
      ['pick_asks', null],
      ['compose', null],
    ]);
    const splitEnd = log.find(
      (e) => e.type === 'step/end' && e.data.name === 'split_asks',
    )?.data as JsonObject;
    expect(splitEnd.texts).toEqual({
      ask1: { length: [...ASK_RESET].length },
      ask2: { length: [...ASK_FAILED].length },
    });
    const end = log.find((e) => e.type === 'turn/end')?.data as JsonObject;
    expect(end).toMatchObject({
      reason: 'answered',
      faqId: RESET.id,
      asks: 2,
      more: [FAILED.id],
      missed: 0,
    });
    const others = log.filter((e) => e.type !== 'turn/start');
    expect(JSON.stringify(others)).not.toContain(ASK_FAILED);
    expect(rows[0]).toMatchObject({
      faqId: RESET.id,
      model: 'test/cheap-model',
      candidateIds: [RESET.id, FAILED.id, EMAIL.id, CHOICE.id],
    });
  });
});
