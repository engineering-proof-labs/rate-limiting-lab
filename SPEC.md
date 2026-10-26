# System Specification — Rate Limiting Laboratory

**Specification Version:** 1.0.0  
**Phase:** 03 — System Design & Contract  
**Repository:** `engineering-proof-labs/rate-limiting-lab`  
**Status:** Approved Specification

---

## 1. Overview & System Purpose

The **Rate Limiting Laboratory** is a production-oriented, reproducible reference implementation and testing harness for HTTP rate limiting in Node.js and TypeScript.

The laboratory demonstrates:

1. Deterministic local algorithms (Fixed Window Counter, Token Bucket, Sliding Window Log, Sliding Window Counter).
2. Distributed concurrency-safe rate limiting backed by Redis.
3. Explicit HTTP middleware contracts, route topologies, and error-handling policies.
4. Concurrency testing suites that prove absence of race conditions under high contention.

---

## 2. Rate Limiting Algorithm Scope & Mathematical Models

### 2.1 Fixed Window Counter Model

Time is partitioned into discrete, non-overlapping intervals of duration $W$ (window size in milliseconds), aligned to the Unix epoch:

$$\text{window\_id}(t) = \left\lfloor \frac{t}{W} \right\rfloor$$

The boundary points for window $k = \text{window\_id}(t)$ are defined as:

$$\text{window\_start}(k) = k \times W$$
$$\text{window\_end}(k) = (k + 1) \times W$$
$$\text{reset\_time}(t) = \text{window\_end}(\text{window\_id}(t)) = \left(\left\lfloor \frac{t}{W} \right\rfloor + 1\right) \times W$$

### 2.2 Admission Rules & Counter Saturation

Let $L$ be the configured quota limit ($L \in \mathbb{N}^+$, e.g., $L = 5$):

1. **State Initialization:** When a client sends their first request at timestamp $t$ within window $k$, if no counter exists for $(client\_id, k)$, a new counter is created with value $C = 1$.
2. **Admission Invariants:**
   - If $C \le L$: The request is **admitted** (`allowed: true`). Remaining quota is:
     $$\text{remaining} = L - C$$
   - If $C > L$: The request is **throttled** (`allowed: false`). Remaining quota is:
     $$\text{remaining} = 0$$
     _(Remaining quota must never be negative)._
3. **Counter Saturation & Memory Retention Semantics:**
   - Rejected requests increment the counter up to a capped ceiling of $L + 1$ to record quota breach without unbounded integer growth. Remaining capacity is strictly bounded: $\text{remaining} = \max(0, L - C)$.
   - _Memory Retention Distinction:_ Capping the counter per key prevents integer overflow and bounds the per-entry data size. However, in the single-process in-memory implementation (`Map`), it does **not** prevent memory growth from high client key cardinality ($O(U)$ where $U$ is the number of distinct client identifiers). Inactive client keys are retained until explicit `reset()`. In distributed Redis deployments (Phase 06), this cardinality retention is solved via automatic key TTL expiration.
   - Key expiration TTL in Redis is set **strictly on the initial request** of window $k$ ($C = 1$). Subsequent requests (whether admitted or rejected) do **not** refresh or extend the TTL.
4. **Window Transition:** When time advances to window $k + 1$, the previous counter is discarded/expired. The first request in window $k + 1$ initializes counter $C = 1$, is admitted, and consumes 1 token ($\text{remaining} = L - 1$).

### 2.3 Comparative Algorithm Accuracy & Tradeoffs

The laboratory evaluates four distinct algorithms with differing accuracy, fairness, and memory tradeoffs:

