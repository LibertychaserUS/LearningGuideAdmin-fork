/**
 * Canonical JSON（设计 §14 C6 / PLN-1）。
 *
 * Plan 原文以 canonical JSON bytes 存档，比较用字节相等，不使用任何摘要。
 * 规则（RFC 8785 的确定性序列化子集）：
 * - 对象键按 UTF-16 码元排序；无空白；数组保持顺序；
 * - 数字与字符串按 ECMAScript JSON 序列化；非有限数直接拒绝；
 * - undefined 属性跳过（等价于不存在）；null 保留。
 *
 * 本模块自包含，不依赖任何旧内容模块 —— Plan 字节是 Part C 的独立契约面。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonicalJson: non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
}
