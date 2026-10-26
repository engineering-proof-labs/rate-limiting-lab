# ADR 0002: Redis Distributed Fixed Window Implementation, Atomicity & Time Authority

**Status:** Accepted  
**Date:** 2026-10-26 (Amended post Phase 06 Targeted Review)  
**Context:** Phase 06 — Distributed Fixed Window with Redis  
**Deciders:** Project maintainer

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

### 2.1 Atomic Admission via Lua Script (`EVAL`) & Declared Key Contract

- **Key Contract Strictness:**
  - The Redis documentation specifies that all keys accessed by a Lua script must be explicitly passed in the `KEYS` array rather than constructed dynamically inside the script.
  - _Decision:_ Use exactly **one declared Redis key per client**, passed as `KEYS[1]` (`ratelimit:fixed:${clientId}`). No internal key synthesis (`KEYS[1] .. ":" .. windowId`) occurs within the Lua script.
  - _State Representation:_ The client key stores a small Redis Hash with two integer fields:
    - `w`: the epoch `windowId` ($\lfloor t / W \rfloor$).
    - `c`: the current admitted counter.
  - _Window Transitions:_ When the script reads `storedWindowId ~= currentWindowId` (or the key does not exist), it atomically resets `w = currentWindowId`, `c = 1`, and sets absolute expiration via `PEXPIREAT`.
  - _Cluster Disclaimer:_ While declaring all keys in `KEYS` is a prerequisite for Redis Cluster, this laboratory currently tests against a single-primary Redis instance and does not claim verified Redis Cluster support.

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

### 2.4 Key Expiration Aligned with Epoch Window Boundaries via `PEXPIREAT`

- **Key Format:** `${keyPrefix}:${clientId}` (e.g., `ratelimit:fixed:client_1`).
- **TTL Semantics:**
  - Expiration is set to the exact epoch-aligned reset timestamp via `PEXPIREAT key resetTimeMs` on initial creation and on window rollover.
  - Subsequent requests within the active window do **not** refresh or alter the expiration boundary.
  - When window $k$ ends, the key expires in Redis, avoiding cardinality memory leaks without manual purging.

### 2.5 Counter Saturation Ceiling

- **Behavior:** On quota exhaustion (`count > limit`), the counter saturates at $\text{limit} + 1$ using `redis.call('HSET', key, 'c', limit + 1)`.
- **Rationale:** Preserves remaining quota at 0 and records the breach for observability while preventing integer overflow or memory bloat under denial-of-service traffic floods.

### 2.6 Reset Isolation & Glob Metacharacter Safety

- **Selective Reset:** Selective reset operates via exact $O(1)$ key deletion: `redis.del(`${keyPrefix}:${clientId}`)`. It does not use `SCAN` with `MATCH` patterns for individual clients, completely eliminating glob injection vulnerabilities (e.g., client keys containing `*`, `?`, or `[]` cannot match or clear sibling keys).
- **Blanket Reset:** Blanket reset (`reset()` without arguments) is an administrative/test operation that uses bounded `SCAN` batches (`COUNT 100`) to clear the entire namespace. It is documented as non-atomic under concurrent writes.

### 2.7 Supported Numeric Range

- **Validation:**
  - $1 \le \text{limit} < \text{Number.MAX_SAFE_INTEGER}$ ($2^{53} - 1 \approx 9.007 \times 10^{15}$).
  - $1 \le \text{windowMs} \le \text{Number.MAX_SAFE_INTEGER}$.
- **Lua Numeric Representation:** Redis 7 uses embedded Lua 5.1, which represents numbers as IEEE 754 double-precision floating-point values with 53 bits of exact integer precision. Constraining limits below $2^{53} - 1$ ensures zero rounding errors across Node.js and Redis Lua.

---

## 3. Consequences & Tradeoffs

### Positive

- **Redis EVAL Contract Compliance:** All accessed keys are declared explicitly in `KEYS[1]`, avoiding dynamic key synthesis inside the script.
- **Zero Glob Injection Risk:** Selective reset deletes exact client keys without pattern expansion.
- **Independent TCP Connection Safety:** Verified by automated integration tests: concurrent requests interleaved across two separate `ioredis` connections collectively admit exactly 5 requests and reject 15 without race conditions.
- **Zero Concurrency Leaks:** 20 simultaneous requests against a limit of 5 admit exactly 5 and reject 15.
- **Bounded Storage:** Keys expire automatically at window boundaries, and counters cap at $L + 1$.
- **Fail-Closed Storage Boundary:** If Redis is unreachable, `consume()` throws a connection error rather than silently reporting quota exhaustion.

### Negative & Known Tradeoffs

- **Single Primary Bottleneck:** High-throughput rate limiting on a single key is bound by the single-threaded throughput of the Redis primary.
- **Failover State Loss:** Unreplicated writes may be lost during abrupt primary failover under asynchronous replication.
