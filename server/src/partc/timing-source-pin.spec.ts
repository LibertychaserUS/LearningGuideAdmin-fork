import { timingSourcePinFromAlignment } from './api/partc-admin.repository';

/**
 * BUG（sandbox 审核 B 组 / ASR 发布门）：Plan 输入曾把 alignment.confidence 丢掉，
 * 而不变量要求 asr / forced-alignment 必须携带置信度，于是每条 ASR rendition 都被判
 * TIMING_SOURCE_MISSING——owner 定下的 ASR 默认路径永远过不了发布门。
 */
describe('timingSourcePinFromAlignment', () => {
  const asrRow = {
    renditionKey: 'L1/video/en-GB',
    sourceKind: 'asr',
    sourceArtifact: 'transcripts/l1.en-GB.json',
    modelVersion: 'whisper-large-v3',
    params: { beamSize: 5 },
    ruleVersion: 'timing-rules@1',
    confidence: 0.83,
  };

  it('carries the confidence of an ASR pin into the plan input', () => {
    expect(timingSourcePinFromAlignment(asrRow)).toEqual(
      expect.objectContaining({ confidence: 0.83, sourceKind: 'asr' }),
    );
  });

  it('carries confidence for forced alignment too', () => {
    const pin = timingSourcePinFromAlignment({
      ...asrRow,
      sourceKind: 'forced-alignment',
      confidence: 0.71,
    });
    expect(pin?.confidence).toBe(0.71);
  });

  it('omits confidence when the row has none (invariant then blocks it)', () => {
    const pin = timingSourcePinFromAlignment({ ...asrRow, confidence: null });
    expect(pin).not.toBeNull();
    expect(pin !== null && 'confidence' in pin).toBe(false);
  });

  it('never attaches confidence to subtitle/chapter sources', () => {
    const pin = timingSourcePinFromAlignment({
      ...asrRow,
      sourceKind: 'subtitle',
      confidence: 0.9,
    });
    expect(pin !== null && 'confidence' in pin).toBe(false);
  });

  it('returns null when the row has no derivation provenance', () => {
    expect(
      timingSourcePinFromAlignment({ ...asrRow, sourceArtifact: null }),
    ).toBeNull();
  });
});
