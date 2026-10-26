# Algorithm Comparison: Rate Limiting Strategies & Tradeoffs

**Repository:** `engineering-proof-labs/rate-limiting-lab`
**Phase:** 10 — Sliding Window Log & Sliding Window Counter

---

## 1. Overview & Comparative Matrix

Rate limiting algorithms trade off four fundamental engineering concerns:

1. **Precision:** How accurately does the algorithm restrict requests within an arbitrary rolling interval of duration $W$?
2. **Memory Footprint:** How much state must be retained in RAM per active client identity?
3. **Burst Dynamics:** Does the algorithm allow bursts, smooth them, or permit boundary spikes?
4. **Distributed Coordination Overhead:** What primitives and network round-trips are required when backed by a distributed store (e.g. Redis)?

The table below summarizes the operational characteristics of the four algorithms implemented in this laboratory:

| Dimension                          | Fixed Window Counter                            | Token Bucket                                   | Sliding Window Log                                       | Sliding Window Counter                                       |
| :--------------------------------- | :---------------------------------------------- | :--------------------------------------------- | :------------------------------------------------------- | :----------------------------------------------------------- |
| **Mathematical Basis**             | Discrete epoch buckets: $\lfloor t / W \rfloor$ | Continuous accrual: $\Delta t \times (r / I)$  | Exact timestamp history in $(t - W, t]$                  | Weighted sum of adjacent windows                             |
| **Rolling Window Accuracy**        | Coarse (epoch-aligned)                          | Continuous rate + burst capacity               | **Exact** ($0\%$ error)                                  | **Weighted approximation** ($O(1)$)                          |
| **In-Memory Space Complexity**     | $O(1)$ (1 counter, 1 window ID)                 | $O(1)$ (tokens float, refill timestamp)        | $O(L)$ (array of up to $L$ timestamps)                   | $O(1)$ (2 counters, 1 window ID)                             |
| **Time Complexity (Admission)**    | $O(1)$ arithmetic                               | $O(1)$ arithmetic                              | $O(L)$ pruning & append                                  | $O(1)$ arithmetic                                            |
| **Boundary Spike Vulnerability**   | **High:** Up to $2 \times L$ across boundaries  | None (burst capped strictly at capacity $B$)   | **None** (strict rolling window enforcement)             | **Low:** Smoothed (slight variance under non-uniform bursts) |
| **Distributed Complexity (Redis)** | Minimal: Atomic Lua script or `INCR` + `EXPIRE` | Moderate: Lua script reading server `TIME`     | High: Redis `ZSET` (`ZREMRANGEBYSCORE`, `ZCARD`, `ZADD`) | Low to Moderate: Hash with 2 counters                        |
| **Primary Failure / Edge Case**    | Double-quota burst at window boundary           | Arithmetic underflow on extreme configurations | High memory under large quota limits ($L \gg 10^4$)      | Over/under-throttling on skewed previous-window traffic      |

---

## 2. Detailed Algorithm Profiles

### 2.1 Fixed Window Counter

- **Mechanism:** Time is partitioned into fixed non-overlapping intervals of duration $W$ aligned to the Unix epoch ($\text{windowId} = \lfloor t / W \rfloor$). Each client maintains an integer counter within the current window.
- **Burst Semantics & Vulnerability:**
  Because the window resets instantly at epoch boundaries, a client can exhaust its full quota $L$ at the very end of window $k$ (e.g. $t = 59.9\text{s}$) and immediately fire another $L$ requests at the start of window $k+1$ (e.g. $t = 60.1\text{s}$). Across this rolling 200 ms interval, $2 \times L$ requests are admitted, doubling the intended traffic load on downstream systems.
- **Memory & Storage:**
  Requires only a single integer per client. In Redis, keys naturally expire at the end of the window via `PEXPIREAT`.
- **Ideal Workloads:**
  Coarse protection tiers, low-resource internal tools, and high-throughput endpoints where downstream services can withstand double-quota boundary spikes.

---

### 2.2 Token Bucket

- **Mechanism:** Tokens accumulate continuously in a bucket of capacity $B$ at refill rate $r$ per interval $I$. Each admitted request consumes $K$ tokens (default: 1). Refill is computed lazily upon arrival based on elapsed time since the last deduction:
  $$\Delta \text{tokens} = (t_{\text{now}} - t_{\text{last}}) \times \left(\frac{r}{I}\right)$$
