/// Wormhole Privacy Score
///
/// Estimates the anonymity set size for a wormhole output based on the
/// current deposit pool statistics. The score is log2 of the estimated
/// number of deposit subsets that could have produced the observed output.
///
/// Algorithm:
///   1. Compute the pre-fee input range from the output amount and dist
///   2. For each subset size k in [kMin, kMax]:
///      - Use CLT to estimate P(sum of k random deposits falls in the input range)
///      - Multiply by C(D, k) to get estimated valid subsets of size k
///   3. Sum across all k values and take log2
library privacy_score;

import 'dart:math';

/// Aggregate statistics of the wormhole deposit pool.
///
/// Maintained incrementally as deposits arrive and accounts are removed.
/// Only three values are needed for the privacy score computation.
class DepositPoolStats {
  int totalDeposits;
  BigInt sumAmounts;
  BigInt sumAmountsSquared;

  DepositPoolStats({
    this.totalDeposits = 0,
    BigInt? sumAmounts,
    BigInt? sumAmountsSquared,
  }) : sumAmounts = sumAmounts ?? BigInt.zero,
       sumAmountsSquared = sumAmountsSquared ?? BigInt.zero;

  /// Add a deposit to the pool.
  void addDeposit(BigInt amount) {
    totalDeposits += 1;
    sumAmounts += amount;
    sumAmountsSquared += amount * amount;
  }

  /// Remove a deposit from the pool (e.g., account made a non-wormhole outgoing tx).
  void removeDeposit(BigInt amount) {
    totalDeposits = max(0, totalDeposits - 1);
    sumAmounts -= amount;
    sumAmountsSquared -= amount * amount;
    if (sumAmounts < BigInt.zero) sumAmounts = BigInt.zero;
    if (sumAmountsSquared < BigInt.zero) sumAmountsSquared = BigInt.zero;
  }

  /// Compute the mean deposit amount.
  double get mean {
    if (totalDeposits == 0) return 0;
    return sumAmounts.toDouble() / totalDeposits;
  }

  /// Compute the standard deviation of deposit amounts.
  double get stddev {
    if (totalDeposits < 2) return 0;
    final n = totalDeposits;
    final m = sumAmounts.toDouble() / n;
    // variance = E[X^2] - E[X]^2
    final meanSq = sumAmountsSquared.toDouble() / n;
    final variance = meanSq - m * m;
    return sqrt(max(0, variance));
  }

  /// Create from JSON (for API responses).
  factory DepositPoolStats.fromJson(Map<String, dynamic> json) {
    return DepositPoolStats(
      totalDeposits: json['totalDeposits'] as int,
      sumAmounts: BigInt.parse(json['sumAmounts'].toString()),
      sumAmountsSquared: BigInt.parse(json['sumAmountsSquared'].toString()),
    );
  }

  /// Convert to JSON.
  Map<String, dynamic> toJson() => {
    'totalDeposits': totalDeposits,
    'sumAmounts': sumAmounts.toString(),
    'sumAmountsSquared': sumAmountsSquared.toString(),
  };
}

/// Result of a privacy score computation at a specific dist value.
class PrivacyScoreResult {
  final int dist;
  final double scoreBits;
  final String label;

  PrivacyScoreResult({
    required this.dist,
    required this.scoreBits,
    required this.label,
  });
}

