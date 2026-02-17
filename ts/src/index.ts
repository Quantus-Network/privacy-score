/**
 * Wormhole Privacy Score
 *
 * Estimates the anonymity set size for a wormhole output based on the
 * current deposit pool statistics. The score is log2 of the estimated
 * number of deposit subsets that could have produced the observed output.
 *
 * Algorithm:
 *   1. Compute the pre-fee input range [input_lo, input_hi] from the output amount and dist
 *   2. For each subset size k in [k_min, k_max]:
 *      - Use CLT to estimate P(sum of k random deposits falls in the input range)
 *      - Multiply by C(D, k) to get estimated valid subsets of size k
 *   3. Sum across all k values and take log2
 */

/**
 * Aggregate statistics of the wormhole deposit pool.
 *
 * Maintained incrementally as deposits arrive and accounts are removed.
 * Only three values are needed for the privacy score computation.
 */
export interface DepositPoolStats {
  /** Total number of unconsumed wormhole deposits */
  totalDeposits: number;
  /** Sum of all deposit amounts (quantized) */
  sumAmounts: bigint;
  /** Sum of squared deposit amounts (for variance computation) */
  sumAmountsSquared: bigint;
}

/**
 * Result of a privacy score computation at a specific dist value.
 */
export interface PrivacyScoreResult {
  /** The amount reduction (sacrifice) for privacy */
  dist: number;
  /** Privacy score in bits (log2 of anonymity set size) */
  scoreBits: number;
  /** Human-readable label */
  label: string;
}

/**
 * Create an empty deposit pool.
 */
export function createPool(): DepositPoolStats {
  return {
    totalDeposits: 0,
    sumAmounts: 0n,
    sumAmountsSquared: 0n,
  };
}

/**
 * Add a deposit to the pool stats.
 */
export function addDeposit(pool: DepositPoolStats, amount: bigint): void {
  pool.totalDeposits += 1;
  pool.sumAmounts += amount;
  pool.sumAmountsSquared += amount * amount;
}

/**
 * Remove a deposit from the pool stats (e.g., account made a non-wormhole outgoing tx).
 */
export function removeDeposit(pool: DepositPoolStats, amount: bigint): void {
  pool.totalDeposits = Math.max(0, pool.totalDeposits - 1);
  pool.sumAmounts -= amount;
  pool.sumAmountsSquared -= amount * amount;
  // Clamp to zero in case of floating point drift
  if (pool.sumAmounts < 0n) pool.sumAmounts = 0n;
  if (pool.sumAmountsSquared < 0n) pool.sumAmountsSquared = 0n;
}

/**
 * Compute the mean deposit amount.
 */
export function poolMean(pool: DepositPoolStats): number {
  if (pool.totalDeposits === 0) return 0;
  return Number(pool.sumAmounts) / pool.totalDeposits;
}

/**
 * Compute the standard deviation of deposit amounts.
 */
export function poolStddev(pool: DepositPoolStats): number {
  if (pool.totalDeposits < 2) return 0;
  const n = pool.totalDeposits;
  const mean = Number(pool.sumAmounts) / n;
  // variance = E[X^2] - E[X]^2
  const meanSq = Number(pool.sumAmountsSquared) / n;
  const variance = meanSq - mean * mean;
  return Math.sqrt(Math.max(0, variance));
}

/**
 * Standard normal CDF approximation (Abramowitz & Stegun 26.2.17).
 * Accurate to ~1.5e-7.
 */
export function normalCdf(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Compute log2(C(n, k)) using log-gamma (Stirling approximation for large n).
 * Returns 0 if k > n or k < 0.
 */
export function log2Binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 0;

  // Use log-gamma: log(C(n,k)) = lgamma(n+1) - lgamma(k+1) - lgamma(n-k+1)
  let result = 0;
  // Use the smaller of k and n-k for efficiency
  const kk = Math.min(k, n - k);
  for (let i = 0; i < kk; i++) {
    result += Math.log2(n - i) - Math.log2(i + 1);
  }
  return result;
}

/**
 * Compute the privacy score for a wormhole output.
 *
 * @param outputAmount - The quantized output amount observed on-chain
 * @param dist - Amount reduction (sacrifice) for privacy. The actual input could be
 *               anywhere in [outputAmount + fee, outputAmount + fee + dist].
 * @param pool - Current deposit pool statistics
 * @param feeBps - Volume fee in basis points (e.g., 10 = 0.1%)
 * @param kMin - Minimum subset size (typically ceil(numOutputs / 2))
 * @param kMax - Maximum subset size (batch size, e.g., 16)
 * @returns Privacy score in bits (log2 of estimated anonymity set size)
 */
