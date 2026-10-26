# Scenario 02: Concurrent Requests & Distributed Race Conditions

**Status:** Implemented and Tested  
**Category:** Concurrency Safety & Atomicity  
**Repository:** `engineering-proof-labs/rate-limiting-lab`

---

## 1. Original System Contract & Assumptions

In basic rate-limiting designs, requests are assumed to arrive sequentially with sufficient temporal separation:

1. Application reads current counter $C$ from storage (`GET key`).
2. Application checks if $C < L$.
3. If allowed, application increments counter (`INCR key` or `SET key (C + 1)`).

---

## 2. Newly Introduced Constraint

Under high concurrency (e.g. flash crowds, distributed DDoS, or microservices making burst calls via `Promise.all`), multiple requests arrive at the storage layer within the exact same microsecond.

---

## 3. Invalidated Assumptions

1. **Non-Atomic Read-Modify-Write Safety:**
   Under concurrency, multiple threads or independent application instances perform `GET` simultaneously. If the current counter is $4$ and limit is $5$:
   - Instance 1 reads $C = 4$.
   - Instance 2 reads $C = 4$.
   - Instance 3 reads $C = 4$.
   - All three instances conclude $C < 5$ and proceed to increment and admit the request.
   - Result: 3 requests are admitted instead of 1. Total admitted requests reach 7 on a limit of 5.
   - This classic Time-of-Check to Time-of-Use (TOCTOU) race condition destroys rate-limiting guarantees.

---

## 4. Evaluated Alternatives

### Alternative A: Redis Transactions (`MULTI` / `EXEC` with `WATCH`)

- **Mechanism:** Optimistically locks the key using `WATCH`. If the key is modified between `WATCH` and `EXEC`, the transaction aborts and must be retried.
- **Tradeoffs:**
  - _Advantages:_ Standard Redis primitives without custom script execution.
  - _Disadvantages:_ Under high contention, transactions suffer severe abort rates. Aborts require retry loops with exponential backoff, driving up latency and CPU load during bursts.

### Alternative B: Atomic Server-Side Lua Scripting (`EVAL` / `EVALSHA`)

- **Mechanism:** Encapsulates the window calculation, check, increment, saturation, and expiration logic in a single Lua script executed atomically on the Redis engine.
- **Tradeoffs:**
  - _Advantages:_ Redis executes Lua scripts as an atomic, uninterrupted block. Zero race conditions, zero transaction aborts, and single network round-trip overhead.
  - _Disadvantages:_ Long-running Lua scripts block Redis single-threaded execution loop. The script must remain strictly $O(1)$ arithmetic.

---

## 5. Explicit Tradeoffs & Recommended Choice

**Selected: Alternative B (Atomic Lua Scripting).**

The Lua script performs only $O(1)$ hash field updates (`HGET`, `HSET`, `PEXPIREAT`), executing in $< 50\mu\text{s}$ per invocation. It eliminates TOCTOU races in a single round-trip without transaction contention.

---

## 6. Expected Failure Modes & Operational Limitations

1. **Lua Script Execution Timeouts:** If a misconfigured script blocks Redis beyond `lua-time-limit`, Redis aborts scripts or returns `BUSY` errors.
2. **Failover Asynchrony:** Atomicity within Redis single-threaded engine does not guarantee cross-replica durability across asynchronous Redis Sentinel/Cluster failover.

---

## 7. Executable Acceptance Criteria

1. Submitting 20 parallel requests (`Promise.all`) for limit $L = 5$ across independent Redis client connections must result in **exactly 5 admitted requests** (HTTP 200) and **exactly 15 rejected requests** (HTTP 429).
2. The stored counter must cap at $L + 1 = 6$ to record quota breach without unbounded integer growth.

---

## 8. Existing Tests & Verification Paths

- **Redis Integration Suite:** [`tests/integration/redis-fixed-window.test.ts`](file:///c:/Users/bruno/CV%20Manager/engineering-labs/rate-limiting-lab/tests/integration/redis-fixed-window.test.ts)
  - Test case: `strictly admits exactly 5 and rejects 15 under 20 concurrent requests with Promise.all`
- **HTTP Concurrency Suite:** [`tests/contract/http-concurrency-resilience.test.ts`](file:///c:/Users/bruno/CV%20Manager/engineering-labs/rate-limiting-lab/tests/contract/http-concurrency-resilience.test.ts)
  - Test case: `strictly admits exactly 5 and throttles 15 across 20 concurrent HTTP requests against shared Redis quota`

---

## 9. Missing Tests & Proposed Experiments

- **Experiment:** Contention benchmark firing 1,000 concurrent requests across 50 simulated client connections to measure Lua script execution latency percentiles (p50, p99).

---

## 10. Implementation Status

**Label:** `implemented/tested`
