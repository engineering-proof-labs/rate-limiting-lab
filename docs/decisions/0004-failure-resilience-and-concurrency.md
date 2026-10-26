# ADR 0004: Rate Limiting Failure Policies, Concurrency Invariants & Availability Tradeoffs

**Status:** Accepted
**Date:** 2026-10-26
**Context:** Phase 08 — Concurrency & Failure Resilience

---

## 1. Context & Problem Statement

Distributed rate limiters rely on a shared backing store (Redis) to enforce global quotas across horizontally scaled application instances.
In production distributed systems, backing stores inevitably experience transient failures:

1. TCP connection drops, connection pool exhaustion, or network partitions.
2. Unresponsive or hanging Redis daemons under heavy memory/CPU saturation.
3. Redis command rejections (e.g., node running out of memory with `maxmemory`, or `READONLY` errors on failover replicas).
4. Asynchronous replication lag and uncommitted write loss during primary-replica failovers.

When a reliable rate admission decision cannot be obtained, the application tier faces a fundamental dilemma:

- **Protect downstream services** by rejecting traffic?
- Or **preserve client availability** by admitting traffic?

Furthermore, high-concurrency burst traffic introduces race conditions unless state transitions are strictly atomic and client identity resolution is spoof-resistant.

This ADR formalizes the architectural decisions, operational tradeoffs, and tested invariants governing concurrency and failure resilience.

---

## 2. Decision Log

### 2.1 The Availability vs Security Tradeoff: Why Neither Policy Is Universally Optimal

There is no single correct default failure policy for all distributed systems. The choice depends entirely on which failure mode is more catastrophic for the specific business context:

| Policy                      | Behavior during Storage Outage                                    | Primary Beneficiary                                        | Primary Risk                                                                                     | Recommended Context                                                                                       |
| :-------------------------- | :---------------------------------------------------------------- | :--------------------------------------------------------- | :----------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| **`FAIL_CLOSED`** (Default) | Returns`HTTP 503 Service Unavailable`. Drops traffic at the edge. | Downstream Databases, Core Microservices, Third-party APIs | Converts rate limiter outage into an application-wide denial of service for legitimate users.    | Capacity-constrained downstream systems, expensive transactional operations, or anti-scraping boundaries. |
| **`FAIL_OPEN`**             | Invokes`next()`. Appends `X-RateLimit-Fallback: fail-open`.       | End Users, Client Applications                             | Completely removes traffic protection; allows traffic spikes to cascade into downstream crashes. | High-volume read-heavy APIs where downstream systems possess independent autoscaling or circuit breakers. |

#### Decision: Default to Fail-Closed

- **Contract:** The default policy is `fail-closed`, returning `HTTP 503 Service Unavailable` with body `{"error": "Service Unavailable", "message": "Rate limiting service temporarily unavailable"}`.
- **Critical Rule:** Storage failure is an infrastructure dependency outage, **never quota exhaustion**. It must **never** return `HTTP 429 Too Many Requests`.
- **Header Contract:** `Retry-After` is **omitted by default** on 503 because backend infrastructure recovery time cannot be guaranteed. Emitting a fixed retry interval during a real infrastructure outage risks triggering synchronized retry storms (thundering herd).

---

### 2.2 The Fallback Multiplier Hazard: Why Local In-Memory Fallback Budgets Are Dangerous

A common pattern attempted in rate limiting architectures is a _hybrid fallback_: when Redis is unreachable, each application instance falls back to an internal, in-memory counter with a "small emergency quota" (e.g. 10 requests per minute).

#### The Multiplier Math

If an application cluster has $N$ instances (e.g. $N = 50$ pods behind an ALB), and each node grants a local fallback allowance of $L_{\text{local}} = 10$, the total permitted throughput admitted to downstream services during an outage becomes:

$$
\text{Admitted Traffic} = N \times L_{\text{local}} = 50 \times 10 = 500\text{ req/min}
$$

As the cluster autoscales to handle incoming traffic, $N$ increases, and the admitted load admitted to vulnerable downstream databases **multiplies proportionally**.

- **Decision:** We reject naive distributed local fallback budgets. Outage handling in this lab remains explicit and binary: either `fail-closed` (503) or `fail-open` (`next()`). Where graceful degradation is required in enterprise systems, circuit breakers and shedding must be managed globally at the ingress gateway.

---

### 2.3 Single-Primary Lua Atomicity vs Asynchronous Replication Failover Durability

- **Atomicity on Primary:**
  - Admission decisions are evaluated via an atomic Lua script executed on the single-threaded Redis primary engine.
  - Verification: 20 concurrent HTTP requests against a limit of 5 consistently admit exactly 5 and throttle 15, with zero over-allocation.
- **Failover Durability Limitation:**
  - Standard Redis replication is **asynchronous**. When a primary acknowledges an atomic increment, the data is placed into the replication stream buffer.
  - If the primary crashes before the replication stream reaches all replicas, Sentinel or Redis Cluster will promote a replica that lacks the latest window counter.
  - Consequently, clients may receive an additional window allowance immediately following a failover.
