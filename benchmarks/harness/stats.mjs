/**
 * stats.mjs — Statistical helpers for benchmark #31.
 *
 * Implements a paired t-test and summary statistics used to determine whether
 * MCP-on mean score ≥ MCP-off mean score + 0.3 at p < 0.05.
 *
 * The paired t-test is the one specified in DESIGN.md §2 acceptance criteria:
 *   - Null hypothesis H₀: mean(MCP_on - MCP_off) = 0.
 *   - Test statistic: t = mean(d) / (sd(d) / sqrt(n)).
 *   - Two-tailed p-value approximated via the t-distribution CDF.
 *
 * Note: The p-value approximation uses a miniature regularised incomplete beta
 * function that is accurate to ~1e-6 for df ≥ 2. It does not require any
 * native dependencies.
 */

/**
 * Compute the sample mean.
 *
 * @param {number[]} xs
 * @returns {number}
 */
export function mean(xs) {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * Compute the sample standard deviation (Bessel-corrected, n-1).
 *
 * @param {number[]} xs
 * @returns {number}
 */
export function stdDev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/**
 * Count occurrences of each key in an array.
 *
 * @template {string | number} K
 * @param {K[]} xs
 * @param {K[]} keys
 * @returns {Record<K, number>}
 */
export function countByKey(xs, keys) {
  /** @type {Record<K, number>} */
  const result = /** @type {any} */ ({});
  for (const k of keys) result[k] = 0;
  for (const x of xs)
    if (Object.prototype.hasOwnProperty.call(result, x)) result[x]++;
  return result;
}

/**
 * Regularised incomplete beta function I_x(a, b).
 *
 * Used to compute the t-distribution CDF. Implemented via continued fraction
 * (Lentz's algorithm) as described in Numerical Recipes §6.4. Accurate to
 * ~1e-6 for df ≥ 2 and |t| ≤ 10.
 *
 * @param {number} x
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function incompleteBeta(x, a, b) {
  if (x < 0 || x > 1) return NaN;
  if (x === 0) return 0;
  if (x === 1) return 1;

  // Use symmetry relation to ensure x <= (a+1)/(a+b+2) for convergence.
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - incompleteBeta(1 - x, b, a);
  }

  const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta) / a;

  // Continued fraction via modified Lentz algorithm (max 200 iterations).
  let C = 1;
  let D = 1 - ((a + b) * x) / (a + 1);
  D = D === 0 ? 1e-30 : D;
  D = 1 / D;
  // f starts as 1/D after the first Lentz normalisation step.
  let f = D;

  for (let m = 1; m <= 100; m++) {
    // Even step
    let numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    D = 1 + numerator * D;
    C = 1 + numerator / C;
    D = D === 0 ? 1e-30 : D;
    C = C === 0 ? 1e-30 : C;
    D = 1 / D;
    f *= D * C;

    // Odd step
    numerator = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    D = 1 + numerator * D;
    C = 1 + numerator / C;
    D = D === 0 ? 1e-30 : D;
    C = C === 0 ? 1e-30 : C;
    D = 1 / D;
    const delta = D * C;
    f *= delta;

    if (Math.abs(delta - 1) < 1e-10) break;
  }

  return front * f;
}

/**
 * Log-gamma function (Lanczos approximation).
 *
 * @param {number} z
 * @returns {number}
 */
function logGamma(z) {
  const g = 7;
  const p = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return (
      Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z)
    );
  }
  z -= 1;
  let x = p[0];
  for (let i = 1; i < g + 2; i++) x += p[i] / (z + i);
  const t = z + g + 0.5;
  return (
    0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
  );
}

/**
 * CDF of the Student's t-distribution with `df` degrees of freedom.
 *
 * @param {number} t
 * @param {number} df
 * @returns {number} P(T ≤ t)
 */
export function tDistCDF(t, df) {
  const x = df / (df + t * t);
  const ib = incompleteBeta(x, df / 2, 0.5);
  // P(T ≤ t) = 1 - 0.5 * I_x(df/2, 0.5) for t > 0; mirror for t < 0.
  return t >= 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

/**
 * Compute a two-tailed p-value for the paired t-test.
 *
 * @param {number[]} mcpOnScores - Per-task scores with MCP enabled.
 * @param {number[]} mcpOffScores - Per-task scores with MCP disabled.
 *   Must be the same length and same task order as mcpOnScores.
 * @returns {import('./types.d.ts').PairedTTestResult | null}
 *   null when there are fewer than 2 paired observations.
 */
export function pairedTTest(mcpOnScores, mcpOffScores) {
  if (mcpOnScores.length !== mcpOffScores.length) {
    throw new Error("mcpOnScores and mcpOffScores must have the same length");
  }
  const n = mcpOnScores.length;
  if (n < 2) return null;

  const diffs = mcpOnScores.map((s, i) => s - mcpOffScores[i]);
  const dBar = mean(diffs);
  const sd = stdDev(diffs);

  if (sd === 0) {
    if (dBar === 0) {
      // All differences are 0: t = 0, p = 1.
      return { tStat: 0, pValue: 1, degreesOfFreedom: n - 1, n };
    }
    // Non-zero constant difference, zero variance: t → ±∞, p → 0.
    // Return a large finite t and p = 0 (practically indistinguishable from ∞).
    const tStat = dBar > 0 ? Infinity : -Infinity;
    return { tStat, pValue: 0, degreesOfFreedom: n - 1, n };
  }

  const tStat = dBar / (sd / Math.sqrt(n));
  const df = n - 1;
  // Two-tailed p-value: 2 * P(T > |t|) = 2 * (1 - CDF(|t|))
  const pValue = 2 * (1 - tDistCDF(Math.abs(tStat), df));

  return { tStat, pValue, degreesOfFreedom: df, n };
}

/**
 * Compute per-condition aggregate stats.
 *
 * @param {import('./types.d.ts').TaskResult[]} results - All task results for one condition.
 * @param {boolean} mcpEnabled - Which condition these results belong to.
 * @returns {import('./types.d.ts').ConditionStats}
 */
export function computeConditionStats(results, mcpEnabled) {
  const scores = results.map((r) => r.effectiveScore);
  const passCount = scores.filter((s) => s === 2).length;
  const dist = countByKey(scores, [0, 1, 2]);

  return {
    mcpEnabled,
    taskCount: results.length,
    meanScore: mean(scores),
    stdDev: stdDev(scores),
    passCount,
    passRate: results.length > 0 ? passCount / results.length : 0,
    scoreDistribution: { 0: dist[0] ?? 0, 1: dist[1] ?? 0, 2: dist[2] ?? 0 },
  };
}
