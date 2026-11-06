import type {
  FaqReleaseSnapshot,
  FaqSnapshotNode,
} from '../modules/helpdesk/faqs/faqRelease';
import {
  faqVectorTexts,
  textHash,
  type FaqVectorTextRow,
} from '../modules/helpdesk/faqs/faqVectors';
import { newTextCollisions } from '../modules/helpdesk/faqs/release-check/collisions';

/**
 * 重复问法检查（release check v2，release-check/collisions.ts）：这一版新加到某张卡上的文字，和别的卡上的
 * 文字几乎一样就列出来（只提醒）。向量是假的：同一个方向 = 同一句话的意思。
 */
const id = (n: number) =>
  `0192eeee-0000-7000-8000-${String(n).padStart(12, '0')}`;

function node(
  n: number,
  key: string,
  signals: FaqSnapshotNode['signals'] = [],
): FaqSnapshotNode {
  return {
    id: id(n),
    key,
    type: 'answer',
    entry: true,
    category: 'other',
    popular: false,
    questionEn: `Q ${key}`,
    answerEn: `A ${key}`,
    questionZh: `问 ${key}`,
    answerZh: `答 ${key}`,
    blocksEn: [],
    blocksZh: [],
    signals,
    keywords: [],
    version: 1,
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

const unit = (v: number[]) => {
  const norm = Math.hypot(...v);
  return Float32Array.from(v.map((x) => x / norm));
};

/** 文字 → 方向；没写的文字各自一个方向（互相不像）。 */
function rowsFor(
  snapshot: FaqReleaseSnapshot,
  directions: Record<string, number[]>,
): FaqVectorTextRow[] {
  const dims = 64;
  let next = 10;
  const rows: FaqVectorTextRow[] = [];
  for (const n of snapshot.nodes)
    for (const item of faqVectorTexts({
      questionEn: n.questionEn,
      questionZh: n.questionZh,
      phrasings: snapshot.phrasings
        .filter((p) => p.faqId === n.id)
        .map((p) => p.text),
    })) {
      const given = directions[item.text];
      const v = new Array<number>(dims).fill(0);
      if (given) given.forEach((x, i) => (v[i] = x));
      else v[next++] = 1;
      rows.push({ nodeId: n.id, hash: textHash(item.text), vector: unit(v) });
    }
  return rows;
}

const live: FaqReleaseSnapshot = {
  nodes: [
    node(1, 'refund'),
    node(2, 'cancel'),
    node(3, 'locked', ['payment_pending']),
    node(4, 'expired', ['subscription_expired']),
  ],
  edges: [],
  phrasings: [
    { faqId: id(1), locale: 'zh-CN', text: '怎么退款' },
    // an old near-duplicate that is already live: not this release's to fix
    { faqId: id(2), locale: 'zh-CN', text: '退订' },
    { faqId: id(1), locale: 'zh-CN', text: '退订了退钱吗' },
    { faqId: id(3), locale: 'en-GB', text: 'my course will not open' },
  ],
};

const directions = {
  怎么退款: [1, 0, 0],
  如何退款: [0.99, 0.05, 0],
  退订: [0, 1, 0],
  退订了退钱吗: [0, 0.99, 0.1],
  'my course will not open': [0, 0, 1],
  'the course does not open': [0, 0.02, 0.99],
};

describe('duplicate texts across cards (release check, free, only a note)', () => {
  it('lists a phrasing this release added to one card that says what another card already says, most similar first', async () => {
    const candidate: FaqReleaseSnapshot = {
      ...live,
      phrasings: [
        ...live.phrasings,
        // added to cancel, but refund already has it
        { faqId: id(2), locale: 'zh-CN', text: '如何退款' },
        // added to the same card that has the near-same wording: fine
        { faqId: id(1), locale: 'zh-CN', text: '如何退款' },
      ],
    };
    const report = await newTextCollisions({
      rows: rowsFor(candidate, directions),
      snapshot: candidate,
      live,
      min: 0.95,
      max: 30,
    });
    expect(report.fresh).toBe(2);
    expect(report.total).toBe(2);
    expect(report.cardPairs).toBe(1);
    expect(
      report.pairs.map((p) => [
        p.added.key,
        p.added.text,
        p.other.key,
        p.other.text,
      ]),
    ).toEqual([
      // the two new rows of the same text on refund and cancel: counted once
      ['refund', '如何退款', 'cancel', '如何退款'],
      ['cancel', '如何退款', 'refund', '怎么退款'],
    ]);
    expect(report.pairs[0].similarity).toBeCloseTo(1, 4);
    expect(report.pairs[1]).toMatchObject({
      added: { source: 'phrasing' },
      byState: false,
    });
  });

  it('marks two cards told apart by the user state (signals) as expected, and leaves old duplicates alone', async () => {
    const candidate: FaqReleaseSnapshot = {
      ...live,
      phrasings: [
        ...live.phrasings,
        { faqId: id(4), locale: 'en-GB', text: 'the course does not open' },
      ],
    };
    const report = await newTextCollisions({
      rows: rowsFor(candidate, directions),
      snapshot: candidate,
      live,
      min: 0.95,
      max: 30,
    });
    expect(
      report.pairs.map((p) => [p.added.key, p.other.key, p.byState]),
    ).toEqual([['expired', 'locked', true]]);
    // 退订 (cancel) and 退订了退钱吗 (refund) are both live: not listed
    expect(report.pairs.some((p) => p.other.text === '退订')).toBe(false);
  });

  it('compares nothing without a live version, and nothing when this release adds no text', async () => {
    const rows = rowsFor(live, directions);
    expect(
      await newTextCollisions({
        rows,
        snapshot: live,
        live: null,
        min: 0.95,
        max: 30,
      }),
    ).toMatchObject({ fresh: 0, total: 0, pairs: [] });
    expect(
      await newTextCollisions({
        rows,
        snapshot: live,
        live,
        min: 0.95,
        max: 30,
      }),
    ).toMatchObject({ fresh: 0, total: 0, texts: rows.length });
  });

  it('keeps at most max pairs but counts them all', async () => {
    const many: FaqReleaseSnapshot = {
      ...live,
      phrasings: [
        ...live.phrasings,
        { faqId: id(2), locale: 'zh-CN', text: '如何退款' },
        { faqId: id(3), locale: 'zh-CN', text: '如何退款' },
        { faqId: id(4), locale: 'zh-CN', text: '如何退款' },
      ],
    };
    const report = await newTextCollisions({
      rows: rowsFor(many, directions),
      snapshot: many,
      live,
      min: 0.95,
      max: 2,
    });
    // each of the three new rows against refund's 怎么退款, plus the three new rows among themselves
    expect(report.total).toBe(6);
    expect(report.pairs).toHaveLength(2);
  });
});
