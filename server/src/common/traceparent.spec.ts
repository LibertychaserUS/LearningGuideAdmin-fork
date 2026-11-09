import { childTraceparent, parseTraceparent, startTrace } from './traceparent';

/**
 * W3C Trace Context Level 1 §3.2 traceparent：version-traceid-parentid-flags，全小写十六进制；
 * version ff 无效；全零 trace-id / parent-id 无效；00 版必须正好 55 字符；更高版本只取前四段，
 * 且第 56 个字符必须是 '-'。无效即重开一条新 trace。
 */
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';

describe('parseTraceparent', () => {
  it('accepts the spec example', () => {
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-01`)).toEqual({
      traceId: TRACE,
      parentId: PARENT,
      flags: '01',
    });
  });

  it('accepts unknown flags and a higher version with extra fields', () => {
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-00`)?.flags).toBe('00');
    expect(
      parseTraceparent(`cc-${TRACE}-${PARENT}-09-what-the-future`),
    ).toEqual({ traceId: TRACE, parentId: PARENT, flags: '09' });
    expect(parseTraceparent(`cc-${TRACE}-${PARENT}-01`)).not.toBeNull();
  });

  it('trims surrounding whitespace (OWS)', () => {
    expect(parseTraceparent(` 00-${TRACE}-${PARENT}-01\t`)?.traceId).toBe(
      TRACE,
    );
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a string', ['a', 'b']],
    ['version ff', `ff-${TRACE}-${PARENT}-01`],
    ['upper-case hex', `00-${TRACE.toUpperCase()}-${PARENT}-01`],
    ['all-zero trace id', `00-${'0'.repeat(32)}-${PARENT}-01`],
    ['all-zero parent id', `00-${TRACE}-${'0'.repeat(16)}-01`],
    ['short trace id', `00-${TRACE.slice(1)}-${PARENT}-01`],
    ['version 00 with extra data', `00-${TRACE}-${PARENT}-01-extra`],
    ['higher version without a dash after flags', `cc-${TRACE}-${PARENT}-01x`],
    [
      'two headers joined by a comma',
      `00-${TRACE}-${PARENT}-01, 00-${TRACE}-${PARENT}-01`,
    ],
    ['non-hex flags', `00-${TRACE}-${PARENT}-0g`],
    ['a one-digit version', `0-${TRACE}-${PARENT}-01`],
  ])('rejects %s', (_name, value) => {
    expect(parseTraceparent(value)).toBeNull();
  });
});

describe('startTrace / childTraceparent', () => {
  it('continues a valid incoming trace with a new span of our own', () => {
    const trace = startTrace(`00-${TRACE}-${PARENT}-01`);
    expect(trace.traceId).toBe(TRACE);
    expect(trace.parentId).toBe(PARENT);
    expect(trace.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(trace.spanId).not.toBe(PARENT);
    expect(trace.flags).toBe('01');
    expect(trace.restarted).toBe(false);
  });

  it('starts a new trace when the header is missing or invalid', () => {
    for (const header of [undefined, `ff-${TRACE}-${PARENT}-01`]) {
      const trace = startTrace(header);
      expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(trace.traceId).not.toBe('0'.repeat(32));
      expect(trace.traceId).not.toBe(TRACE);
      expect(trace.parentId).toBeNull();
      expect(trace.flags).toBe('00');
      expect(trace.restarted).toBe(true);
    }
    expect(startTrace(undefined).traceId).not.toBe(
      startTrace(undefined).traceId,
    );
  });

  it('gives each outgoing call a child traceparent with the same trace id', () => {
    const trace = startTrace(`cc-${TRACE}-${PARENT}-01-future`);
    const one = childTraceparent(trace);
    const two = childTraceparent(trace);
    // we always send version 00, whatever version came in
    expect(one).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-01$`));
    expect(parseTraceparent(one)).not.toBeNull();
    expect(one).not.toBe(two);
    expect(one.split('-')[2]).not.toBe(trace.spanId);
  });
});
