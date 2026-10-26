# ADR 0002: Redis Distributed Fixed Window Implementation, Atomicity & Time Authority

**Status:** Accepted  
**Date:** 2026-10-26  
**Context:** Phase 06 — Distributed Fixed Window with Redis  
**Deciders:** Senior Backend Engineering Team

---

## 1. Context & Problem Statement

Phase 05 established a deterministic, in-memory reference implementation of the Fixed Window Counter algorithm.
However, in-memory state is isolated to a single Node.js process:

1. It cannot coordinate quota enforcement across multiple independent application instances.
2. It exhibits unbounded cardinality retention in memory ($O(U)$ keys) unless manually cleared.
3. Node.js system clocks across server instances suffer from drift, which could cause requests arriving at the same physical instant to map to different fixed-window buckets.

Phase 06 requires implementing a distributed, Redis-backed Fixed Window rate limiter that enforces identical external semantics to the in-memory reference model while guaranteeing concurrency safety across independent application instances.

---

## 2. Decision Log

### 2.1 Atomic Admission via Lua Script (`EVAL`)

- **Evaluated Alternatives:**
  1. _Multi/Exec Transaction:_ Redis `WATCH` + `MULTI` / `EXEC` requires optimistic concurrency control with retry loops. Under heavy contention, high abort rates introduce latency spikes and wasted roundtrips.
  2. _Separate Pipelined Commands (`INCR` + `EXPIRE`):_ If the process crashes or network disconnects between `INCR` and `EXPIRE`, the key is left without a TTL, creating an accidental permanent leak.
  3. _Atomic Lua Script (`EVAL`):_ Evaluates read, increment, expiration assignment, and saturation capping in a single server-side event loop execution tick.
- **Decision:** Use an atomic Lua script (`FIXED_WINDOW_LUA_SCRIPT`) executed on the Redis primary. This eliminates time-of-check to time-of-use (TOCTOU) race conditions under concurrent client requests.

### 2.2 Time Authority: Shared Redis Server Time (`TIME`) & Non-Monotonicity

- **Decision:** The Lua script queries Redis server time via `redis.call('TIME')` as the shared authority to compute `windowId = math.floor(nowMs / windowMs)`.
- **Clock Authority vs Monotonicity Caveat:**
  - `TIME` prevents cross-instance application clock drift from fragmenting epoch windows.
  - **Explicit Non-Monotonicity Notice:** Redis `TIME` returns the host operating system wall-clock (via `gettimeofday`). It is synchronized across all clients connecting to that primary, but it is **not strictly monotonic**. NTP step adjustments, slew adjustments, or leap seconds on the Redis host can shift the clock backward or forward. It must be treated as a shared epoch wall-clock authority, not a monotonic hardware counter.

### 2.3 Single-Primary Atomicity vs Failover Durability

- **Explicit Distinction:**
  - **Atomicity on Single Primary:** Execution inside a Lua script is serialized on the Redis single-threaded primary, ensuring no two commands interleave.
  - **Durability across Asynchronous Replication Failover:** Redis replication to replicas is asynchronous by default. If a primary crashes before an acknowledged `INCR` write is replicated to a replica, the increment will be lost upon failover.
  - **Engineering Rationale:** Rate limiting is transient admission control over short rolling horizons (e.g., seconds or minutes), not durable financial ledgering. Ephemeral state loss recovering in $\le W$ is an acceptable design tradeoff, but it must never be conflated with ACID transactional durability.

### 2.4 Key Expiration Aligned with Epoch Window Boundaries

- **Key Format:** `${keyPrefix}:${clientId}:${windowId}` (e.g., `ratelimit:fixed:client_1:29817205`).
- **TTL Semantics:**
  - TTL is computed as $\text{resetTimeMs} - \text{nowMs}$ and set via `PEXPIRE` **strictly on the initial request** of window $k$ (`count === 1`).
  - Subsequent requests (whether admitted or rejected) do **not** refresh or prolong the TTL.
  - When window $k$ ends, the key expires in Redis, avoiding cardinality memory leaks without manual purging.

### 2.5 Counter Saturation Ceiling

- **Behavior:** On quota exhaustion (`count > limit`), the counter saturates at $\text{limit} + 1$ using `redis.call('SET', key, limit + 1, 'KEEPTTL')`.
- **Rationale:** Preserves remaining quota at 0 and records the breach for observability while preventing integer overflow or memory bloat under denial-of-service traffic floods.

### 2.6 Supported Numeric Range

- **Validation:**
  - $1 \le \text{limit} < \text{Number.MAX_SAFE_INTEGER}$ ($2^{53} - 1 \approx 9.007 \times 10^{15}$).
  - $1 \le \text{windowMs} \le \text{Number.MAX_SAFE_INTEGER}$.
- **Lua Numeric Representation:** Redis 7 uses embedded Lua 5.1, which represents numbers as IEEE 754 double-precision floating-point values with 53 bits of exact integer precision. Constraining limits below $2^{53} - 1$ ensures zero rounding errors across Node.js and Redis Lua.

---

## 3. Consequences & Tradeoffs

### Positive

- **Zero Concurrency Leaks:** Verified by automated integration tests: 20 simultaneous concurrent requests against a limit of 5 admit exactly 5 requests and reject exactly 15 without race conditions.
- **Multi-Instance Coordination:** Two independent application instances share identical quota without local state leakage.
- **Bounded Storage:** Keys expire automatically at window boundaries, and counters cap at $L + 1$.
- **Fail-Closed Storage Boundary:** If Redis is unreachable, `consume()` throws a connection error rather than silently reporting quota exhaustion.

### Negative & Known Tradeoffs

- **Single Primary Bottleneck:** High-throughput rate limiting on a single key is bound by the single-threaded throughput of the Redis primary.
- **Failover State Loss:** Unreplicated writes may be lost during abrupt primary failover under asynchronous replication.
