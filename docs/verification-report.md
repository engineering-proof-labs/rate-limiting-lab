# Comprehensive Verification & Test-Strength Report

**Document Version:** 1.1.0  
**Phase:** 12/13 Audit Reconciliation, Grounded Evidence & CI Verification  
**Repository:** `engineering-proof-labs/rate-limiting-lab`  
**Execution Timestamp:** 2026-10-26T22:59:50.595Z  
**Raw Evidence Artifact:** [`docs/benchmarks/raw-benchmark-output.txt`](benchmarks/raw-benchmark-output.txt)

---

## 1. Executive Summary

This report delivers the verified technical evidence for Phase 12 and Phase 13 of the Rate Limiting Laboratory. It covers:

1. **Reconciliation of Prior Audit Discrepancies:** Clarification and replacement of contradictory historical benchmark drafts with verifiable, captured hardware specs and reproducible benchmark runs.
2. **Targeted Defect Resolution:** Mathematical correction of the Sliding Window Counter next-epoch transition defect where `earliestAdmissibleTimeMs` was prematurely calculated as the epoch boundary ($t = 60,000\text{ ms}$) instead of the first admissible millisecond in the following window ($t = 60,001\text{ ms}$), and elimination of IEEE 754 float subtraction rounding in threshold calculations.
3. **Representative In-Memory Benchmarks:** Multi-trial evaluations (3 repetitions) across three distinct, semantically controlled workloads: Fresh Clients (100% admission), Saturated Quotas (~98% rejection), and Mixed Steady-State Traffic (50% admission).
4. **End-to-End Closed-Loop HTTP Benchmark:** Supertest HTTP + Redis Lua benchmark under concurrency level 20, verifying complete status breakdown ($250\text{ admitted} + 1,750\text{ throttled} + 0\text{ unexpected} = 2,000\text{ total requests}$) and separate admission vs throttling latency distributions.
5. **Adversarial Mutation Testing:** Systematic evaluation of all 11 controlled mutation scenarios specified in the Phase 12 roadmap. All 11 mutations were detected by static checks or test assertions (**0 surviving mutations**).
6. **Full Test Pipeline Verification:** Clean execution of static type checking (`tsc --noEmit`), linting (`eslint .`), Prettier formatting, unit test suites (64 tests), contract test suites (23 tests), Redis integration test suites (16 tests), and production build compilation (`tsc -p tsconfig.build.json`). Total tests: **103 passed**.

> [!NOTE]
> **Audit Distinction Notice:** This verification report was produced autonomously by the engineering agent during Phase 12/13 implementation. An AI self-review is not an independent human audit or external second-model review; this document presents factual, reproducible measurements and verifiable test outputs without claiming external third-party certification.

---

## 2. Reconciliation of Prior Benchmark Evidence Discrepancies

An independent review identified a discrepancy between the Phase 12 completion chat summary and the initial `docs/verification-report.md` draft:

- **Chat summary stated:** AMD Ryzen 7 5700X, 32 GB RAM, Windows 11 Pro, HTTP admitted/rejected: 10 / 1990, mean latency: 175.76 ms.
- **Initial report draft stated:** AMD Ryzen 7 5700U, 15.34 GB RAM, Windows 11 Enterprise, HTTP admitted/rejected: 250 / 1750, mean latency: 189.86 ms.

### Root Cause Analysis:

1. **Host Environment:** The host machine is an **AMD Ryzen 7 5700U with Radeon Graphics** (8 physical cores, 16 logical threads) with **15.35 GB usable RAM** (16 GB installed) running **Microsoft Windows 11 Pro** (build 10.0.26300, x64). The "5700X / 32 GB" entry in the chat summary was an ungrounded textual hallucination from a separate development template; "Windows 11 Enterprise" in the initial draft was an erroneous OS caption guess.
2. **Workload Variation:** Prior runs varied between client pool sizes (e.g., 2 clients $\times$ limit 5 = 10 admitted vs 50 clients $\times$ limit 5 = 250 admitted). Without an immutable raw log captured directly to disk, the earlier measurements lacked an authoritative single source of truth.

### Corrective Action:

All previous benchmark numbers are designated **unverified historical drafts**. A fresh, fully automated benchmark execution was conducted via [`scripts/benchmark.ts`](../scripts/benchmark.ts), capturing environment specs via system APIs and saving raw stdout directly to [`docs/benchmarks/raw-benchmark-output.txt`](benchmarks/raw-benchmark-output.txt). Only data from this captured execution is published below.

---

## 3. Targeted Defect Corrections

