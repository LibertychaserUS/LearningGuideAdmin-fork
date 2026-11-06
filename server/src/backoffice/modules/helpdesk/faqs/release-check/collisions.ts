import type { FaqReleaseSnapshot } from '../faqRelease';
import {
  faqVectorTexts,
  textHash,
  type FaqVectorSource,
  type FaqVectorTextRow,
} from '../faqVectors';

/**
 * 重复问法检查（release check v2，发布时免费跑，只用这一版已经算好的向量）：这一版新加到某张卡上的问题或
 * 问法，和别的卡上的某条文字几乎一样（余弦 ≥ min，2026-11-05 实测 v3.5 有 56 对卡、137 条文字在 0.95 以上）。
 * 同一句话挂在两张卡上，检索分不出该给哪张。
 *
 * 只看「新的」：(卡, 文字) 在上线版本里没有的。旧的重复不在这里拦（那是整理卡库的事），这样改一张卡只比
 * 这张卡的几条文字 × 全库，不是全库两两比。没有上线版本（第一次发布）→ 不比。
 *
 * 只提醒、不拦发布：两张卡说的可能是同一句话、但用户处境不同（本体论：对的卡 = 这句话 + 用户状态，
 * 例如付了款没解锁和订阅过期都会说「课程打不开」），那是该有的；两张卡的 signals 不同就标成 byState。
 */
export type FaqTextCollision = {
  similarity: number;
  /** 这一版新加的那条。 */
  added: { key: string; text: string; source: FaqVectorSource };
  /** 和它几乎一样的、别的卡上的那条。 */
  other: { key: string; text: string; source: FaqVectorSource };
  /** 两张卡靠用户状态（signals）分开：多半是该有的。 */
  byState: boolean;
};

export type CollisionReport = {
  /** 比了几条新文字（这一版新加到卡上的）。 */
  fresh: number;
  /** 全库几条文字。 */
  texts: number;
  /** 一共几对（列表至多 max 条，按相似度从高到低）。 */
  total: number;
  /** 涉及几对卡。 */
  cardPairs: number;
  pairs: FaqTextCollision[];
};

type Text = {
  nodeId: string;
  hash: string;
  text: string;
  source: FaqVectorSource;
};

/** 快照里每张卡要算向量的文字（和建索引时一样：faqVectorTexts）。 */
function snapshotTexts(snapshot: FaqReleaseSnapshot): Text[] {
  const phrasings = new Map<string, string[]>();
  for (const p of snapshot.phrasings)
    phrasings.set(p.faqId, [...(phrasings.get(p.faqId) ?? []), p.text]);
  return snapshot.nodes.flatMap((node) =>
    faqVectorTexts({
      questionEn: node.questionEn,
      questionZh: node.questionZh,
      phrasings: phrasings.get(node.id) ?? [],
    }).map((item) => ({
      nodeId: node.id,
      hash: textHash(item.text),
      text: item.text,
      source: item.source,
    })),
  );
}

const dot = (a: Float32Array, b: Float32Array) => {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

/**
 * 每比这么多条新文字让一下事件循环：6,700 条 × 1,024 维的库，一条新文字约 8 毫秒（2026-11-06 实测），
 * 改一张卡（十几条）不到 0.2 秒；整库换新（第一次之后的大批导入）约 27 秒，每段至多卡住约 60 毫秒。
 */
const YIELD_EVERY = 8;

export async function newTextCollisions(input: {
  rows: readonly FaqVectorTextRow[];
  snapshot: FaqReleaseSnapshot;
  live: FaqReleaseSnapshot | null;
  min: number;
  max: number;
}): Promise<CollisionReport> {
  const empty = {
    fresh: 0,
    texts: input.rows.length,
    total: 0,
    cardPairs: 0,
    pairs: [],
  };
  if (!input.live) return empty;
  const pairKey = (nodeId: string, hash: string) => `${nodeId}\n${hash}`;
  const old = new Set(
    snapshotTexts(input.live).map((t) => pairKey(t.nodeId, t.hash)),
  );
  const info = new Map(
    snapshotTexts(input.snapshot).map((t) => [pairKey(t.nodeId, t.hash), t]),
  );
  const nodes = new Map(input.snapshot.nodes.map((n) => [n.id, n]));
  const rows = input.rows.filter((r) => info.has(pairKey(r.nodeId, r.hash)));
  const isFresh = rows.map((r) => !old.has(pairKey(r.nodeId, r.hash)));
  const found: FaqTextCollision[] = [];
  const cards = new Set<string>();
  let fresh = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!isFresh[i]) continue;
    fresh += 1;
    if (fresh % YIELD_EVERY === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const a = rows[i];
    for (let j = 0; j < rows.length; j++) {
      const b = rows[j];
      // 两条都是新的：只数一次
      if (b.nodeId === a.nodeId || (isFresh[j] && j < i)) continue;
      const similarity = dot(a.vector, b.vector);
      if (similarity < input.min) continue;
      const one = info.get(pairKey(a.nodeId, a.hash))!;
      const two = info.get(pairKey(b.nodeId, b.hash))!;
      const left = nodes.get(a.nodeId)!;
      const right = nodes.get(b.nodeId)!;
      const signals = (n: typeof left) => JSON.stringify([...n.signals].sort());
      cards.add([a.nodeId, b.nodeId].sort().join('\n'));
      found.push({
        similarity: Number(similarity.toFixed(4)),
        added: { key: left.key, text: one.text, source: one.source },
        other: { key: right.key, text: two.text, source: two.source },
        byState:
          (left.signals.length > 0 || right.signals.length > 0) &&
          signals(left) !== signals(right),
      });
    }
  }
  found.sort(
    (x, y) =>
      y.similarity - x.similarity ||
      (x.added.key < y.added.key ? -1 : x.added.key > y.added.key ? 1 : 0),
  );
  return {
    fresh,
    texts: rows.length,
    total: found.length,
    cardPairs: cards.size,
    pairs: found.slice(0, input.max),
  };
}
