# Scenario 04: Storage Outages, Dependency Failure & Fallback Policies

**Status:** Implemented and Tested  
**Category:** Resilience & Outage Contracts  
**Repository:** `engineering-proof-labs/rate-limiting-lab`

---

## 1. Original System Contract & Assumptions

Rate limiting systems assume the backing persistence engine (Redis) is always available, responsive, and returns commands within nominal latencies ($< 2\text{ ms}$).

---

## 2. Newly Introduced Constraint

In real-world distributed architectures, backing datastores experience operational disruptions:

- Network partitions or packet loss between application pods and Redis clusters.
- Socket connection refusal (`ECONNREFUSED`) caused by daemon crash or node reboot.
- Socket read timeouts (`ETIMEDOUT`) due to network congestion or Redis CPU starvation.
- Read-only cluster states (`READONLY You can't write against a read only replica.`) during failover elections.

---

## 3. Invalidated Assumptions

1. **Storage Infallibility:** Redis cannot be assumed to always return a successful admission decision.
2. **Quota Exhaustion Equivalence:** A storage outage is **not** equivalent to quota exhaustion. Treating storage exceptions as HTTP 429 falsely signals that the client sent too many requests and misleads client retry logic into exponential backoffs rather than surfacing infrastructure degradation.

---

## 4. Evaluated Alternatives

### Alternative A: Fail-Closed Policy (Default)

- **Mechanism:** On storage error or timeout, the middleware short-circuits the request and immediately returns `HTTP 503 Service Unavailable`.
- **Tradeoffs:**
  - _Advantages:_ Protects vulnerable downstream dependencies (databases, payment gateways, microservice compute) from unbounded traffic bursts during infrastructure outages.
  - _Disadvantages:_ Converts a rate limiter failure into an immediate user-facing denial of service for all rate-limited routes.

### Alternative B: Fail-Open Policy (Configurable)

- **Mechanism:** On storage error, the middleware logs a structured warning, appends an optional diagnostic header (`X-RateLimit-Fallback: fail-open`), and delegates control directly to the downstream route handler via `next()`.
- **Tradeoffs:**
  - _Advantages:_ Preserves user-facing availability; legitimate traffic proceeds without interruption.
  - _Disadvantages:_ Completely removes rate limiting; malicious traffic or sudden spikes can cascade into downstream database crashes.

### Alternative C: Hybrid Local Fallback (Rejected Architecture)

- **Mechanism:** During a Redis outage, instances fall back to an in-memory counter with an arbitrary local quota $L_{\text{local}}$.
- **Tradeoffs:**
  - As formalized in ADR 0004, across $N = 50$ autoscaling pods, local allowances multiply ($50 \times L_{\text{local}}$), flooding downstream databases while falsely promising rate limit enforcement. Rejected as unviable under elastic infrastructure.

---

## 5. Explicit Tradeoffs & Recommended Choice

**Selected: Configurable Dual Policy with Fail-Closed Default.**

- Default: **Fail-Closed (`503 Service Unavailable`)** to prioritize downstream system safety.
- Optional: **Fail-Open (`next()`)** explicitly enabled for read-heavy APIs where downstream systems possess independent circuit breakers.
- Storage failures never emit `HTTP 429`.

---

## 6. Expected Failure Modes & Operational Limitations

1. **Fail-Closed Cascading 503s:** All rate-limited routes immediately return 503 until Redis recovers.
2. **Retry-After Guarantees:** On 503 responses, `Retry-After` must be omitted or documented strictly as advisory backoff, because storage recovery time cannot be guaranteed.

---

## 7. Executable Acceptance Criteria

1. Connection refusal (`ECONNREFUSED`) or command failures on the default policy must return `HTTP 503 Service Unavailable` with body `{"error": "Service Unavailable", ...}`. **Never HTTP 429.**
2. When configured with `failurePolicy: 'fail-open'`, storage errors must invoke `next()`, allowing the route handler to produce its normal response (`HTTP 200 OK`) and appending `X-RateLimit-Fallback: fail-open`.
3. Following storage restoration, the system must immediately recover and resume exact quota enforcement without requiring application process restarts.

---

## 8. Existing Tests & Verification Paths

- **HTTP Contract Outage Tests:** [`tests/contract/http-contract.test.ts`](file:///c:/Users/bruno/CV%20Manager/engineering-labs/rate-limiting-lab/tests/contract/http-contract.test.ts)
  - Test case: `defaults to fail-closed returning HTTP 503 Service Unavailable when failurePolicy is omitted`
  - Test case: `delegates to route handler when configured with fail-open and sets diagnostic header`
- **Concurrency & Failure Resilience Suite:** [`tests/contract/http-concurrency-resilience.test.ts`](file:///c:/Users/bruno/CV%20Manager/engineering-labs/rate-limiting-lab/tests/contract/http-concurrency-resilience.test.ts)
  - Section: `Connection Refusal & Readonly Replica Rejection`
  - Section: `Transient Storage Outage & Self-Healing State Recovery`

---

## 9. Missing Tests & Proposed Experiments

- **Proposed Test:** Test application behavior under simulated TCP packet loss (blackhole routing) using iptables or container network emulation.

---

## 10. Implementation Status

**Label:** `implemented/tested`