| Algorithm                  | Rolling Window Accuracy    | Memory Overhead                | Burst Characteristics & Tradeoffs                                                      |
| :------------------------- | :------------------------- | :----------------------------- | :------------------------------------------------------------------------------------- |
| **Fixed Window Counter**   | Coarse (epoch-aligned)     | $O(1)$ integer per client      | Lowest memory; permits up to $2 \times L$ burst across window boundaries.              |
| **Sliding Window Log**     | **Exact** rolling window   | $O(N)$ with request count      | Exact precision via sorted sets (`ZSET`); high memory consumption under heavy traffic. |
| **Sliding Window Counter** | **Weighted approximation** | $O(1)$ (current + prior count) | Low memory; estimates count assuming uniform distribution in prior window.             |
| **Token Bucket**           | Rate + Burst smoothing     | $O(1)$ (tokens + last refill)  | Continuous token refill; explicitly permits bursts up to bucket capacity $B$.          |

---

## 3. Distributed Clock Consistency & Time Authority

### 3.1 Three Distinct Time Domains

To guarantee correctness across deployment modes, we explicitly distinguish three time domains:

1. **Deterministic Virtual Time (`VirtualClock`):** In-memory unit tests. Operates with explicit programmatic time advancement (`advance(ms)`). **Does NOT control real Redis server time.**
2. **Application System Clock (`Date.now()`):** Node.js runtime wall clock. Used by local in-memory limiters and for client-side timing. Subject to NTP synchronization, leap seconds, and clock drift across multi-instance application tiers.
3. **Redis Server Time (`redis.call('TIME')`):** The **authoritative distributed time source**. Redis returns a microsecond-accurate server timestamp `[seconds, microseconds]`.

### 3.2 Time Authority for Distributed Admission

- **Design Choice:** In the Redis-backed implementation, distributed admission decisions and window epoch calculations are anchored to **Redis Server Time** via Lua script execution (`redis.call('TIME')`).
- **Rationale & Skew Prevention:** If multiple independent application instances passed their local `Date.now()` into Redis, clock skew between instances (even 100–200 ms) would cause requests arriving at the exact same physical moment to be mapped to different fixed windows, leading to double-allowance near boundaries. Anchoring time calculation to the Redis server guarantees a single, consistent timeline for all instances.
- **Testing Clock Boundary:** `VirtualClock` is used for sub-millisecond, deterministic unit tests of algorithm logic. Integration tests against real Redis must use real elapsed time (via the fast 1,000 ms fixture) or explicit Redis key state resets, because `VirtualClock` cannot alter the Redis daemon's internal clock.

---

## 4. Client Identity & Trust Boundaries

### 4.1 Demo Identity Strategy

For this laboratory, client identity resolution follows this precedence:

1. `X-Client-Id` header (if provided, sanitized: `/^[a-zA-Z0-9_-]{1,64}$/`).
2. `X-Forwarded-For` header (first IP in chain, if behind a trusted reverse proxy).
3. `req.ip` / remote socket IP (fallback).

### 4.2 Security Disclaimer (Production vs Lab)

> [!CAUTION]
> **Trust Boundary Notice:** Client-supplied HTTP headers (such as `X-Client-Id` or untrusted `X-Forwarded-For`) can be arbitrarily forged by malicious clients. In a production environment, rate-limiting keys must be derived from cryptographically authenticated identities (e.g., validated JWT `sub`, authenticated API key hash, or verified mTLS client certificate). Client IP addresses should only be used as a coarse-grained unauthenticated fallback behind a strictly validated proxy chain.

---

## 5. Storage Contract, Atomicity & Durability

### 5.1 Atomicity Invariant

To prevent race conditions under concurrent requests, rate-limit check-and-increment must be strictly atomic:

- **Condition:** No two concurrent requests for the same client window may observe inconsistent counter values or exceed limit $L$.
- **Redis Implementation Strategy:** Evaluated in Phase 03 ADR:
  - Atomic increment with conditional expiration (`INCR` + `EXPIRE` / Lua script).
  - An atomic Lua script ensures that counter creation, increment, and TTL assignment occur in a single uninterrupted operation.

### 5.2 Key TTL & Memory Management

