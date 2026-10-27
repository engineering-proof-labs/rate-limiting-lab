# Scenario 01: Transition from Single-Process to Multi-Instance Architecture

**Status:** Implemented and Tested  
**Category:** Horizontal Scaling & Concurrency  
**Repository:** `engineering-proof-labs/rate-limiting-lab`

---

## 1. Original System Contract & Assumptions

In Phase 05, the rate limiter operated as a single-process, in-memory reference implementation (`InMemoryFixedWindowRateLimiter`):

- All rate-limiting state was stored in a local JavaScript `Map<string, ClientWindowState>`.
- Operations were executed synchronously on the Node.js event loop within a single OS process.
- Clock authority was derived entirely from the local runtime environment (`Date.now()` or injected `VirtualClock`).
- Quota enforcement was assumed to be strictly centralized because 100% of incoming HTTP traffic terminated on this single process.

---

## 2. Newly Introduced Constraint

The service must scale horizontally to handle increased throughput. The single Node.js process is replaced by $N$ independent application instances (e.g., $N = 10$ container replicas) positioned behind a layer-7 load balancer (e.g. AWS ALB, Nginx, or Kubernetes Ingress) distributing requests via round-robin or least-connections.

---

## 3. Invalidated Assumptions

1. **State Centralization:** In-memory `Map` storage is isolated to each process. Memory is not shared across OS processes or containers.
2. **Effective Quota Invariant:** If each instance maintains an independent quota of $L = 5$ requests per window, an adversary or client whose requests are evenly distributed across $N$ instances can consume up to:
   $$\text{Max Admitted Traffic} = N \times L = 10 \times 5 = 50\text{ requests}$$
   The intended rate limit of 5 requests per window is breached by a factor of $N$.

---

## 4. Evaluated Alternatives

### Alternative A: Sticky Sessions (IP-Hash Load Balancing)

- **Mechanism:** The load balancer hashes the client IP address or session identifier to ensure all requests from client $C$ consistently route to the same application replica.
- **Tradeoffs:**
  - _Advantages:_ Allows application instances to retain low-latency, zero-network in-memory rate limiting.
  - _Disadvantages:_ Highly vulnerable to hot-spotting (e.g. large enterprise NAT gateways routing thousands of users to a single node). Process crashes, rolling deployments, and autoscaling events rehash routing, wiping transient quota tracking and causing quota resets.

### Alternative B: Centralized Distributed Storage (Redis Primary)

- **Mechanism:** All application instances delegate state management to an external, high-performance in-memory datastore (Redis). Rate limit checks and increments are executed via atomic Redis operations.
- **Tradeoffs:**
  - _Advantages:_ Enforces a single global quota $L$ regardless of cluster size $N$. Deployments and autoscaling do not fragment or reset client quota tracking.
  - _Disadvantages:_ Introduces network latency (0.5–2 ms per request) and an external infrastructure dependency subject to network partitions and hardware failure.

---

## 5. Explicit Tradeoffs & Recommended Choice

**Selected: Alternative B (Centralized Distributed Storage via Redis).**

In modern containerized environments, pods frequently autoscale and restart. Sticky sessions compromise load balancing uniformity and fail under corporate NATs. Centralizing state in Redis guarantees that cluster elasticity does not degrade rate-limiting correctness.

---

## 6. Expected Failure Modes & Operational Limitations

1. **Single Point of Failure (SPOF):** If the Redis primary crashes or becomes unreachable, application instances cannot verify quota. The system must implement explicit fail-closed or fail-open policies (explored in Scenario 04).
2. **Network Latency Overhead:** Every rate-limited request incurs a network round-trip to Redis before response emission.

---

## 7. Executable Acceptance Criteria

1. Two independent HTTP application instances sharing a Redis backing store must collectively enforce a single quota $L = 5$.
2. Under concurrent requests distributed across both instances, exactly 5 requests are admitted (HTTP 200) and the remaining requests are rejected (HTTP 429).
3. Neither instance permits more than 5 total requests across the window.

---

## 8. Existing Tests & Verification Paths

- **Multi-App HTTP Contract Test:** [`tests/contract/http-concurrency-resilience.test.ts`](../../tests/contract/http-concurrency-resilience.test.ts)
  - Test case: `collectively admits exactly 5 and throttles 15 across 20 concurrent requests split between two independent app instances`
- **Redis Concurrency Test:** [`tests/integration/redis-fixed-window.test.ts`](../../tests/integration/redis-fixed-window.test.ts)
  - Test case: `strictly admits exactly 5 and rejects 15 under 20 concurrent requests with Promise.all`

---

## 9. Missing Tests & Proposed Experiments

- **Experiment:** Introduce synthetic network latency (e.g. 10 ms jitter via proxy) between Express and Redis to measure tail latency impact under high concurrency.

---

## 10. Implementation Status

**Label:** `implemented/tested`
