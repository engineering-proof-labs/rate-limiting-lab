# ADR 0005: Token Bucket Reference Algorithm, Refill Dynamics & Complexity Tradeoffs

**Status:** Accepted  
**Date:** 2026-10-26  
**Context:** Phase 09 — Token Bucket Reference Implementation  
**Deciders:** Project maintainer

---

## 1. Context & Problem Statement

Phase 05 established the in-memory Fixed Window Counter reference implementation, and Phase 06/07/08 verified its distributed Redis and Express HTTP behavior.
While Fixed Window Counter has minimal state requirements ($O(1)$ integer), it exhibits a fundamental boundary spike vulnerability:

- A client can send its entire quota $L$ at the very end of window $k$, and another burst $L$ at the very beginning of window $k + 1$.
- Over a rolling interval of length $W$, up to $2 \times L$ requests can be admitted, potentially overloading downstream systems.

Phase 09 requires implementing a deterministic, in-memory reference implementation of the **Token Bucket** algorithm to demonstrate smooth traffic shaping, bounded bursts, and continuous refill behavior without replacing or breaking the existing Fixed Window implementation.

---

## 2. Decision Log

### 2.1 Policy Model & Configuration Parameters

The Token Bucket policy is parameterized by four explicit properties:

```typescript
export interface TokenBucketPolicy {
  readonly capacity: number; // Maximum burst size / bucket capacity (B)
  readonly refillRate: number; // Number of tokens refilled per interval (r)
  readonly refillIntervalMs: number; // Refill interval in milliseconds (I)
  readonly costPerRequest?: number; // Tokens consumed per request (default: 1)
}
```

- **Capacity ($B$):** Positive safe integer defining the maximum token accumulation ceiling.
- **Refill Rate ($r$) and Interval ($I$):** Explicitly decouples token quantity from time units. For example, 1 token every 200 ms is configured as `refillRate: 1, refillIntervalMs: 200` (or `refillRate: 5, refillIntervalMs: 1000`).
- **Cost per Request ($K$):** Defaults to 1 token per request, with optional per-call override support.

---

### 2.2 Refill Semantics & Fractional Precision

1. **Continuous Accrual:**
   Refill is evaluated lazily upon request arrival rather than via active background timers:
   $$\Delta t = \max(0, t_{\text{now}} - t_{\text{last}})$$
   $$\Delta \text{tokens} = \Delta t \times \left(\frac{r}{I}\right)$$
   $$\text{tokens}_{\text{new}} = \min(B, \text{tokens}_{\text{current}} + \Delta \text{tokens})$$

2. **Fractional Token Retention:**
   Tokens accumulate as 64-bit IEEE 754 floating-point values. Intermediate fractional tokens are retained across checks. For instance, with a rate of 1 token per 1,000 ms, ten checks spaced 100 ms apart each accrue 0.1 tokens and collectively yield 1.0 token on the 10th check.

3. **Floating-Point Snapping ($\epsilon = 10^{-9}$):**
   To guard against binary floating-point summation error (e.g. $10 \times 0.1 = 0.9999999999999999 < 1.0$), values within $\epsilon = 10^{-9}$ of an integer snap to the nearest integer.

4. **Bucket Saturation:**
   During extended idle periods ($\Delta t \gg I$), tokens saturate strictly at $B$ and never overflow. When saturated, $t_{\text{last}}$ advances to prevent unbounded integer growth in $\Delta t$.

---

### 2.3 Admission Invariants & Header Semantics

1. **Admission Condition:**
   - If $\text{tokens} \ge K$: **Admitted** (`allowed: true`).
     $$\text{tokens} = \text{tokens} - K$$
     $$\text{remaining} = \left\lfloor \frac{\text{tokens}}{\text{costPerRequest}} \right\rfloor$$
   - If $\text{tokens} < K$: **Throttled** (`allowed: false`).
     Tokens remain unchanged.
     $$\text{remaining} = 0$$

2. **Reset Time (`resetTimeMs`):**
   The timestamp when the bucket will be completely replenished to full capacity:
   $$\text{deficit} = B - \text{tokens}$$
   $$\text{resetTimeMs} = t_{\text{now}} + \left\lceil \text{deficit} \times \left(\frac{I}{r}\right) \right\rceil$$

3. **Retry-After (`retryAfterSeconds`):**
   Emitted exclusively when throttled. Represents the whole number of seconds until enough tokens accrue to satisfy requested cost $K$:
   $$\text{needed} = K - \text{tokens}$$
   $$\text{waitMs} = \left\lceil \text{needed} \times \left(\frac{I}{r}\right) \right\rceil$$
   $$\text{retryAfterSeconds} = \max\left(1, \left\lceil \frac{\text{waitMs}}{1000} \right\rceil\right)$$

---

### 2.4 Clock Regression Handling

If the system clock steps backward ($t_{\text{now}} < t_{\text{last}}$) due to local NTP adjustments, $\Delta t$ is clamped to 0:
$$\Delta t = \max(0, t_{\text{now}} - t_{\text{last}})$$
Tokens are never deducted as a consequence of clock regressions.

---

### 2.5 Time & Space Complexity

- **Time Complexity:** $O(1)$ arithmetic operations per admission check. Zero loops or timers.
- **Space Complexity:** $O(U)$ in-process memory, where $U$ is the number of active distinct client keys stored in the JavaScript `Map`. Inactive client keys are retained until explicit `reset()`.

---

### 2.6 Multi-Instance Consistency Limitations

The in-memory implementation (`InMemoryTokenBucketRateLimiter`) operates purely within a single Node.js process:

- It **cannot** coordinate token consumption across multiple application instances.
- In a horizontally scaled cluster of $N$ nodes behind a load balancer, each instance maintains an independent bucket. A client's effective burst capacity multiplies by $N$ ($N \times B$), and the aggregate sustained rate multiplies by $N$ ($N \times r / I$).

---

### 2.7 Architectural Sketch: Requirements for an Atomic Redis Token Bucket (Not Implemented)

To enforce Token Bucket rate limiting across a distributed cluster, state must be coordinated in Redis:

1. **Redis State Representation:**
   Stored as a Redis Hash with two fields per client:
   - `t`: current floating-point token count (string representation of float).
   - `last`: Redis server epoch timestamp in milliseconds when tokens were last refilled.
2. **Atomic Lua Script (`EVAL`):**
   - Single declared key: `KEYS[1] = ratelimit:tokenbucket:{clientId}`.
   - Authoritative time: reads Redis server time via `redis.call('TIME')`.
   - Script performs:
     $$\Delta t = \max(0, \text{nowMs} - \text{storedLast})$$
     $$\text{refilled} = \min(B, \text{storedTokens} + \Delta t \times (r / I))$$
   - Tests `refilled >= cost`. If allowed, updates `t = refilled - cost` and `last = nowMs`.
3. **Automatic Expiration (`PEXPIREAT`):**
   - Sets absolute expiration to the timestamp when the bucket will be completely full:
     $$\text{PEXPIREAT} = \text{nowMs} + \left\lceil (B - \text{tokens}) \times \left(\frac{I}{r}\right) \right\rceil$$
   - Inactive client keys automatically expire in Redis without memory retention leaks.
4. **Scope Confirmation:**
   Per the Phase 09 specification, this Redis architecture is documented for reference but **explicitly not implemented** in this phase.
