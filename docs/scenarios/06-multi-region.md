# Scenario 06: Multi-Region Deployments, WAN Latency & Global Consistency Tradeoffs

**Status:** Documented Design  
**Category:** Distributed Systems & Cross-Region Coordination  
**Repository:** `engineering-proof-labs/rate-limiting-lab`

---

## 1. Original System Contract & Assumptions

In Phases 06 through 08, distributed rate limiting relied on a single primary Redis instance:

- All application instances across all availability zones communicated with one central Redis node within a single cloud region (e.g., `us-east-1`).
- Round-trip latency between application instances and Redis was $< 2\text{ ms}$ over high-speed intra-datacenter networks.
- A single master clock (`redis.call('TIME')`) provided total temporal ordering for all window calculations.

---

## 2. Newly Introduced Constraint

The service expands to a globally distributed multi-region topology spanning three continents:

- Region A: `us-east-1` (North America)
- Region B: `eu-central-1` (Europe)
- Region C: `ap-southeast-1` (Asia-Pacific)

Clients connect to their geographically closest region via Anycast DNS or Cloudflare/AWS Global Accelerator to achieve sub-50 ms response times.

---

## 3. Invalidated Assumptions

1. **Low-Latency Centralization:** Cross-continental network round-trips introduce severe physical speed-of-light latencies:
   - `eu-central-1` $\leftrightarrow$ `us-east-1`: $\approx 80\text{–}100\text{ ms}$ RTT.
   - `ap-southeast-1` $\leftrightarrow$ `us-east-1`: $\approx 180\text{–}220\text{ ms}$ RTT.
     Directly querying a central Redis primary on every request destroys the edge latency benefits of multi-region deployment.
2. **Synchronous Global Consensus:** Under the CAP theorem, when a trans-oceanic network partition severs communication between regions, the system cannot simultaneously guarantee:
   - **Consistency ($C$):** Strict global enforcement of quota $L$ across all regions.
   - **Availability ($A$):** Zero-downtime request admission for partitioned regions without waiting for cross-region synchronization.

---

## 4. Evaluated Architectural Models

### Model 1: Central Authoritative Redis Primary (Global Single-Master)

- **Mechanism:** A single Redis primary is deployed in `us-east-1`. Application clusters in Europe and Asia route every rate limit check across the WAN to the US primary.
- **Tradeoffs:**
  - _Advantages:_ Exact global consistency. No risk of overspending quota. Simple operational model.
  - _Disadvantages:_ Massive latency penalty ($+100\text{–}200\text{ ms}$ on every API call in EU/APAC). If the transatlantic fiber severs, all non-US regions immediately halt (in fail-closed mode) or lose rate limiting entirely (in fail-open mode).

### Model 2: Preallocated Regional Budgets (Static Slicing)

- **Mechanism:** The global quota $L$ is statically partitioned into regional quotas based on historical traffic distribution (e.g., $L = 100$ is sliced into: US = 50, EU = 30, APAC = 20). Each region enforces its local budget against a local Redis cluster with $< 1\text{ ms}$ latency.
- **Tradeoffs:**
  - _Advantages:_ Zero cross-region WAN latency on the request path. Full regional partition survivability.
  - _Disadvantages:_ **Stranded Budget Problem.** If a user sends 40 requests in Europe and then travels to Asia (or sends automated batch traffic exclusively in Asia), their requests in Asia are rejected after 20 calls even though 50 units of quota sit completely idle and unused in the US slice.

### Model 3: Dynamic Lease Allocation with Fencing (Lease Balancing)

- **Mechanism:** A central coordinator leases token blocks (e.g. chunks of 20 tokens) to regional Redis instances with an expiration lease time (e.g., 30 seconds). Regions consume from their local lease. When a regional lease drops below a threshold, it asynchronously requests an additional batch from the global coordinator.
- **Tradeoffs:**
  - _Advantages:_ Low local latency; adjusts to uneven client traffic without static fragmentation.
  - _Disadvantages:_ Complexity. Requires lease renewal protocols, fencing tokens to prevent stale leases during network partitions, and grace periods that risk temporary overspending if a partitioned region continues admitting on an un-revoked lease.