/// Standard normal CDF approximation (Abramowitz & Stegun 26.2.17).
/// Accurate to ~1.5e-7.
double normalCdf(double z) {
  if (z < -8) return 0;
  if (z > 8) return 1;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  final sign = z < 0 ? -1.0 : 1.0;
  final x = z.abs() / sqrt2;
  final t = 1.0 / (1.0 + p * x);
  final y =
      1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

/// Compute log2(C(n, k)) iteratively.
/// Returns 0 if k > n or k < 0.
double log2Binomial(int n, int k) {
  if (k < 0 || k > n) return 0;
  if (k == 0 || k == n) return 0;

  final kk = min(k, n - k);
  double result = 0;
  for (int i = 0; i < kk; i++) {
    result += log2(n - i) - log2(i + 1);
  }
  return result;
}

double log2(num x) => log(x) / ln2;

/// Compute the privacy score for a wormhole output.
///
/// [outputAmount] - The quantized output amount observed on-chain
/// [dist] - Amount reduction (sacrifice) for privacy
/// [pool] - Current deposit pool statistics
/// [feeBps] - Volume fee in basis points (e.g., 10 = 0.1%)
/// [kMin] - Minimum subset size (typically ceil(numOutputs / 2))
/// [kMax] - Maximum subset size (batch size, e.g., 16)
///
/// Returns privacy score in bits (log2 of estimated anonymity set size).
double privacyScore(
  double outputAmount,
  double dist,
  DepositPoolStats pool,
  int feeBps,
  int kMin,
  int kMax,
) {
  final d = pool.totalDeposits;
  if (d == 0) return 0;

  final mu = pool.mean;
  final sigma = pool.stddev;
  if (sigma == 0) return 0;

  // Pre-fee input range
  final feeMultiplier = 10000 / (10000 - feeBps);
  final inputLo = outputAmount * feeMultiplier;
  final inputHi = (outputAmount + dist) * feeMultiplier;

  final effectiveKMax = min(kMax, d);
  if (kMin > effectiveKMax) return 0;

  // Sum valid subsets across all k using log-sum-exp
  double maxLogTerm = double.negativeInfinity;
  final logTerms = <double>[];

  for (int k = kMin; k <= effectiveKMax; k++) {
    final sumMean = k * mu;
    final sumStd = sigma * sqrt(k.toDouble());

    final zLo = (inputLo - sumMean) / sumStd;
    final zHi = (inputHi - sumMean) / sumStd;
    final pK = normalCdf(zHi) - normalCdf(zLo);

    if (pK <= 0) continue;

    final logBinom = log2Binomial(d, k);
    final logP = log2(pK);
    final logTerm = logBinom + logP;

    logTerms.add(logTerm);
    if (logTerm > maxLogTerm) maxLogTerm = logTerm;
  }

  if (logTerms.isEmpty) return 0;

  // log-sum-exp in base 2
  double sumExp = 0;
  for (final lt in logTerms) {
    sumExp += pow(2, lt - maxLogTerm) as double;
  }

  return maxLogTerm + log2(sumExp);
}

/// Compute privacy scores at multiple dist levels for display.
List<PrivacyScoreResult> privacyScoreTable(
  double outputAmount,
  DepositPoolStats pool,
  int feeBps,
  int kMin,
  int kMax, {
  List<double> distFractions = const [0, 0.001, 0.01, 0.05],
}) {
  return distFractions.map((frac) {
    final d = (outputAmount * frac).floor();
    final bits = privacyScore(
      outputAmount,
      d.toDouble(),
      pool,
      feeBps,
      kMin,
      kMax,
    );
    return PrivacyScoreResult(
      dist: d,
      scoreBits: (bits * 10).round() / 10,
      label: scoreLabel(bits),
    );
  }).toList();
}

/// Find the minimum dist needed to achieve a target privacy score.
/// Returns null if unreachable within maxDistFraction.
int? findMinDist(
  double outputAmount,
  DepositPoolStats pool,
  int feeBps,
  int kMin,
  int kMax,
  double targetBits, {
  double maxDistFraction = 0.1,
}) {
  final maxDist = (outputAmount * maxDistFraction).floor();

  if (privacyScore(outputAmount, maxDist.toDouble(), pool, feeBps, kMin, kMax) <
      targetBits) {
    return null;
  }

  if (privacyScore(outputAmount, 0, pool, feeBps, kMin, kMax) >= targetBits) {
    return 0;
  }

  int lo = 0;
  int hi = maxDist;
  while (hi - lo > 1) {
    final mid = (lo + hi) ~/ 2;
    if (privacyScore(outputAmount, mid.toDouble(), pool, feeBps, kMin, kMax) >=
        targetBits) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return hi;
}

/// Human-readable label for a privacy score.
String scoreLabel(double bits) {
  if (bits < 10) return 'Critical';
  if (bits < 20) return 'Weak';
  if (bits < 40) return 'Moderate';
  if (bits < 60) return 'Strong';
  return 'Very Strong';
}
