# privacy-score

Privacy score estimation for Quantus Network wormhole transactions.

Given a wormhole output amount and the current deposit pool statistics, estimates how many possible deposit combinations could have produced that output. A higher score means more privacy -- the output is harder to link back to specific deposits.

## Algorithm

The privacy score uses the Central Limit Theorem to efficiently approximate the subset-sum anonymity set:

1. **Pre-fee input range**: Given output amount `X` and sacrifice `dist`, the actual input(s) must have totaled between `(X) / (1 - fee)` and `(X + dist) / (1 - fee)`.

2. **For each possible subset size** `k` from `k_min` to `k_max` (batch size):
   - Model the sum of `k` random deposits as a normal distribution with mean `k * μ` and std dev `σ * √k`
   - Estimate `P(sum in input range)` using the normal CDF
   - Multiply by `C(D, k)` (number of ways to choose k deposits from D total)

3. **Sum across all k** and take `log2` for the score in bits.

### Why This Works

- **Small outputs** relative to the pool get high scores -- almost any single deposit is valid
- **Large outputs** with no matching deposit combinations get low scores -- correctly identifying weak privacy
- **Increasing `dist`** (sacrificing amount precision) widens the valid input range, increasing the score
- **Larger pools** mean more potential subsets at every k, improving everyone's privacy

### Key Parameters

| Parameter | Description |
|-----------|-------------|
| `outputAmount` | Quantized output amount observed on-chain |
| `dist` | Amount sacrificed for privacy (output could have been `dist` higher) |
| `pool.totalDeposits` | Total unconsumed wormhole deposits |
| `pool.sumAmounts` | Sum of all deposit amounts (for computing mean) |
| `pool.sumAmountsSquared` | Sum of squared amounts (for computing variance) |
| `feeBps` | Volume fee in basis points (currently 10 = 0.1%) |
| `kMin` | Minimum subset size, typically `ceil(numOutputsInBatch / 2)` |
| `kMax` | Maximum subset size = batch size (e.g., 16) |

### Score Labels

| Score | Label | Interpretation |
|-------|-------|----------------|
| < 10 bits | Critical | Likely linkable |
| 10-20 bits | Weak | Significantly narrowed |
| 20-40 bits | Moderate | Reasonable anonymity |
| 40-60 bits | Strong | Very hard to link |
| 60+ bits | Very Strong | Computationally infeasible |

## Implementations

- **TypeScript** (`ts/`) -- for Subsquid indexer and block explorer
- **Dart** (`dart/`) -- for the Quantus mobile wallet

Both implementations use the same algorithm and are validated against shared test vectors in `test_vectors.json`.

## Usage

### TypeScript

```typescript
import { createPool, addDeposit, privacyScore, privacyScoreTable } from '@quantus/privacy-score';

const pool = createPool();
addDeposit(pool, 1000n);
addDeposit(pool, 2000n);
// ... add all deposits

// Single score
const bits = privacyScore(500, 10, pool, 10, 1, 16);

// Score table at multiple sacrifice levels
const table = privacyScoreTable(500, pool, 10, 1, 16);
```

### Dart

```dart
import 'package:privacy_score/privacy_score.dart';

final pool = DepositPoolStats();
pool.addDeposit(BigInt.from(1000));
pool.addDeposit(BigInt.from(2000));

// Single score
final bits = privacyScore(500, 10, pool, 10, 1, 16);

// Score table
final table = privacyScoreTable(500, pool, 10, 1, 16);
```

## Running Tests

```bash
# All tests
./run_tests.sh

# Individual
cd ts && npm test
cd dart && dart test
```

## Deposit Pool Maintenance

The Subsquid indexer maintains `DepositPoolStats` incrementally:

- **On wormhole deposit** (transfer to an unspendable account): `addDeposit(amount)`
- **On non-wormhole outgoing tx** from a deposit-only account: `removeDeposit(amount)` for each of that account's deposits

Note: consumed deposits (via nullifiers in aggregated proofs) cannot be directly removed from the pool because nullifiers are unlinkable to specific deposits. This is by design -- the pool is a *superset* of actual unconsumed deposits, which is a conservative (privacy-overstating) approximation.