export function privacyScore(
  outputAmount: number,
  dist: number,
  pool: DepositPoolStats,
  feeBps: number,
  kMin: number,
  kMax: number
): number {
  const D = pool.totalDeposits;
  if (D === 0) return 0;

  const mu = poolMean(pool);
  const sigma = poolStddev(pool);
  if (sigma === 0) return 0;

  // Pre-fee input range: output / (1 - fee) to (output + dist) / (1 - fee)
  const feeMultiplier = 10000 / (10000 - feeBps);
  const inputLo = outputAmount * feeMultiplier;
  const inputHi = (outputAmount + dist) * feeMultiplier;

  const effectiveKMax = Math.min(kMax, D);
  if (kMin > effectiveKMax) return 0;

  // Sum valid subsets across all k values.
  // For each k, estimate: C(D, k) * P(sum of k deposits in [inputLo, inputHi])
  // We work in log2 space to avoid overflow, then use log-sum-exp to combine.
  let maxLogTerm = -Infinity;
  const logTerms: number[] = [];

  for (let k = kMin; k <= effectiveKMax; k++) {
    // CLT: sum of k deposits ~ Normal(k*mu, k*sigma^2)
    const sumMean = k * mu;
    const sumStd = sigma * Math.sqrt(k);

    const zLo = (inputLo - sumMean) / sumStd;
    const zHi = (inputHi - sumMean) / sumStd;
    const pK = normalCdf(zHi) - normalCdf(zLo);

    if (pK <= 0) continue;

    // log2(C(D,k) * pK) = log2(C(D,k)) + log2(pK)
    const logBinom = log2Binomial(D, k);
    const logP = Math.log2(pK);
    const logTerm = logBinom + logP;

    logTerms.push(logTerm);
    if (logTerm > maxLogTerm) maxLogTerm = logTerm;
  }

  if (logTerms.length === 0) return 0;

  // log-sum-exp in base 2: log2(sum(2^logTerms))
  // = maxLogTerm + log2(sum(2^(logTerms - maxLogTerm)))
  let sumExp = 0;
  for (const lt of logTerms) {
    sumExp += Math.pow(2, lt - maxLogTerm);
  }

  return maxLogTerm + Math.log2(sumExp);
}

/**
 * Compute privacy scores at multiple dist levels for display.
 *
 * @param outputAmount - The quantized output amount
 * @param pool - Current deposit pool statistics
 * @param feeBps - Volume fee in basis points
 * @param kMin - Minimum subset size
 * @param kMax - Maximum subset size (batch size)
 * @param distFractions - Fractions of outputAmount to use as dist values (default: [0, 0.001, 0.01, 0.05])
 * @returns Array of privacy score results at each dist level
 */
export function privacyScoreTable(
  outputAmount: number,
  pool: DepositPoolStats,
  feeBps: number,
  kMin: number,
  kMax: number,
  distFractions: number[] = [0, 0.001, 0.01, 0.05]
): PrivacyScoreResult[] {
  return distFractions.map((frac) => {
    const dist = Math.floor(outputAmount * frac);
    const bits = privacyScore(outputAmount, dist, pool, feeBps, kMin, kMax);
    return {
      dist,
      scoreBits: Math.round(bits * 10) / 10,
      label: scoreLabel(bits),
    };
  });
}

/**
 * Find the minimum dist (amount sacrifice) needed to achieve a target privacy score.
 *
 * Uses binary search over dist values.
 *
 * @param outputAmount - The quantized output amount
 * @param pool - Current deposit pool statistics
 * @param feeBps - Volume fee in basis points
 * @param kMin - Minimum subset size
 * @param kMax - Maximum subset size
 * @param targetBits - Target privacy score in bits (e.g., 40)
 * @param maxDistFraction - Maximum fraction of output to sacrifice (default: 0.1 = 10%)
 * @returns The minimum dist value, or null if target is unreachable
 */
export function findMinDist(
  outputAmount: number,
  pool: DepositPoolStats,
  feeBps: number,
  kMin: number,
  kMax: number,
  targetBits: number,
  maxDistFraction: number = 0.1
): number | null {
  const maxDist = Math.floor(outputAmount * maxDistFraction);

  // Check if target is achievable at max dist
  if (privacyScore(outputAmount, maxDist, pool, feeBps, kMin, kMax) < targetBits) {
    return null;
  }

  // Check if already achieved at dist=0
  if (privacyScore(outputAmount, 0, pool, feeBps, kMin, kMax) >= targetBits) {
    return 0;
  }

  // Binary search
  let lo = 0;
  let hi = maxDist;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (privacyScore(outputAmount, mid, pool, feeBps, kMin, kMax) >= targetBits) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return hi;
}

/**
 * Human-readable label for a privacy score.
 */
export function scoreLabel(bits: number): string {
  if (bits < 10) return "Critical";
  if (bits < 20) return "Weak";
  if (bits < 40) return "Moderate";
  if (bits < 60) return "Strong";
  return "Very Strong";
}