- Redis key naming format: `ratelimit:{algorithm}:{clientId}:{windowId}`.
  Example: `ratelimit:fixed:client_abc:29817205`
- **TTL Rule:** Keys must be set with an expiration equal to remaining window duration plus a safety buffer $\Delta$:
  $$\text{TTL}_{\text{seconds}} = \left\lceil \frac{\text{reset\_time}(t) - t}{1000} \right\rceil + 5$$
  This ensures Redis automatically reclaims memory for inactive clients while preserving state across the entire active window.

### 5.3 Ephemeral Rate Admission vs Durable Billing Quotas

| Attribute                  | Rate Limiting (This Lab)                                                        | Billing Quotas (Excluded)                                        |
| :------------------------- | :------------------------------------------------------------------------------ | :--------------------------------------------------------------- |
| **Time Horizon**           | Milliseconds, seconds, minutes                                                  | Days, billing cycles, calendar months                            |
| **Storage Backend**        | In-memory RAM / Redis                                                           | ACID Relational DB (PostgreSQL)                                  |
| **Durability Requirement** | Ephemeral / transient. State loss on crash is acceptable (recovers in $\le W$). | Durable / transactional. Data loss causes financial discrepancy. |
| **Consistency**            | High availability, eventual recovery                                            | Strict ACID, write-ahead logging                                 |
| **Audit Trail**            | None / sampling logs                                                            | Immutable ledger entries                                         |

---

## 6. Failure Policies & Dependency Resilience

Rate limiting relies on an external backing store (Redis). When Redis is unreachable, unresponsive, or times out:

### 6.1 Default Policy: Fail-Closed

- **Rationale:** Protects downstream databases and compute resources from cascading overload during infrastructure degradation.
- **HTTP Status Code:** `503 Service Unavailable`.
- **Response Headers:** `Retry-After` is **omitted by default** on 503 because backend infrastructure recovery time cannot be guaranteed. If configured, an advisory backoff value represents a retry recommendation to mitigate thundering herds, NOT a recovery guarantee.
- **Rule:** **A Redis outage is a dependency failure, NOT quota exhaustion. It must NEVER return HTTP 429.**

### 6.2 Configurable Policy: Fail-Open

- **Rationale:** Prioritizes user availability over strict capacity enforcement when downstream systems can withstand temporary bursts.
- **Behavior:** The middleware catches Redis errors, logs a structured warning, and **delegates execution to the actual downstream route handler** via `next()`. The downstream route handler executes normally and produces its own response and status code (e.g. 200, 201, 404).
- **Diagnostic Header:** In demonstration/testing modes, the middleware appends an optional diagnostic header `X-RateLimit-Fallback: fail-open`. _(Note: In production environments, exposing internal fallback state via public response headers is discouraged, as it discloses degraded security controls to external clients)._

---

## 7. HTTP Response Header Contract

The initial demonstration will adhere to widely recognized de facto ecosystem conventions:

```http
HTTP/1.1 200 OK
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 4
X-RateLimit-Reset: 1793036460
Content-Type: application/json
```

On quota exhaustion (Request 6):

```http
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1793036460
Retry-After: 42
Content-Type: application/json

{
  "error": "Too Many Requests",
  "message": "Rate limit quota exceeded. Try again in 42 seconds.",
  "retryAfter": 42
}
```

### 7.1 Detailed Field Specifications

| Header Field            | Type           | Emitted Condition                      | Semantic Meaning                                                                                                |
| :---------------------- | :------------- | :------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| `X-RateLimit-Limit`     | Integer string | All rate-limited responses (200 & 429) | The total permitted requests in the current window ($L$).                                                       |
| `X-RateLimit-Remaining` | Integer string | All rate-limited responses (200 & 429) | Remaining quota for this window. Never negative; stays `0` once exhausted.                                      |
| `X-RateLimit-Reset`     | Integer string | All rate-limited responses (200 & 429) | **Unix timestamp in seconds** (`Math.ceil(reset_time_ms / 1000)`) at which the current window expires.          |
| `Retry-After`           | Integer string | **Only on HTTP 429** responses         | Whole number of **seconds** until the client may retry: $\max(1, \lceil(\text{reset\_time} - t) / 1000\rceil)$. |