- **Burst Semantics:**
  Explicitly accommodates bursts up to capacity $B$. Once capacity is exhausted, admission is strictly throttled to the sustained refill rate $r / I$. Unlike Fixed Window, there is no boundary reset phenomenon—tokens refill smoothly over time.
- **Memory & Storage:**
  Requires storing only the current token balance and the timestamp of the last deduction ($O(1)$ per client).
- **Ideal Workloads:**
  APIs serving human-driven web applications or batch clients where burst traffic (e.g., initial page load requesting 10 assets in parallel) is legitimate, but sustained high-frequency polling must be constrained.

---

### 2.3 Sliding Window Log

- **Mechanism:** Maintains a log of timestamps for all admitted requests per client. Upon request arrival at $t_{\text{now}}$, timestamps older than $t_{\text{now}} - W$ are pruned. If the remaining count is less than $L$, the current timestamp $t_{\text{now}}$ is appended and the request is admitted.
- **Rolling Window Accuracy:**
  **Exact.** By checking every recorded timestamp against the moving boundary $(t_{\text{now}} - W, t_{\text{now}}]$, no sliding interval of duration $W$ can ever exceed $L$ admitted requests. Boundary spikes are eliminated.
- **Memory Hygiene & Worst-Case Bounds:**
  - Because rejected requests are **not** appended to the log, memory consumption for an active client is strictly bounded by $L$ timestamps ($O(L)$ numbers).
  - However, for large limits (e.g., $L = 50,000$ requests per minute across $100,000$ users), storing $5 \times 10^9$ 64-bit integers in memory represents substantial overhead compared to counter-based algorithms.
- **Distributed Implementation Tradeoffs:**
  In Redis, Sliding Window Log requires a Sorted Set (`ZSET`) where scores and members are timestamps. Each admission check executes `ZREMRANGEBYSCORE`, `ZCARD`, and `ZADD` within an atomic Lua script. Under heavy concurrency, `ZSET` operations impose higher memory and CPU utilization on Redis than integer increments.
- **Ideal Workloads:**
  Low-limit, security-critical endpoints where exact enforcement is mandatory: login attempts (e.g., 5 attempts per 15 minutes), credit card payment processing, SMS verification triggers, and password reset requests.

---

### 2.4 Sliding Window Counter

- **Mechanism:** Combines the low memory footprint of Fixed Window with the boundary smoothing of Sliding Window Log by computing a weighted average across the current and preceding fixed windows:
  $$\text{timeInCurrentWindow} = t_{\text{now}} \pmod W$$
  $$\text{previousWeight} = \frac{W - \text{timeInCurrentWindow}}{W}$$
  $$\text{estimatedCount} = C_{\text{previous}} \times \text{previousWeight} + C_{\text{current}}$$
- **Mathematical Approximation & Edge Cases:**
  Sliding Window Counter assumes that requests in the previous window were uniformly distributed across time. When traffic deviates from uniformity, estimation error arises:
  1. **Under-throttling (False Negative):** If all requests in the previous window occurred in the final millisecond before the boundary, those requests are heavily discounted by $\text{previousWeight}$ in the new window, allowing an edge burst slightly higher than limit $L$.
  2. **Over-throttling (False Positive):** If all requests in the previous window occurred in the first millisecond, they have physically expired by the middle of the current window, but the counter continues to count a fraction of them, rejecting requests that would be admitted under an exact log.
- **Memory & Storage:**
  Requires only two integer counters ($C_{\text{previous}}, C_{\text{current}}$) and a window identifier ($O(1)$ per client).
- **Ideal Workloads:**
  High-scale public APIs, microservice mesh gateways, and edge proxies (e.g. Cloudflare) where processing millions of requests per second requires minimal memory per client and near-$O(1)$ CPU overhead, and a bounded approximation error ($\le 5-10\%$) is entirely acceptable.

---

## 3. Decision Guide: Selecting the Right Algorithm

```
                             Do you need strict exact precision?
                                    /                 \
                                  Yes                  No
                                 /                       \
             Is the limit L small (e.g. L <= 100)?       Do you need to support
                 /                     \                  burst capacity?
               Yes                      No                 /          \
              /                          \               Yes           No
     [Sliding Window Log]         [Sliding Window Counter] /             \
   (Exact, bounded memory)         (O(1) memory, smoothed) [Token Bucket] [Fixed Window]
                                                          (Bursts + rate) (Baseline O(1))
```
