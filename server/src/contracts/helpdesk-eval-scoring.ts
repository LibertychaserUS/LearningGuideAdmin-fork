import type { SuggestIntent, SuggestKind } from './helpdesk-qa';

/**
 * Helpdesk 评测的判分规则（一题对不对），只有这一份：发布前的检查（backoffice faqs/release-check）与
 * 评测脚本（eval/helpdesk/conversations.ts）都从这里取，免得两边各拷一份、慢慢对不上。
 *
 * - 期望出卡：出了标注的卡、也算对的卡（acceptable），或通向它的入口卡 → 对；入口卡单独记 viaEntry；
 *   出了别的卡 → 错卡；没出卡 → 没答上（不算错卡）。
 * - 期望追问：追问的是这张卡，且 covered 一致 → 对；出了卡 → 错卡。
 * - 期望寒暄：kind 是 smalltalk（意图对上，问候与含糊算同一种）→ 对；出了卡只记「多给卡片」，不算错卡（R3）。
 * - 期望不出卡（no_match）：没卡、或追问时说明没覆盖（covered = false）→ 对；出了任何卡 → 错卡。
 * - 期望转人工：给了转人工卡、追问时说明没覆盖、或连续没解决到了阈值 → 对。
 */

export const SMALLTALK_INTENTS = [
  'greeting',
  'farewell',
  'vague',
  'off_topic',
] as const;
export type SmalltalkIntent = (typeof SMALLTALK_INTENTS)[number];

export type TurnExpectation =
  | {
      kind: 'answer';
      faqId: string;
      acceptableFaqIds?: string[];
      /**
       * faqId 是追问（不是入口）时，通向它的入口卡片：新打的问题只在入口里检索（graph design §4），
       * 出这张入口卡片、学员再点一下追问也算对；报告里单独数（viaEntry）。
       */
      entryIds?: string[];
    }
  | { kind: 'clarify'; faqId: string; covered: boolean }
  | { kind: 'smalltalk'; intent?: SmalltalkIntent }
  | { kind: 'no_match' }
  | { kind: 'handover' };

/** 判分只看这几样（评测脚本的 GotTurn 是它的超集）。 */
export type ScoredTurn = {
  /** Admin 的 kind；handover = 只给转人工卡；click = 点追问 / 选项。 */
  kind: SuggestKind | 'handover' | 'click';
  /** 答案卡末尾另给了转人工卡。 */
  handover?: boolean;
  intent: SuggestIntent | null;
  nodeId: string | null;
  covered: boolean | null;
};

export type TurnScore = {
  right: boolean;
  wrongFaq: boolean;
  viaEntry?: boolean;
  extraCard?: boolean;
};

/** 连续几轮没解决就该转人工（和 Portal 的升级规则一致）。 */
export const UNSOLVED_HANDOVER_STREAK = 2;

/**
 * 学员看到的结果一样的寒暄意图算同一个：greeting 与 vague 都是一句问候、问要帮什么，再接情境 chips
 *（Part B §3；vague 只有在对上 choice 卡片时才不同，那时出的是卡片，kind 不是 smalltalk）。
 */
export function sameSmalltalk(
  got: SuggestIntent | null,
  expected: SmalltalkIntent | undefined,
): boolean {
  if (got === expected) return true;
  const opener = ['greeting', 'vague'];
  return (
    got !== null &&
    expected !== undefined &&
    opener.includes(got) &&
    opener.includes(expected)
  );
}

/** 一轮的判分；streak = 到这一轮为止连续没解决的轮数（转人工用）。 */
export function scoreTurn(
  expect: TurnExpectation,
  got: ScoredTurn,
  streak = 0,
): TurnScore {
  const shownCard = got.kind === 'answer' ? got.nodeId : null;
  const wrong = (allowed: string[]) =>
    shownCard !== null && !allowed.includes(shownCard);
  switch (expect.kind) {
    case 'answer': {
      const exact = [expect.faqId, ...(expect.acceptableFaqIds ?? [])];
      const allowed = [...exact, ...(expect.entryIds ?? [])];
      return {
        right: shownCard !== null && allowed.includes(shownCard),
        wrongFaq: wrong(allowed),
        viaEntry:
          shownCard !== null &&
          !exact.includes(shownCard) &&
          allowed.includes(shownCard),
      };
    }
    case 'clarify':
      return {
        right:
          got.kind === 'clarify' &&
          got.nodeId === expect.faqId &&
          got.covered === expect.covered,
        wrongFaq: shownCard !== null,
      };
    case 'smalltalk':
      return {
        right:
          got.kind === 'smalltalk' &&
          (expect.intent === undefined ||
            sameSmalltalk(got.intent, expect.intent)),
        wrongFaq: false,
        extraCard: shownCard !== null,
      };
    case 'no_match':
      return {
        right:
          got.kind === 'no_match' ||
          (got.kind === 'clarify' && got.covered === false),
        wrongFaq: shownCard !== null,
      };
    case 'handover':
      return {
        right:
          got.kind === 'handover' ||
          got.handover === true ||
          (got.kind === 'clarify' && got.covered === false) ||
          (got.kind === 'no_match' && streak >= UNSOLVED_HANDOVER_STREAK),
        wrongFaq: false,
        // 关键词那一轮先给答案卡、末尾再给转人工卡：用户 2026-10-30「转人工也先尽量用卡片解决」，不算多给
        extraCard: shownCard !== null && got.handover !== true,
      };
  }
}