### 7.2 Header Spelling & Hyphenation Guard

- **Strict Convention:** `X-RateLimit-Reset` (case-insensitive in HTTP/1.1 and HTTP/2, but must be emitted with standard hyphens).
- **Common Bug Prevented:** Emitting `XRateLimit-Reset` or `X-Rate-Limit-Reset` will fail automated contract tests.

---

## 8. HTTP Routing & Middleware Architecture

### 8.1 API Endpoints

```
[Incoming Request]
       │
       ▼
 ┌───────────────┐
 │ Express App   │
 └───────┬───────┘
         │
         ├───► GET /health               (Bypasses rate limiting; returns 200 OK)
         │
         ├───► GET /api/v1/unlimited     (Bypasses rate limiting; returns 200 OK)
         │
         └───► [RateLimitMiddleware]
                     │
                     ├── Quota Available? ──► Delegate next() ──► GET /api/v1/limited (200 OK + Headers)
                     ├── Quota Exhausted? ──► Short-circuit   ──► HTTP 429 (Too Many Requests + Headers)
                     └── Redis Outage?
                               ├── Fail-Closed ──► Short-circuit   ──► HTTP 503 (Service Unavailable)
                               └── Fail-Open   ──► Delegate next() ──► Route Handler (Diagnostic Header)
```

1. **`GET /health`**
   - Public liveness/readiness endpoint.
   - Status: `200 OK` `{"status": "ok"}`.
   - Never rate-limited.
2. **`GET /api/v1/unlimited`**
   - Control endpoint to verify that rate limiting middleware does not leak across un-targeted routes.
   - Status: `200 OK` `{"success": true, "message": "Unlimited endpoint"}`.
3. **`GET /api/v1/limited`**
   - Protected endpoint enforcing the rate limit policy.
   - Status under quota: `200 OK` `{"success": true, "message": "Access granted"}` with headers.
   - Status over quota: `429 Too Many Requests` with JSON body and headers.

### 8.2 Route Mounting Rule (Prevention of Double-Prefix Bug)

- Middleware and routers must be mounted at explicitly defined root prefixes.
- Tests will explicitly assert against `/api/v1/limited` to guarantee routes are not mistakenly mounted under `/api/api` or `/api/v1/api/v1`.

---

## 9. Configuration Profiles

| Profile Name           | Request Limit ($L$) | Window Duration ($W$) | Storage        | Failure Policy | Primary Purpose                                    |
| :--------------------- | :------------------ | :-------------------- | :------------- | :------------- | :------------------------------------------------- |
| **Standard Baseline**  | 5                   | 60,000 ms (60 s)      | Memory / Redis | Fail-Closed    | Realistic production baseline demo                 |
| **Regression Fixture** | 5                   | 1,000 ms (1 s)        | Memory / Redis | Fail-Closed    | Fast automated test suites and boundary regression |
| **Fail-Open Demo**     | 5                   | 60,000 ms (60 s)      | Redis          | Fail-Open      | Verification of outage resilience                  |

---

## 10. Non-Goals & Scope Exclusions

1. **No External Authentication Engine:** We do not build an OAuth2/OIDC/API-Key server.
2. **No Persistent Billing:** We do not build transaction logs, credit balance deduction, or database billing reconciliations.
3. **No Multi-Region Consensus:** We do not implement multi-datacenter active-active replication (e.g. CRDTs or Raft across continents). A single Redis primary (or Redis cluster) is the authoritative coordinator.
4. **No UI Dashboard:** The lab is strictly an engineering and HTTP API benchmark suite.