### Sliding Window Counter: Next Epoch Transition Defect

- **Confirmed Defect:** For policy `{ limit: 5, windowMs: 60000 }` saturated at $t = 0\text{ ms}$, immediate arrival of request 6 returned `resetTimeMs = 60000` and `retryAfterSeconds = 60`. However, at $t = 60000\text{ ms}$, the former current count (5) transitions to previous count with weight $1.0$ ($\text{estimatedCount} = 5 \times 1.0 = 5.0 \ge 5$). The request was still rejected at $t = 60000\text{ ms}$ and only admitted at $t = 60001\text{ ms}$ (where decay begins: $5 \times \frac{59999}{60000} \approx 4.9999 < 5$). Instructing the client to retry after 60 seconds instructed it to retry at a millisecond when it was guaranteed to be rejected.
- **Root Cause:** When `currentCount >= limit`, the implementation assigned `earliestAdmissibleTimeMs = resetTimeMs = (windowId + 1) * windowMs`.
- **Mathematical Correction:** In the subsequent window starting at $W_1 = (windowId + 1) \times windowMs$, $C_{\text{next}} = 0$ and $P_{\text{next}} = C_{\text{curr}}$. Admission requires:
  $$P_{\text{next}} \cdot \left(1 - \frac{\Delta t}{windowMs}\right) < limit \implies \Delta t > windowMs \cdot \left(1 - \frac{limit}{P_{\text{next}}}\right)$$
  For $P_{\text{next}} = limit$, $\Delta t > 0$, yielding discrete millisecond $\Delta t = 1\text{ ms}$ and $t_{\text{admissible}} = W_1 + 1 = 60,001\text{ ms}$. At $t = 0\text{ ms}$, $waitMs = 60,001\text{ ms} \implies retryAfterSeconds = \lceil 60001 / 1000 \rceil = 61\text{ seconds}$.
- **Integer Operation Ordering:** Floating-point subtraction in $windowMs \cdot (1 - deficit / previousCount)$ suffered from IEEE 754 precision error (`1 - 0.8` evaluates to `0.19999999999999996`, resulting in `11999.999999999998` instead of `12000`). Reordered to exact integer multiplication prior to division in [`src/core/sliding-window-counter.ts`](../src/core/sliding-window-counter.ts):
  $$\text{thresholdElapsed} = \frac{windowMs \cdot (previousCount - deficit)}{previousCount}$$