- **Decision:** Rate limiting is an ephemeral traffic-shaping control operating over short horizons (e.g. seconds or minutes), **not a durable billing ledger**. The cost of synchronous replication (`WAIT` command) adds prohibitive cross-node network roundtrips to every API request and introduces fatal latency spikes if replicas degrade. We accept transient state loss across failover as a deliberate, defensible architectural tradeoff.

---

### 2.4 Middleware Catch-All Error Evaluation: Guarantees vs Limitations

In `src/middleware/rate-limit.ts`, the middleware catches any rejection thrown by `limiter.consume(clientKey)`.

#### Tested Guarantees

1. **Connection Refusal (`ECONNREFUSED`):** Verified against an unreachable Redis port (`127.0.0.1:6399`). The connection failure is intercepted and routed to the configured `failurePolicy` (`503 Service Unavailable` or `next()`). Other network failure modes (e.g. `ETIMEDOUT`, packet loss, network partitions, or OOM rejections from a saturated Redis daemon) are theoretically subject to the same catch-all block, but were not individually exercised against live network faults.
2. **Injected Command Errors:** Verified using a simulated limiter error throwing a synthetic `READONLY` message. When a command rejection occurs, the error is handled cleanly according to the failure policy without uncaught exceptions or application crashes. (Note: This exercises middleware error handling via injected exception; it was not tested against a live read-only Redis replica).
3. **Route Isolation:** Unmetered routes (`GET /health`, `GET /api/v1/unlimited`) never invoke `consume()` and remain 100% operational during Redis outages.
4. **Simulated Transient Failure & Recovery:** Verified using a delegating limiter wrapper that simulates a transient storage fault and subsequent recovery against retained Redis state. Quota enforcement resumes immediately from the previously admitted count without requiring application restarts. (Note: This exercises middleware state handling under simulated interruption; it does not test socket-level ioredis automatic reconnection).

#### Known Limitations & Operational Considerations

1. **Catch-All Generality:** The middleware catches _all_ errors from `limiter.consume()`. If a custom limiter implementation throws a programmer error (e.g. `TypeError` or bad state), it is treated as a storage outage rather than an internal application 500 error.
2. **Hanging Sockets Without Driver Timeouts:** The middleware awaits `limiter.consume()`. If Redis becomes unresponsive without closing the TCP connection (e.g., network blackhole), the HTTP request will hang until the Node.js HTTP server timeout or proxy timeout triggers, unless the Redis client is configured with strict timeouts.
   - _Operational Requirement:_ In production, `ioredis` should always be initialized with explicit `connectTimeout` (e.g. 500 ms), `commandTimeout` (e.g. 500 ms), and bounded `maxRetriesPerRequest` (e.g. 1 or 2).
3. **Silent Degradation in Fail-Open:** Fail-open without production monitoring can leave an API unprotected indefinitely without operational visibility. In production deployments, failure callbacks must trigger metrics emission (`rate_limiter_outage_total`).

---

### 2.5 Concurrency Invariants & Identity Protection

1. **IP Anchoring Under Concurrency:**
   - In default mode, client keys are resolved from the socket IP (`ip:127.0.0.1`).
   - Concurrently rotating arbitrary untrusted identity headers (`X-Forwarded-For`, `X-Real-IP`, `X-Client-Id`) fails to evade rate limits because default Express configuration ignores unauthenticated proxy headers when `trust proxy` is false.
2. **Tenant Quota Isolation:**
   - Concurrent bursts across independent client identities (`tenant-alpha` and `tenant-beta`) operate in complete isolation. High-volume contention on one identity does not deplete or stall another identity's quota.
3. **Window Rollover Across Expiration:**
   - Evaluated by executing a concurrent burst within Window 1, awaiting window expiration via Redis server-time synchronization (`redis.time()`), and executing a second concurrent burst in Window 2. The counter resets atomically, the first request in the new window is counted ($C = 1$, $\text{remaining} = L - 1$), and the counter ceiling remains capped at $L + 1$. (Note: This verifies quota rollover across expiration, but does not simulate requests arriving concurrently on opposite sides of a microsecond boundary).

---

## 3. Consequences & Tradeoffs

### Positive

- **Deterministic Concurrency Safety:** Verified across independent Express applications and separate Redis TCP connections.
- **Fail-Closed Default:** Prevents cascading backend failures during Redis outages.
- **Clean Failure Separation:** Dependency outages produce HTTP 503; quota exhaustion produces HTTP 429.
- **Self-Healing State Continuity:** Quota state in Redis is preserved and resumes correctly upon storage availability.

### Negative & Operational Requirements

- **Driver Timeout Dependency:** Resilient failure handling requires explicit timeout configuration in the Redis client.
- **Failover Risk:** Ephemeral counters may reset if Redis undergoes asynchronous failover.
