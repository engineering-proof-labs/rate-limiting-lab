# Scenario 03: Distributed State & Clock Authority

**Status:** Implemented and Tested  
**Category:** Time Authority & Distributed Synchronization  
**Repository:** `engineering-proof-labs/rate-limiting-lab`

---

## 1. Original System Contract & Assumptions

In single-process or loosely coupled rate limiters, time is derived from the application runtime via `Date.now()`.
The application calculates the fixed window identifier:
$$\text{windowId} = \left\lfloor \frac{\text{Date.now()}}{W} \right\rfloor$$
and passes this `windowId` (or derived key) to the storage backend.

---

## 2. Newly Introduced Constraint

Multiple application instances run across different virtual machines or container nodes in cloud infrastructure. Clock synchronization between machines relies on NTP (Network Time Protocol), which exhibits clock skew, jitter, and periodic stepped backward/forward adjustments (often $\pm 50\text{–}200\text{ ms}$).

---

## 3. Invalidated Assumptions

1. **Uniform Time Authority:** Independent application hosts do not agree on physical wall-clock time.
2. **Boundary Coherence:** If Node A's clock is 100 ms ahead of Node B's clock, requests arriving physically at the same instant near a window boundary are partitioned into different windows:
   - Node A maps a request at physical $t = 59.95\text{s}$ to Window $1$ ($t_A = 60.05\text{s}$).
   - Node B maps a concurrent request to Window $0$ ($t_B = 59.95\text{s}$).
   - Clients exploit this clock skew to receive double allowances across the boundary.

---

## 4. Evaluated Alternatives

### Alternative A: Application-Supplied Timestamp (`Date.now()`)

- **Mechanism:** Each Express node passes its local `Date.now()` into Redis as an argument to the rate-limiting script.
- **Tradeoffs:**
  - _Advantages:_ Simple code; zero Redis time query overhead.
  - _Disadvantages:_ Fails completely under clock drift. Susceptible to local VM time pauses (e.g. hypervisor freezes, GC pauses) creating fragmented window keys and double quotas.

### Alternative B: Centralized Redis Server Time Authority (`redis.call('TIME')`)

- **Mechanism:** The atomic Lua script inside Redis queries the Redis server's own clock via `redis.call('TIME')` and uses this microsecond-accurate server timestamp as the sole authority for window calculation and expiration.
- **Tradeoffs:**
  - _Advantages:_ Single authoritative timeline across all application instances. Complete immunity to client-tier clock drift, hypervisor pauses, or desynchronized NTP daemons on app hosts.
  - _Disadvantages:_ `redis.call('TIME')` is evaluated inside the Lua script. Redis server time itself must be kept stable via disciplined NTP (e.g., chrony with slew mode to prevent backward jumps).

---

## 5. Explicit Tradeoffs & Recommended Choice

**Selected: Alternative B (Redis Server Time Authority).**

Eliminating client-tier clock drift is essential for multi-instance correctness. All distributed window epoch calculations and `PEXPIREAT` deadlines are derived exclusively from `redis.call('TIME')`.

---

## 6. Expected Failure Modes & Operational Limitations

1. **Redis Host NTP Step Adjustments:** If the underlying Redis host experiences an abrupt backward clock step (rather than gradual slewing), window expiration deadlines can be delayed until the clock catches up.
2. **Read-Replica Skew:** In active-active multi-master Redis setups (not used in this lab), clock drift between separate Redis instances requires global consensus.

---

## 7. Executable Acceptance Criteria

1. Two independent Redis clients with distinct network connections executing `incrementAndCheck` must receive consistent window IDs and reset deadlines governed by Redis server time.
2. Simulating application-tier time discrepancies must not alter window boundaries or allow quota inflation in Redis.

---

## 8. Existing Tests & Verification Paths

- **Redis Integration Suite:** [`tests/integration/redis-fixed-window.test.ts`](file:///c:/Users/bruno/CV%20Manager/engineering-labs/rate-limiting-lab/tests/integration/redis-fixed-window.test.ts)
  - Section: `Independent Redis Clients (Separate TCP Connections)`
  - Test case: `strictly isolates and synchronizes two independent clients against Redis server time`

---

## 9. Missing Tests & Proposed Experiments

- **Proposed Test:** Fault-injection test simulating host clock skew via container clock adjustments during live traffic to confirm immunity of Redis-governed admission.

---

## 10. Implementation Status

**Label:** `implemented/tested`
