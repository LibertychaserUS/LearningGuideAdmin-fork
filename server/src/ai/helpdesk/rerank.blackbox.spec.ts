import type { HelpdeskQaCandidate } from '../../contracts/helpdesk-qa';
import { directPick, rerankConfig } from './rerank';

const KEY = { OPENROUTER_API_KEY: 'sk-test' };
const env = (
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv => ({
  ...KEY,
  ...extra,
});
const direct = (value: string | undefined) =>
  rerankConfig(env({ HELPDESK_RERANK_DIRECT: value }))?.direct;

function cand(
  id: string,
  rerankScore?: number,
  extra: Partial<HelpdeskQaCandidate> = {},
): HelpdeskQaCandidate {
  const c: HelpdeskQaCandidate = {
    id,
    category: 'other',
    question: `q-${id}`,
    answer: `a-${id}`,
    score: 0.5,
    ...extra,
  };
  if (rerankScore !== undefined) c.rerankScore = rerankScore;
  return c;
}

describe('rerankConfig', () => {
  it('R1 returns null when OPENROUTER_API_KEY is unset', () => {
    expect(rerankConfig({})).toBeNull();
  });
  it('R1 returns null when the key is empty', () => {
    expect(rerankConfig({ OPENROUTER_API_KEY: '' })).toBeNull();
  });
  it('R1 returns null when the key is only spaces', () => {
    expect(rerankConfig({ OPENROUTER_API_KEY: '   ' })).toBeNull();
  });
  it('R1 returns a config with a usable key', () => {
    expect(rerankConfig(env())).not.toBeNull();
  });

  it.each(['off', 'OFF', 'Off', '  off  ', ' OfF'])(
    'R2 returns null when model is %j',
    (v) => {
      expect(rerankConfig(env({ HELPDESK_RERANK_MODEL: v }))).toBeNull();
    },
  );

  it('R3 defaults the model when unset', () => {
    expect(rerankConfig(env())?.model).toBe('voyageai/rerank-2.5-lite');
  });
  it('R3 defaults the model when blank', () => {
    expect(rerankConfig(env({ HELPDESK_RERANK_MODEL: '   ' }))?.model).toBe(
      'voyageai/rerank-2.5-lite',
    );
    expect(rerankConfig(env({ HELPDESK_RERANK_MODEL: '' }))?.model).toBe(
      'voyageai/rerank-2.5-lite',
    );
  });
  it('R3 uses the trimmed custom model', () => {
    expect(
      rerankConfig(env({ HELPDESK_RERANK_MODEL: '  cohere/rerank-v3  ' }))
        ?.model,
    ).toBe('cohere/rerank-v3');
  });

  it('R4 keep defaults to 5 when unset or blank', () => {
    expect(rerankConfig(env())?.keep).toBe(5);
    expect(rerankConfig(env({ HELPDESK_RERANK_KEEP: '' }))?.keep).toBe(5);
    expect(rerankConfig(env({ HELPDESK_RERANK_KEEP: '   ' }))?.keep).toBe(5);
  });
  it.each([
    ['1', 1],
    ['3', 3],
    ['10', 10],
    [' 7 ', 7],
  ])('R4 keep %j -> %d', (v, n) => {
    expect(rerankConfig(env({ HELPDESK_RERANK_KEEP: v }))?.keep).toBe(n);
  });
  it.each(['off', 'OFF', ' Off '])('R4 keep %j -> null (keep all)', (v) => {
    expect(rerankConfig(env({ HELPDESK_RERANK_KEEP: v }))?.keep).toBeNull();
  });
  it.each(['0', '-2', '2.5', 'abc', '1e1', '51'])(
    'R4 keep %j is malformed -> the default 5 (reported, see R7)',
    (v) => {
      expect(rerankConfig(env({ HELPDESK_RERANK_KEEP: v }))?.keep).toBe(5);
    },
  );

  it('R5 direct defaults to 0.84/0.05 when unset or blank (old 0.816 gone)', () => {
    expect(direct(undefined)).toEqual({ score: 0.84, margin: 0.05 });
    expect(direct('')).toEqual({ score: 0.84, margin: 0.05 });
    expect(direct('   ')).toEqual({ score: 0.84, margin: 0.05 });
    expect(direct(undefined)?.score).not.toBe(0.816);
  });
  it.each([
    ['0.9,0.1', { score: 0.9, margin: 0.1 }],
    [' 0.7 , 0.2 ', { score: 0.7, margin: 0.2 }],
    ['0,0', { score: 0, margin: 0 }],
    ['1,1', { score: 1, margin: 1 }],
    ['0.84,0.05', { score: 0.84, margin: 0.05 }],
  ])('R5 direct %j parses', (v, expected) => {
    expect(direct(v)).toEqual(expected);
  });
  it.each(['off', 'OFF'])('R5 direct %j -> null (never direct)', (v) => {
    const cfg = rerankConfig(env({ HELPDESK_RERANK_DIRECT: v }));
    expect(cfg).not.toBeNull();
    expect(cfg?.direct).toBeNull();
  });
  it.each([
    '0.84',
    '0.84,0.05,1',
    '1.2,0.05',
    '0.8,1.5',
    '-0.1,0.05',
    '0.8,-0.05',
    'abc',
    'a,b',
    '0.8,',
    ',0.05',
    'NaN,0.05',
    'Infinity,0.05',
    '1e-1,0.05',
    '0x1,0.05',
  ])(
    'R5 direct %j is malformed -> the default 0.84/0.05 (reported, see R7)',
    (v) => {
      const cfg = rerankConfig(env({ HELPDESK_RERANK_DIRECT: v }));
      expect(cfg).not.toBeNull();
      expect(cfg?.direct).toEqual({ score: 0.84, margin: 0.05 });
    },
  );

  it('R6 default direct object is a fresh copy per call', () => {
    const a = rerankConfig(env());
    expect(a?.direct).not.toBeNull();
    (a!.direct as { score: number; margin: number }).score = 0.1;
    (a!.direct as { score: number; margin: number }).margin = 0.9;
    const b = rerankConfig(env());
    expect(b?.direct).toEqual({ score: 0.84, margin: 0.05 });
    expect(b?.direct).not.toBe(a?.direct);
  });
  it('R6 env is read on every call', () => {
    expect(rerankConfig(env({ HELPDESK_RERANK_KEEP: '2' }))?.keep).toBe(2);
    expect(rerankConfig(env({ HELPDESK_RERANK_KEEP: '4' }))?.keep).toBe(4);
    expect(rerankConfig({})).toBeNull();
  });
});

describe('directPick', () => {
  const D = { score: 0.84, margin: 0.05 };

  it('D1 null direct -> null', () => {
    expect(directPick([cand('a', 0.99), cand('b', 0.1)], null)).toBeNull();
  });
  it('D1 empty list -> null', () => {
    expect(directPick([], D)).toBeNull();
  });

  it('D2 only the first candidate can be picked', () => {
    expect(directPick([cand('a', 0.5), cand('b', 0.99)], D)).toBeNull();
  });
  it('D2 first without rerankScore -> null', () => {
    expect(directPick([cand('a'), cand('b', 0.99)], D)).toBeNull();
  });

  it('D3 first with type answer is pickable', () => {
    const a = cand('a', 0.95, { type: 'answer' });
    expect(directPick([a, cand('b', 0.1)], D)).toBe(a);
  });
  it('D3 first with no type is pickable', () => {
    const a = cand('a', 0.95);
    expect(directPick([a, cand('b', 0.1)], D)).toBe(a);
  });
  it('D3 first of type choice -> null', () => {
    expect(
      directPick([cand('a', 0.99, { type: 'choice' }), cand('b', 0.1)], D),
    ).toBeNull();
  });

  it('D4 single candidate: second counts as 0', () => {
    const a = cand('a', 0.9);
    expect(directPick([a], D)).toBe(a);
  });
  it('D4 single candidate with score below threshold -> null', () => {
    expect(directPick([cand('a', 0.8)], D)).toBeNull();
  });
  it('D4 second without rerankScore counts as 0', () => {
    const a = cand('a', 0.9);
    expect(directPick([a, cand('b')], D)).toBe(a);
  });
  it('D4 second without rerankScore counts as 0 (margin larger than score fails)', () => {
    expect(
      directPick([cand('a', 0.9), cand('b')], { score: 0.8, margin: 0.95 }),
    ).toBeNull();
  });
  it('D4 a choice-typed second still counts for the lead', () => {
    expect(
      directPick([cand('a', 0.9), cand('b', 0.88, { type: 'choice' })], D),
    ).toBeNull();
  });

  it('D5 spec example: 0.84 with second 0.79 is picked', () => {
    const a = cand('a', 0.84);
    expect(directPick([a, cand('b', 0.79)], D)).toBe(a);
  });
  it.each([
    [0.9, 0.85, 0.9, 0.05],
    [0.3, 0.25, 0.3, 0.05],
    [0.84, 0.79, 0.84, 0.05],
    [0.7, 0.65, 0.7, 0.05],
    [0.6, 0.5, 0.6, 0.1],
    [0.55, 0.45, 0.55, 0.1],
    [0.35, 0.3, 0.35, 0.05],
  ])(
    'D5 exactly equal score %d / second %d at {%d,%d} is picked',
    (s, second, ds, dm) => {
      const a = cand('a', s);
      expect(
        directPick([a, cand('b', second)], { score: ds, margin: dm }),
      ).toBe(a);
    },
  );
  it('D5 score just below threshold -> null', () => {
    expect(directPick([cand('a', 0.839), cand('b', 0.1)], D)).toBeNull();
  });
  it('D5 lead just below margin -> null', () => {
    expect(directPick([cand('a', 0.9), cand('b', 0.851)], D)).toBeNull();
  });
  it('D5 score above, lead exactly margin picked', () => {
    const a = cand('a', 0.95);
    expect(directPick([a, cand('b', 0.9)], D)).toBe(a);
  });
  it('D5 zero margin with tie is picked', () => {
    const a = cand('a', 0.9);
    expect(directPick([a, cand('b', 0.9)], { score: 0.9, margin: 0 })).toBe(a);
  });
  it('D5 returns the same object, not a copy', () => {
    const a = cand('a', 0.99);
    const r = directPick([a, cand('b', 0.1)], D);
    expect(r).toBe(a);
  });

  it('D6 candidates and list are not mutated', () => {
    const list = [cand('a', 0.9), cand('b', 0.2)];
    const snap: unknown = JSON.parse(JSON.stringify(list));
    const d = { score: 0.84, margin: 0.05 };
    directPick(list, d);
    expect(JSON.parse(JSON.stringify(list))).toEqual(snap);
    expect(list.map((c) => c.id)).toEqual(['a', 'b']);
    expect(d).toEqual({ score: 0.84, margin: 0.05 });
  });
});