### Model 4: Asynchronous Counter Replication / CRDTs (Eventual Consistency)

- **Mechanism:** Each region admits requests against local Redis and asynchronously broadcasts delta increments (`INCRBY`) to peer regions using Redis Enterprise Active-Active (CRDTs) or an event mesh.
- **Tradeoffs:**
  - _Advantages:_ Local read/write latency ($< 1\text{ ms}$). High availability during partitions.
  - _Disadvantages:_ **Bounded Overspend Risk.** Replication delay across WAN ($\approx 100\text{–}300\text{ ms}$) permits concurrent bursts to exceed global limit $L$ by up to $N_{\text{regions}} \times L_{\text{burst}}$ before remote increments reconcile.

---

## 5. Explicit Tradeoffs & Recommended Choice

**Selected Strategy: Workload-Driven Selection.**

| Workload Requirement                             | Recommended Multi-Region Architecture                     | Justification                                                                                                                                             |
| :----------------------------------------------- | :-------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Strict Security / Financial (Zero Overspend)** | **Model 1: Central Master** or **Regionally Pinned Keys** | Pin tenant data to an authoritative home region via Anycast routing; cross-region requests route back to the home region.                                 |
| **High-Volume Public APIs / Microservices**      | **Model 4: Asynchronous CRDT Replication**                | Low latency ($< 1\text{ ms}$) is prioritized over exact boundary enforcement. Transient overspend during the 150 ms synchronization window is acceptable. |

---

## 6. The Fundamental Impossibility Proof: CAP in Global Rate Limiting

There is **no free architecture** that simultaneously delivers:

1. Strict global coordination ($\le L$ aggregate requests admitted across all continents).
2. Uninterrupted independent availability during a WAN partition.
3. Sub-millisecond edge latency without cross-region round trips.

If Region C is cut off from Regions A and B:

- If Region C admits requests independently, it risks overspending the global quota when communication restores (**violating consistency**).
- If Region C refuses to admit requests until it reaches Regions A and B, it blocks local traffic (**violating availability**).
- If Region C queries Region A synchronously, it pays an unavoidable physical latency penalty (**violating latency SLAs**).

---

## 7. Implementation Boundary & Testing Truthfulness

> [!IMPORTANT]
> **Laboratory Truthfulness Notice:** The Docker environment in this laboratory runs a single Redis instance on `localhost:6379`. It demonstrates single-region multi-instance coordination, but does **NOT** simulate or prove cross-region WAN replication, BGP Anycast routing, or network partition reconciliation. This scenario document defines the production architectural evaluation and design constraints without fabricating unverified multi-datacenter test evidence.

---

## 8. Existing Tests & Verification Paths

- Local multi-client Redis integration tests: [`tests/integration/redis-fixed-window.test.ts`](file:///c:/Users/bruno/CV%20Manager/engineering-labs/rate-limiting-lab/tests/integration/redis-fixed-window.test.ts)
- In-memory reference suites: [`tests/unit/fixed-window.test.ts`](file:///c:/Users/bruno/CV%20Manager/engineering-labs/rate-limiting-lab/tests/unit/fixed-window.test.ts), [`tests/unit/token-bucket.test.ts`](file:///c:/Users/bruno/CV%20Manager/engineering-labs/rate-limiting-lab/tests/unit/token-bucket.test.ts), [`tests/unit/sliding-window.test.ts`](file:///c:/Users/bruno/CV%20Manager/engineering-labs/rate-limiting-lab/tests/unit/sliding-window.test.ts)

---

## 9. Missing Tests & Proposed Experiments

- **Proposed Simulation:** Chaos mesh experiment injecting synthetic 150 ms latency and 50% packet drops between simulated Redis regional clusters to quantify overspend margins under asynchronous replication.

---

## 10. Implementation Status

**Label:** `documented design`
