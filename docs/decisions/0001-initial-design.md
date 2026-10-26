# ADR 0001: Initial Architecture, Algorithm Scope & Concurrency Contracts

**Status:** Accepted (Amended in Phase 03.1)  
**Date:** 2026-10-26  
**Context:** Phase 03.1 — Architectural Design Refinement  
**Deciders:** Senior Backend Engineering Team

---

## 1. Context & Problem Statement

Modern web services require rate limiting to prevent denial of service (DoS), protect resource-constrained downstream dependencies, and enforce fair usage policies across clients.

This laboratory requires:

1. An initial reference implementation in TypeScript and Express that is thoroughly testable and verified.
2. An architectural contract for distributed state sharing via Redis that guarantees concurrency safety.
3. Explicit error-handling behavior when the backing store fails.
4. Clean separation of concerns between rate limiting algorithms, storage persistence, and HTTP middleware, without unnecessary architectural ceremony.

---

## 2. Decision Log

### 2.1 Algorithm Selection & Accuracy Tradeoffs

- **Planned Scope:** Four distinct algorithms with explicit accuracy and fairness tradeoffs:
  1. **Fixed Window Counter (Baseline):** Lowest memory ($O(1)$ integer), coarse epoch alignment; allows boundary burst up to $2 \times L$.
  2. **Sliding Window Log:** Mathematically **exact** rolling window enforcement; requires $O(N)$ memory with request volume using Redis `ZSET`.
  3. **Sliding Window Counter:** **Weighted approximation** combining current and previous window counts; low $O(1)$ memory, assuming uniform request distribution.
  4. **Token Bucket:** Continuous token refill at rate $R$, permitting bursts up to bucket capacity $B$; rate-based smoothing rather than rigid window quota.
- **Decision:** Start with **Fixed Window Counter** as the initial baseline algorithm, followed by comparative implementations of the other three algorithms.

### 2.2 Concurrency, Counter Semantics & Distributed Time Authority

- **Distributed Time Authority:**
  - _Problem:_ Application instances running across multiple servers exhibit clock drift. Passing application `Date.now()` into Redis can cause different instances to map requests at the exact same physical moment to different fixed-window epochs, causing counter fragmentation and over-admission.
  - _Decision:_ **Redis Server Time (`redis.call('TIME')`) is the authoritative clock** for distributed admission decisions inside the atomic Lua script. Application clocks are not trusted for distributed window boundaries.
- **Counter Saturation & Expiration:**
  - _Decision:_ Counters increment on admission up to limit $L$, and saturate at $L + 1$ on rejected requests (avoiding unbounded integer growth). Remaining quota is strictly derived as $\text{remaining} = \max(0, L - C)$.
  - _Key TTL:_ Key expiration is set **strictly on the initial request** ($C = 1$) to expire at window boundary plus a safety buffer. Subsequent requests within the window do not refresh or extend the TTL.
- **Atomicity Mechanism:**
  - Evaluates both atomic Lua scripts (`EVAL`/`EVALSHA`) and Redis primitive pipelining (`INCR` + `EXPIRE`). The primary engine uses an atomic Lua script executing `TIME` + check + `INCR` + `EXPIRE` in a single network round-trip to eliminate TOCTOU race conditions.

### 2.3 Backing Store Failure Policy: Fail-Closed Default vs Fail-Open

- **Fail-Closed (Default):**
  - If Redis is unreachable or times out, the middleware rejects the request with **`HTTP 503 Service Unavailable`**.
  - `Retry-After` on 503 is **omitted by default** because Redis infrastructure recovery time cannot be predicted in advance. If an advisory backoff value is configured, it is documented strictly as a client backoff recommendation to mitigate thundering herds, NOT a recovery guarantee.
  - **Crucial Rule:** Dependency failure is a service outage, **not quota exhaustion**. It must NEVER return `HTTP 429 Too Many Requests`.
- **Fail-Open (Configurable):**
  - If Redis is unavailable and fail-open is enabled, the middleware logs a warning and **delegates execution to the downstream route handler** via `next()`. The route handler produces its own natural status and response body (e.g. 200, 201, 404), rather than forcing an artificial HTTP 200.
  - Diagnostic header `X-RateLimit-Fallback: fail-open` is an internal diagnostic header for testing/demonstration only. It is not recommended for production public exposure to prevent disclosing degraded security controls to external attackers.

### 2.4 HTTP Header Contract: De Facto `X-RateLimit-*` Standard

- **Decision:** Emits the **de facto `X-RateLimit-*` headers** with `Retry-After` on HTTP 429 responses.
- **Specification:**
  - `X-RateLimit-Limit`: Total window capacity ($L$).
  - `X-RateLimit-Remaining`: Remaining allowed requests in window ($\ge 0$).
  - `X-RateLimit-Reset`: Unix epoch timestamp in seconds.
  - `Retry-After`: Remaining seconds until reset (emitted **only on HTTP 429**).
- **Contract Guard:** Emitting misspelled variations such as `XRateLimit-Reset` is explicitly classified as a contract regression bug and verified in test suites.

### 2.5 Dual Configuration Profiles

- **Decision:** The laboratory specifies two official profiles:
  1. **Standard Baseline:** 5 requests per 60,000 ms. (Real-world human/API pacing).
  2. **Regression Fixture:** 5 requests per 1,000 ms. (Fast automated test execution).

### 2.6 Test Clock Limitations & Strategies

- **VirtualClock Scope:** `VirtualClock` allows sub-millisecond, deterministic unit tests for in-memory algorithm math. It **does NOT alter or control real Redis server time**.
- **Redis Integration Strategy:** Redis integration tests must use real elapsed time (leveraging the fast 1,000 ms fixture) or programmatic Redis key deletion (`reset()`), rather than assuming virtual time controls external daemons.

### 2.7 Architectural Streamlining (Modularity over Ceremony)

- **Decision:** Avoid artificial micro-files and redundant class wrappers. Inline header formatting and error dispatch directly within the middleware module (`src/middleware/rate-limit.ts`). Keep the module hierarchy focused on genuine boundaries: domain core, storage adapters, HTTP middleware, and application wiring.

---

## 3. Consequences & Tradeoffs

### Positive

- Redis server time eliminates distributed clock skew vulnerabilities across application instances.
- Saturated counter semantics avoid unbounded memory and integer overflow risks.
- Fail-closed default preserves downstream architectural integrity during outages.
- Fail-open accurately preserves downstream route semantics without forcing artificial status codes.

### Negative & Known Tradeoffs

- **Boundary Burst (2x Limit):** Fixed Window Counter inherently allows up to $2 \times L$ requests across window boundaries. (Mitigated later by Sliding Window algorithms).
- **Single Redis Primary Availability:** In fail-closed mode, Redis unavailability halts traffic on rate-limited endpoints until recovery.
