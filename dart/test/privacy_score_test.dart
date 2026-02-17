import 'dart:math';

import 'package:test/test.dart';
import 'package:privacy_score/privacy_score.dart';

void main() {
  group('DepositPoolStats', () {
    test('empty pool', () {
      final pool = DepositPoolStats();
      expect(pool.totalDeposits, 0);
      expect(pool.mean, 0);
      expect(pool.stddev, 0);
    });

    test('add and remove deposits', () {
      final pool = DepositPoolStats();
      pool.addDeposit(BigInt.from(100));
      pool.addDeposit(BigInt.from(200));
      pool.addDeposit(BigInt.from(300));

      expect(pool.totalDeposits, 3);
      expect(pool.mean, 200);

      pool.removeDeposit(BigInt.from(300));
      expect(pool.totalDeposits, 2);
      expect(pool.mean, 150);
    });

    test('stddev computation', () {
      final pool = DepositPoolStats();
      for (final amt in [10, 20, 30, 40, 50]) {
        pool.addDeposit(BigInt.from(amt));
      }
      expect(pool.mean, closeTo(30, 0.001));
      expect(pool.stddev, closeTo(sqrt(200), 0.1));
    });

    test('JSON roundtrip', () {
      final pool = DepositPoolStats();
      pool.addDeposit(BigInt.from(100));
      pool.addDeposit(BigInt.from(200));

      final json = pool.toJson();
      final restored = DepositPoolStats.fromJson(json);
      expect(restored.totalDeposits, pool.totalDeposits);
      expect(restored.sumAmounts, pool.sumAmounts);
      expect(restored.sumAmountsSquared, pool.sumAmountsSquared);
    });
  });

  group('normalCdf', () {
    test('standard values', () {
      expect(normalCdf(0), closeTo(0.5, 0.001));
      expect(normalCdf(-8), closeTo(0, 1e-10));
      expect(normalCdf(8), closeTo(1, 1e-10));
    });

    test('known quantiles', () {
      expect(normalCdf(1.96), closeTo(0.975, 0.01));
      expect(normalCdf(-1.96), closeTo(0.025, 0.01));
      expect(normalCdf(1.0), closeTo(0.8413, 0.001));
    });
  });

  group('log2Binomial', () {
    test('edge cases', () {
      expect(log2Binomial(10, 0), 0);
      expect(log2Binomial(10, 10), 0);
      expect(log2Binomial(5, 6), 0);
    });

    test('known values', () {
      // C(10, 3) = 120
      expect(log2Binomial(10, 3), closeTo(log(120) / ln2, 0.001));
      // C(20, 5) = 15504
      expect(log2Binomial(20, 5), closeTo(log(15504) / ln2, 0.001));
    });

    test('large values', () {
      final result = log2Binomial(1000, 16);
      expect(result, greaterThan(100));
      expect(result, lessThan(200));
      expect(result.isFinite, true);
    });
  });

  group('privacyScore', () {
    DepositPoolStats makePool(List<int> deposits) {
      final pool = DepositPoolStats();
      for (final d in deposits) {
        pool.addDeposit(BigInt.from(d));
      }
      return pool;
    }

    test('empty pool returns 0', () {
      final pool = DepositPoolStats();
      expect(privacyScore(100, 0, pool, 10, 1, 16), 0);
    });

    test('small output with dist has high score', () {
      final pool = DepositPoolStats();
      for (int i = 0; i < 1000; i++) {
        pool.addDeposit(BigInt.from(100 + (i % 900)));
      }
      final score = privacyScore(10, 1000, pool, 10, 1, 16);
      expect(score, greaterThan(5));
    });

    test('large output with small deposits has low score', () {
      final pool = DepositPoolStats();
      for (int i = 0; i < 100; i++) {
        pool.addDeposit(BigInt.from(5 + (i % 10)));
      }
      final score = privacyScore(10000, 0, pool, 10, 1, 16);
      expect(score, lessThan(5));
    });

    test('increasing dist increases score', () {
      final pool = makePool(List.generate(500, (i) => 100 + i * 2));
      final score0 = privacyScore(500, 0, pool, 10, 1, 16);
      final score1 = privacyScore(500, 50, pool, 10, 1, 16);
      final score2 = privacyScore(500, 200, pool, 10, 1, 16);
      expect(score1, greaterThanOrEqualTo(score0));
      expect(score2, greaterThanOrEqualTo(score1));
    });

    test('larger pool gives higher score', () {
      final small = makePool(List.generate(50, (i) => 400 + i * 4));
      final large = makePool(List.generate(5000, (i) => 400 + (i % 200) * 4));
      final scoreSmall = privacyScore(400, 10, small, 10, 1, 16);
      final scoreLarge = privacyScore(400, 10, large, 10, 1, 16);
      expect(scoreLarge, greaterThan(scoreSmall));
    });
  });

  group('privacyScoreTable', () {
    test('returns results for each dist fraction', () {
      final pool = DepositPoolStats();
      for (int i = 0; i < 200; i++) {
        pool.addDeposit(BigInt.from(100 + i));
      }
      final table = privacyScoreTable(150, pool, 10, 1, 16);
      expect(table.length, 4);
      expect(table[0].dist, 0);
      expect(table[0].label, isNotEmpty);
      // Scores should be non-decreasing
      for (int i = 1; i < table.length; i++) {
        expect(
          table[i].scoreBits,
          greaterThanOrEqualTo(table[i - 1].scoreBits),
        );
      }
    });
  });

  group('scoreLabel', () {
    test('label thresholds', () {
      expect(scoreLabel(5), 'Critical');
      expect(scoreLabel(15), 'Weak');
      expect(scoreLabel(30), 'Moderate');
      expect(scoreLabel(50), 'Strong');
      expect(scoreLabel(70), 'Very Strong');
    });
  });
}
