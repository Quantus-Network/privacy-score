import {
  createPool,
  addDeposit,
  removeDeposit,
  poolMean,
  poolStddev,
  normalCdf,
  log2Binomial,
  privacyScore,
  privacyScoreTable,
  findMinDist,
  scoreLabel,
} from "../src";

describe("DepositPoolStats", () => {
  test("empty pool", () => {
    const pool = createPool();
    expect(pool.totalDeposits).toBe(0);
    expect(poolMean(pool)).toBe(0);
    expect(poolStddev(pool)).toBe(0);
  });

  test("add and remove deposits", () => {
    const pool = createPool();
    addDeposit(pool, 100n);
    addDeposit(pool, 200n);
    addDeposit(pool, 300n);

    expect(pool.totalDeposits).toBe(3);
    expect(poolMean(pool)).toBe(200);

    removeDeposit(pool, 300n);
    expect(pool.totalDeposits).toBe(2);
    expect(poolMean(pool)).toBe(150);
  });

  test("stddev computation", () => {
    const pool = createPool();
    // Add deposits with known stddev
    for (const amt of [10n, 20n, 30n, 40n, 50n]) {
      addDeposit(pool, amt);
    }
    // mean = 30, variance = ((10-30)^2 + (20-30)^2 + ... + (50-30)^2) / 5 = 200
    // stddev = sqrt(200) ≈ 14.14
    expect(poolMean(pool)).toBeCloseTo(30, 5);
    expect(poolStddev(pool)).toBeCloseTo(Math.sqrt(200), 1);
  });
});

describe("normalCdf", () => {
  test("standard values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 5);
    expect(normalCdf(-8)).toBeCloseTo(0, 10);
    expect(normalCdf(8)).toBeCloseTo(1, 10);
  });

  test("known quantiles", () => {
    // P(Z < 1.96) ≈ 0.975
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 2);
    // P(Z < -1.96) ≈ 0.025
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 2);
    // P(Z < 1) ≈ 0.8413
    expect(normalCdf(1.0)).toBeCloseTo(0.8413, 3);
  });
});

describe("log2Binomial", () => {
  test("edge cases", () => {
    expect(log2Binomial(10, 0)).toBe(0); // C(10,0) = 1
    expect(log2Binomial(10, 10)).toBe(0); // C(10,10) = 1
    expect(log2Binomial(5, 6)).toBe(0); // k > n
  });

  test("known values", () => {
    // C(10, 3) = 120, log2(120) ≈ 6.907
    expect(log2Binomial(10, 3)).toBeCloseTo(Math.log2(120), 5);
    // C(20, 5) = 15504, log2(15504) ≈ 13.92
    expect(log2Binomial(20, 5)).toBeCloseTo(Math.log2(15504), 5);
    // C(100, 2) = 4950
    expect(log2Binomial(100, 2)).toBeCloseTo(Math.log2(4950), 5);
  });

  test("large values", () => {
    // C(1000, 16) is enormous, but log2 should be computable
    const result = log2Binomial(1000, 16);
    expect(result).toBeGreaterThan(100); // ~115 bits
    expect(result).toBeLessThan(200);
    expect(isFinite(result)).toBe(true);
  });
});

describe("privacyScore", () => {
  function makePool(deposits: bigint[]) {
    const pool = createPool();
    for (const d of deposits) addDeposit(pool, d);
    return pool;
  }

  test("empty pool returns 0", () => {
    const pool = createPool();
    expect(privacyScore(100, 0, pool, 10, 1, 16)).toBe(0);
  });

  test("small output with dist has high score", () => {
    // 1000 deposits averaging ~500, output = 10 with large dist
    // With dist = 1000, input range spans most of the deposit pool
    const pool = createPool();
    for (let i = 0; i < 1000; i++) {
      addDeposit(pool, BigInt(100 + (i % 900)));
    }
    const score = privacyScore(10, 1000, pool, 10, 1, 16);
    expect(score).toBeGreaterThan(5);
  });

  test("large output with small deposits has low score", () => {
    // 100 deposits of ~10 each, output = 10000
    const pool = createPool();
    for (let i = 0; i < 100; i++) {
      addDeposit(pool, BigInt(5 + (i % 10)));
    }
    // Output of 10000 requires sum of k deposits ~ 10000, but k*mean ~ k*10
    // Even k=16 only gives 160, far below 10000
    const score = privacyScore(10000, 0, pool, 10, 1, 16);
    expect(score).toBeLessThan(5);
  });

  test("increasing dist increases score", () => {
    const pool = makePool(
      Array.from({ length: 500 }, (_, i) => BigInt(100 + i * 2))
    );
    const score0 = privacyScore(500, 0, pool, 10, 1, 16);
    const score1 = privacyScore(500, 50, pool, 10, 1, 16);
    const score2 = privacyScore(500, 200, pool, 10, 1, 16);
    expect(score1).toBeGreaterThanOrEqual(score0);
    expect(score2).toBeGreaterThanOrEqual(score1);
  });

  test("larger pool gives higher score", () => {
    const small = makePool(Array.from({ length: 50 }, (_, i) => BigInt(400 + i * 4)));
    const large = makePool(Array.from({ length: 5000 }, (_, i) => BigInt(400 + (i % 200) * 4)));
    const scoreSmall = privacyScore(400, 10, small, 10, 1, 16);
    const scoreLarge = privacyScore(400, 10, large, 10, 1, 16);
    expect(scoreLarge).toBeGreaterThan(scoreSmall);
  });
});

describe("privacyScoreTable", () => {
  test("returns results for each dist fraction", () => {
    const pool = createPool();
    for (let i = 0; i < 200; i++) addDeposit(pool, BigInt(100 + i));
    const table = privacyScoreTable(150, pool, 10, 1, 16);
    expect(table.length).toBe(4); // default 4 fractions
    expect(table[0].dist).toBe(0); // 0% sacrifice
    expect(table[0].label).toBeDefined();
    // Scores should be non-decreasing
    for (let i = 1; i < table.length; i++) {
      expect(table[i].scoreBits).toBeGreaterThanOrEqual(table[i - 1].scoreBits);
    }
  });
});

describe("findMinDist", () => {
  test("returns 0 if already achieved", () => {
    const pool = createPool();
    for (let i = 0; i < 10000; i++) addDeposit(pool, BigInt(100 + (i % 500)));
    // Very low target should be achievable at dist=0
    const score0 = privacyScore(50, 0, pool, 10, 1, 16);
    // Only test if dist=0 achieves the target
    if (score0 >= 5) {
      const dist = findMinDist(50, pool, 10, 1, 16, 5);
      expect(dist).toBe(0);
    }
  });

  test("returns null if unreachable", () => {
    const pool = createPool();
    addDeposit(pool, 100n);
    // With only 1 deposit, can't achieve 100 bits
    const dist = findMinDist(50, pool, 10, 1, 16, 100);
    expect(dist).toBeNull();
  });
});

describe("scoreLabel", () => {
  test("label thresholds", () => {
    expect(scoreLabel(5)).toBe("Critical");
    expect(scoreLabel(15)).toBe("Weak");
    expect(scoreLabel(30)).toBe("Moderate");
    expect(scoreLabel(50)).toBe("Strong");
    expect(scoreLabel(70)).toBe("Very Strong");
  });
});