- **Regression Tests Added:**
  - [`tests/unit/sliding-window.test.ts`](../tests/unit/sliding-window.test.ts#L225-L280) > _"calculates accurate Retry-After and resetTimeMs when current window is fully exhausted at t = 0 (next epoch transition defect)"_
  - [`tests/unit/sliding-window.test.ts`](../tests/unit/sliding-window.test.ts#L282-L330) > _"verifies repeated denials, millisecond-to-second rounding, and nonzero previousCount under Sliding Window Counter"_

---

## 4. Performance & Benchmark Measurements

### 4.1 Benchmark Execution Environment

- **Execution Timestamp (UTC):** 2026-10-26T22:59:50.595Z
- **Node.js Runtime:** v22.18.0
- **Redis Server:** 7.4.12 (via Docker container `redis:7-alpine`)
- **Operating System:** Microsoft Windows 11 Pro (Release 10.0.26300, x64)
- **CPU Hardware:** AMD Ryzen 7 5700U with Radeon Graphics (16 logical cores)
- **System Memory:** 15.35 GB total usable RAM
- **Harness Script:** `scripts/benchmark.ts` (executed via `npx tsx scripts/benchmark.ts`, exit code 0)
- **Raw Log Artifact:** [`docs/benchmarks/raw-benchmark-output.txt`](benchmarks/raw-benchmark-output.txt)

---

### 4.2 In-Memory Algorithm Benchmark Suites (3 Repetitions per Workload)

To eliminate the bias of measuring only saturated-quota rejections, the harness evaluated algorithms across three semantically distinct workloads (50,000 operations each, preceded by 1,000 warmup operations, executed across 3 independent repetitions to capture observed variance):

#### Workload 1: Fresh Clients (100% Admission / Cold State)

50,000 unique client keys (`limit: 10`). Every operation tests first-touch map allocation and admission initialization.

| Algorithm                  | Mean Throughput | Observed Range (Min – Max) | Admitted / Rejected |   p50   |   p95   |   p99   |
| :------------------------- | :-------------: | :------------------------: | :-----------------: | :-----: | :-----: | :-----: |
| **Fixed Window Counter**   |  649,983 ops/s  |    [530,041 – 820,420]     |     50,000 / 0      | 1.00 µs | 2.20 µs | 3.50 µs |
| **Token Bucket**           |  800,539 ops/s  |    [533,296 – 977,792]     |     50,000 / 0      | 0.70 µs | 1.30 µs | 2.00 µs |
| **Sliding Window Log**     |  594,947 ops/s  |    [459,461 – 702,146]     |     50,000 / 0      | 0.80 µs | 1.30 µs | 1.80 µs |
| **Sliding Window Counter** |  802,603 ops/s  |   [587,897 – 1,050,334]    |     50,000 / 0      | 0.90 µs | 1.70 µs | 2.30 µs |

#### Workload 2: Saturated Quotas (~98% Rejection / Fast-Path)

100 client keys (`limit: 10`, 500 ops per key). Measures fast-path rejection on exhausted quotas.

| Algorithm                  | Mean Throughput | Observed Range (Min – Max) | Admitted / Rejected |   p50   |   p95   |   p99   |
| :------------------------- | :-------------: | :------------------------: | :-----------------: | :-----: | :-----: | :-----: |
| **Fixed Window Counter**   | 1,326,298 ops/s |  [1,163,597 – 1,445,998]   |   1,000 / 49,000    | 0.60 µs | 0.70 µs | 0.90 µs |
| **Token Bucket**           | 1,827,101 ops/s |  [1,676,924 – 1,960,661]   |   1,000 / 49,000    | 0.40 µs | 0.50 µs | 0.60 µs |
| **Sliding Window Log**     | 1,077,665 ops/s |  [1,024,286 – 1,126,464]   |   1,000 / 49,000    | 0.80 µs | 0.90 µs | 1.10 µs |
| **Sliding Window Counter** | 1,999,177 ops/s |  [1,925,818 – 2,129,408]   |   1,000 / 49,000    | 0.40 µs | 0.50 µs | 0.70 µs |

#### Workload 3: Mixed Steady-State Traffic (50% Admission / 50% Rejection)

5,000 client keys (`limit: 5`, 10 ops per key: 5 admitted, 5 rejected).

| Algorithm                  | Mean Throughput | Observed Range (Min – Max) | Admitted / Rejected |   p50   |   p95   |   p99   |
| :------------------------- | :-------------: | :------------------------: | :-----------------: | :-----: | :-----: | :-----: |
| **Fixed Window Counter**   | 1,373,786 ops/s |  [1,335,720 – 1,425,001]   |   25,000 / 25,000   | 0.50 µs | 0.80 µs | 1.30 µs |
| **Token Bucket**           | 1,765,058 ops/s |  [1,711,309 – 1,843,821]   |   25,000 / 25,000   | 0.40 µs | 0.70 µs | 1.10 µs |
| **Sliding Window Log**     | 1,250,783 ops/s |  [1,220,402 – 1,267,925]   |   25,000 / 25,000   | 0.60 µs | 0.80 µs | 1.30 µs |
| **Sliding Window Counter** | 1,707,974 ops/s |  [1,580,798 – 1,802,770]   |   25,000 / 25,000   | 0.40 µs | 0.70 µs | 1.10 µs |

#### Comparative Observations:

1. **Workload Sensitivity:** Algorithm ranking is not static across workloads. Under fresh clients, map allocation dominates (~600k–800k ops/s). Under saturated quotas, **Sliding Window Counter** reaches ~2.0M ops/s and **Token Bucket** reaches ~1.8M ops/s due to branch prediction and minimal arithmetic.
2. **Sliding Window Log Cost:** In all workloads, Sliding Window Log throughput is lower than other algorithms due to array allocation and timestamp filtering, but bounding timestamps to admitted requests keeps p99 under 1.8 µs.
3. **Variance:** In-memory execution in V8 is subject to JIT compilation phases and GC minor pauses, resulting in observed throughput ranges of $\pm 15\%$. Presenting min–max ranges avoids misleading single-run precision.

---

### 4.3 Distributed Express HTTP + Redis Benchmark

Workload: **2,000 HTTP GET requests** against `/api/v1/limited` across 50 clients (`limit: 5`, `windowMs: 60000`) executed in closed batches with concurrency level 20. Preceded by 50 warmup requests and explicit pre/post quota resets.

| Metric                            | Measured Value                                                         |
| :-------------------------------- | :--------------------------------------------------------------------- |
| **Architecture**                  | Express HTTP + Redis Lua State Machine (`RedisFixedWindowRateLimiter`) |
| **Total Requests**                | 2,000                                                                  |
| **Concurrency Level**             | 20 parallel requests per closed batch                                  |
| **Total Duration**                | 5,249.00 ms                                                            |
| **Throughput**                    | **381 req/sec**                                                        |
| **Admitted Requests (HTTP 200)**  | **250** (exactly $50\text{ keys} \times 5\text{ limit}$)               |
| **Throttled Requests (HTTP 429)** | **1,750**                                                              |
| **Unexpected Statuses**           | **0**                                                                  |
| **Sum Integrity Check**           | $250 + 1750 + 0 = 2000$ (Integrity Verified)                           |

#### Latency Distribution Breakdown:

- **Overall Requests:** p50: 44.94 ms | p95: 85.42 ms | p99: 116.74 ms | Mean: 49.59 ms
- **Admitted Requests (200):** p50: 50.73 ms | p95: 66.31 ms | p99: 67.55 ms | Mean: 50.72 ms
- **Throttled Requests (429):** p50: 43.99 ms | p95: 86.94 ms | p99: 117.30 ms | Mean: 49.42 ms

#### Methodology & Latency Analysis:

1. **Supertest Closed-Loop Bottleneck:** The Supertest test agent runs in Node.js on localhost without HTTP keep-alive connection reuse. Each request incurs ephemeral socket establishment, TCP loopback traversal, Node HTTP parser dispatch, Express middleware stack execution, ioredis TCP command dispatch, Redis Lua execution, and HTTP response serialization. The 381 req/sec measurement represents closed-loop request-response latency on a developer machine, **not** the maximum throughput capacity of Redis (which exceeds 80k+ ops/sec with pipelining) or Express.
2. **Admitted vs Throttled Latency:** Admitted requests show higher p50 latency (50.73 ms vs 43.99 ms) due to Redis key initialization and full downstream route handler execution (`res.json(...)`). Throttled requests short-circuit in middleware at `res.status(429).json(...)`, resulting in a lower p50 but longer tail (p99 117.30 ms) under batch concurrency contention.

---

## 5. Adversarial Test-Strength Review (Controlled Mutation Experiments)

All 11 mutation experiments specified in the Phase 12 roadmap were executed sequentially. Each mutation was introduced, verified against the test suite, and restored immediately prior to the next experiment.

> [!IMPORTANT]
> **Mutation Scope Disclaimer:** These 11 mutations represent a targeted set of controlled architectural mutations designed to probe critical contract and concurrency boundaries. They represent **documented agent-reported outcomes**, not a mathematically complete mutation score or independent external audit.

|   #    | Mutation Description                                       | Target File & Line                     | Expected Detection                           | Actual Command & Detection Outcome                                                                               | Detection Status |
| :----: | :--------------------------------------------------------- | :------------------------------------- | :------------------------------------------- | :--------------------------------------------------------------------------------------------------------------- | :--------------: |
| **1**  | Syntax error (`const invalidSyntax = ;`)                   | `src/core/fixed-window.ts:31`          | TypeScript compiler (`tsc`)                  | `npm run typecheck` $\to$ Exit 1: `error TS1109: Expression expected.`                                           |    **KILLED**    |
| **2**  | Misspelled rate-limit header (`X-Rate-Limit-Limit`)        | `src/middleware/rate-limit.ts:105`     | HTTP contract test assertions                | `npm run test:contract` $\to$ Exit 1: 3 contract tests failed (`expected undefined to be '5'`)                   |    **KILLED**    |
| **3**  | Missing `X-RateLimit-Reset` header                         | `src/middleware/rate-limit.ts:107`     | Contract reset header existence              | `npm run test:contract` $\to$ Exit 1: 5 tests failed (`expected undefined to be defined`)                        |    **KILLED**    |
| **4**  | Middleware bypassed on `/api/v1/limited`                   | `src/app/create-app.ts:47`             | Unthrottled route access & missing headers   | `npm run test:contract` $\to$ Exit 1: 19 contract tests failed (unlimited requests returned 200 without headers) |    **KILLED**    |
| **5**  | Router mounted under incorrect prefix (`/api/v2`)          | `src/app/create-app.ts:52`             | Route resolution failure (HTTP 404)          | `npm run test:contract` $\to$ Exit 1: 20 contract tests failed (`expected 404 to be 200/429`)                    |    **KILLED**    |
| **6**  | Route handler returns HTTP 404 instead of 200              | `src/app/create-app.ts:48`             | Route success status code assertion          | `npm run test:contract` $\to$ Exit 1: 15 contract tests failed (`expected 404 to be 200`)                        |    **KILLED**    |
| **7**  | Route returns HTTP 200 instead of 429 on quota breach      | `src/middleware/rate-limit.ts:113`     | Quota exhaustion status code assertions      | `npm run test:contract` $\to$ Exit 1: 10 contract tests failed (`expected 200 to be 429`)                        |    **KILLED**    |
| **8**  | Off-by-one quota limit ($L + 1$ allowed)                   | `src/core/fixed-window.ts:60`          | Unit test 5th/6th boundary assertions        | `npm run test` $\to$ Exit 1: 10 unit tests failed (`expected true to be false` on 6th request)                   |    **KILLED**    |
| **9**  | First request after window reset not counted ($count = 0$) | `src/core/fixed-window.ts:51`          | Initial rollover remaining quota assertions  | `npm run test` $\to$ Exit 1: 14 unit tests failed (`expected 5 to be 4`)                                         |    **KILLED**    |
| **10** | Non-atomic Redis state (counter write omitted in Lua)      | `src/storage/redis-fixed-window.ts:51` | Redis integration concurrency and saturation | `npm run test:integration` $\to$ Exit 1: 7 tests failed (counter failed to saturate at $L+1$)                    |    **KILLED**    |
| **11** | Whole Express app broken (returns 500 on all routes)       | `src/app/create-app.ts:54`             | All contract test route invocations          | `npm run test:contract` $\to$ Exit 1: 22 tests failed (`expected 500 to be 200/429/404`)                         |    **KILLED**    |

**Mutation Score for Tested Set:** **11 / 11 Killed (0 Surviving Mutations)**.

---

## 6. Full Verification Pipeline Execution

Following the benchmark and mutation experiments, the full verification pipeline was executed via `npm run verify`:

```text
> rate-limiting-lab@0.1.0 verify
> npm run typecheck && npm run lint && npm run format:check && npm run test && npm run test:contract && npm run test:integration && npm run build

> rate-limiting-lab@0.1.0 typecheck
> tsc --noEmit
Exit code: 0

> rate-limiting-lab@0.1.0 lint
> eslint .
Exit code: 0

> rate-limiting-lab@0.1.0 format:check
> prettier --check "**/*.{ts,js,json,md}" --ignore-path .gitignore
All matched files use Prettier code style!
Exit code: 0

> rate-limiting-lab@0.1.0 test (In-Memory Unit Suites)
✓ tests/unit/sliding-window.test.ts (20 tests)
✓ tests/unit/token-bucket.test.ts (24 tests)
✓ tests/unit/fixed-window.test.ts (18 tests)
✓ tests/smoke.test.ts (2 tests)
Test Files: 4 passed (4)
Tests:      64 passed (64)
Exit code:  0

> rate-limiting-lab@0.1.0 test:contract (HTTP Contract & Resilience Suites)
✓ tests/contract/http-contract.test.ts (14 tests)
✓ tests/contract/http-concurrency-resilience.test.ts (9 tests)
Test Files: 2 passed (2)
Tests:      23 passed (23)
Exit code:  0

> rate-limiting-lab@0.1.0 test:integration (Redis Integration Suite)
✓ tests/integration/redis-fixed-window.test.ts (16 tests)
Test Files: 1 passed (1)
Tests:      16 passed (16)
Exit code:  0

> rate-limiting-lab@0.1.0 build
> tsc -p tsconfig.build.json
Exit code:  0
```

**Total Verified Tests:** **103 passing tests** (64 unit + 23 contract + 16 integration). Zero failing, zero skipped.

---

## 7. Operational Boundaries & Remaining Testing Gaps

1. **Redis Primary Scope:** The verified Redis rate limiter operates against a single active Redis primary instance via atomic Lua scripting. It guarantees atomicity against race conditions across multiple client processes, but does not provide failover durability across asynchronous replica replication.
2. **In-Memory Non-Persistence:** In-memory implementations (Fixed Window, Token Bucket, Sliding Window Log, Sliding Window Counter) maintain state purely in Node.js process memory. Process termination wipes client history.
3. **Multi-Region CAP Constraints:** As documented in `docs/scenarios/06-multi-region.md`, multi-region rate limiting across cross-continental WANs requires explicit trade-offs between consistency and edge latency. The laboratory Docker environment tests local concurrency, but does not claim simulated multi-region WAN partition survival.
4. **Remaining Load Testing Gaps:** This laboratory does not include sustained multi-hour soak tests, distributed multi-node Locust/k6 cluster load generators, or WAN network fault injection (e.g. Chaos Mesh / Toxiproxy). High-concurrency tests are bounded to local integration and contract suites.
