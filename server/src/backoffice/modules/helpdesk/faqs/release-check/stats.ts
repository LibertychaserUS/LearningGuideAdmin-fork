/**
 * 判定用的统计（release check v2）。错卡率按 95% 置信区间的上界判（Wilson 区间，小样本与比例接近 0 时
 * 比正态近似可靠；Brown, Cai & DasGupta 2001 推荐）：1,700 道题里错 5 道，点估计 0.29%，上界 0.69%。
 */
export const Z95 = 1.959964;

export function wilson(
  k: number,
  n: number,
  z = Z95,
): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denominator = 1 + z2 / n;
  return {
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator),
  };
}

/** 比例（分母为 0 → 0），保留 4 位小数。 */
export function rate(k: number, n: number): number {
  return n > 0 ? Number((k / n).toFixed(4)) : 0;
}
