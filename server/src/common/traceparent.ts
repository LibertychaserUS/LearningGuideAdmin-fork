import { randomBytes } from 'node:crypto';

/**
 * W3C Trace Context（Level 1 §3.2）traceparent 的解析与传递：Portal → Admin → OpenRouter。
 * 收到的无效即忽略并重开一条 trace（规范 §4.3）；发出的一律是 00 版。
 */
export type TraceParent = { traceId: string; parentId: string; flags: string };

export type TraceContext = {
  traceId: string;
  /** 调用方的 span（收到的 parent-id）；新开的 trace 为 null。 */
  parentId: string | null;
  /** 本次推荐自己的 span。 */
  spanId: string;
  flags: string;
  /** 收到的 traceparent 缺失或无效，重开了 trace。 */
  restarted: boolean;
};

const HEX = /^[0-9a-f]+$/;
const isHex = (value: string, length: number) =>
  value.length === length && HEX.test(value);
const allZero = (value: string) => /^0+$/.test(value);

export function parseTraceparent(raw: unknown): TraceParent | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length < 55) return null;
  const [version, traceId, parentId, flags] = value.slice(0, 55).split('-');
  if (!isHex(version, 2) || version === 'ff') return null;
  if (
    version === '00'
      ? value.length !== 55
      : value.length > 55 && value[55] !== '-'
  )
    return null;
  if (!isHex(traceId, 32) || allZero(traceId)) return null;
  if (!isHex(parentId, 16) || allZero(parentId)) return null;
  if (!isHex(flags, 2)) return null;
  return { traceId, parentId, flags };
}

function randomHex(bytes: number): string {
  for (;;) {
    const value = randomBytes(bytes).toString('hex');
    if (!allZero(value)) return value;
  }
}

/** 收到的 traceparent → 本次的 trace 上下文（无效或缺失时新开）。 */
export function startTrace(header: unknown): TraceContext {
  const incoming = parseTraceparent(header);
  return incoming
    ? {
        traceId: incoming.traceId,
        parentId: incoming.parentId,
        spanId: randomHex(8),
        flags: incoming.flags,
        restarted: false,
      }
    : {
        traceId: randomHex(16),
        parentId: null,
        spanId: randomHex(8),
        flags: '00',
        restarted: true,
      };
}

/** 发往下游（OpenRouter）的 traceparent：同一 trace id，每次调用一个新的 span。 */
export function childTraceparent(trace: TraceContext): string {
  return `00-${trace.traceId}-${randomHex(8)}-${trace.flags}`;
}
