# Test Coverage & Verification Matrix — Rate Limiting Laboratory

**Document Version:** 1.5.0  
**Phase:** 08 — Concurrency & Failure Resilience  
**Repository:** `engineering-proof-labs/rate-limiting-lab`

---

## 1. Test Strategy Overview & Clock Boundaries

Verification is organized into three distinct tiers with clear clock boundaries:

1. **Tier 1 — In-Memory Unit Tests (`tests/unit/`):** Test pure algorithm math, window transitions, boundary points, and counter saturation using `VirtualClock`. Operates purely in-process with zero network or daemons.
2. **Tier 2 — Assembled HTTP Contract Tests (`tests/contract/`):** Test the full Express application with `supertest`. Verifies routing, middleware wiring, header formatting, fail-closed 503 behavior, fail-open delegation, high-concurrency burst traffic, cross-instance coordination, and transient storage outage recovery. (Verified: Phase 07 & Phase 08).
3. **Tier 3 — Redis Concurrency & Integration Tests (`tests/integration/`):** Requires real Redis instance. **VirtualClock does NOT control Redis time.** Uses real elapsed time (leveraging the 1,000 ms fast regression fixture) or programmatic `reset()` to verify atomic admissions and server-time coordination under concurrent load (`Promise.all`). (Verified: Phase 06).

---

## 2. Requirements to Test Case Mapping

| ID         | Specification Requirement              | Test Tier                | Concrete Test Case Reference                                                                                                                                                        | Status                                     |
| :--------- | :------------------------------------- | :----------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------- |
| **REQ-01** | Standard Quota Admission               | Unit & Integration       | `tests/unit/fixed-window.test.ts` & `tests/integration/redis-fixed-window.test.ts`                                                                                                  | **Verified** (Unit & Redis Integration)    |
| **REQ-02** | Exact 5-Request Boundary & Saturation  | Unit & Integration       | `tests/unit/fixed-window.test.ts` & `tests/integration/redis-fixed-window.test.ts`                                                                                                  | **Verified** (Unit & Redis Integration)    |
| **REQ-03** | Window Transition & Counting           | Unit & Integration       | `tests/unit/fixed-window.test.ts` & `tests/integration/redis-fixed-window.test.ts`                                                                                                  | **Verified** (Unit & Redis Integration)    |
| **REQ-04** | Client Key Isolation                   | Unit & Integration       | `tests/unit/fixed-window.test.ts` & `tests/integration/redis-fixed-window.test.ts`                                                                                                  | **Verified** (Unit & Redis Integration)    |
| **REQ-05** | Header Field Existence & Casing        | Contract                 | `tests/contract/http-contract.test.ts` > _"admits requests within quota and returns HTTP 200 with standard rate limit headers"_                                                     | **Verified** (HTTP Contract)               |
| **REQ-06** | Header Misspelling Prevention          | Contract                 | `tests/contract/http-contract.test.ts` > _"admits requests within quota..."_ (Misspelling guard assertions)                                                                         | **Verified** (HTTP Contract)               |
| **REQ-07** | `Retry-After` Emission Condition       | Contract                 | `tests/contract/http-contract.test.ts` > _"admits exactly 5 requests and throttles the 6th with HTTP 429 and Retry-After"_                                                          | **Verified** (HTTP Contract)               |
| **REQ-08** | Route Mounting & Double-Prefix Guard   | Contract                 | `tests/contract/http-contract.test.ts` > _"prevents route mounting bugs: /limited, /api/limited, and double-prefix /api/api/v1 return 404"_                                         | **Verified** (HTTP Contract)               |
| **REQ-09** | Unthrottled Route Immunity             | Contract                 | `tests/contract/http-contract.test.ts` > _"exposes GET /api/v1/unlimited unthrottled and without consuming quota"_                                                                  | **Verified** (HTTP Contract)               |
| **REQ-10** | Healthcheck Immunity                   | Contract                 | `tests/contract/http-contract.test.ts` > _"exposes GET /health unthrottled and without rate limit headers"_                                                                         | **Verified** (HTTP Contract)               |
| **REQ-11** | Fail-Closed Policy on Redis Outage     | Integration & Contract   | `tests/contract/http-contract.test.ts` > _"defaults to fail-closed returning HTTP 503 Service Unavailable when failurePolicy is omitted"_                                           | **Verified** (HTTP Contract & Storage)     |
| **REQ-12** | Fail-Open Policy on Redis Outage       | Contract                 | `tests/contract/http-contract.test.ts` > _"delegates to route handler when configured with fail-open and sets diagnostic header"_                                                   | **Verified** (HTTP Contract)               |
| **REQ-13** | Distributed Concurrency Safety         | Integration (Real Redis) | `tests/integration/redis-fixed-window.test.ts` > _"strictly admits exactly 5 and rejects 15 under 20 concurrent requests..."_                                                       | **Verified** (Redis Integration)           |
| **REQ-14** | Fast Regression Fixture (1,000 ms)     | Unit, Integration & HTTP | `tests/unit/fixed-window.test.ts`, `tests/integration/`, & `tests/contract/http-contract.test.ts`                                                                                   | **Verified** (All Tiers)                   |
| **REQ-15** | Redis Server Time Coordination         | Integration (Real Redis) | `tests/integration/redis-fixed-window.test.ts` > _"Independent Redis Clients (Separate TCP Connections)"_                                                                           | **Verified** (Redis Integration)           |
| **REQ-16** | HTTP Concurrent Quota Sharing          | Contract (Supertest)     | `tests/contract/http-concurrency-resilience.test.ts` > _"strictly admits exactly 5 and throttles 15 across 20 concurrent HTTP requests..."_                                         | **Verified** (HTTP Contract & Concurrency) |
| **REQ-17** | Multi-App Cross-Instance Coordination  | Contract (Supertest)     | `tests/contract/http-concurrency-resilience.test.ts` > _"collectively admits exactly 5 and throttles 15 across 20 concurrent requests split between two independent app instances"_ | **Verified** (HTTP Contract & Concurrency) |
| **REQ-18** | Untrusted Identity Headers Defense     | Contract (Supertest)     | `tests/contract/http-concurrency-resilience.test.ts` > _"proves that arbitrary X-Forwarded-For, X-Real-IP, and client identity headers cannot evade IP quota"_                      | **Verified** (HTTP Contract & Security)    |
| **REQ-19** | Tenant Quota Isolation under Burst     | Contract (Supertest)     | `tests/contract/http-concurrency-resilience.test.ts` > _"maintains strict quota isolation between two distinct clients submitting concurrent bursts"_                               | **Verified** (HTTP Contract & Concurrency) |
| **REQ-20** | Window Rollover under Concurrent Burst | Contract (Supertest)     | `tests/contract/http-concurrency-resilience.test.ts` > _"handles concurrent bursts across window expiration with exact quota reset"_                                                | **Verified** (HTTP Contract & Concurrency) |
| **REQ-21** | Real Infrastructure Outage Resilience  | Contract (Supertest)     | `tests/contract/http-concurrency-resilience.test.ts` > _"returns HTTP 503... when Redis connection is refused"_ & command-level rejection                                           | **Verified** (HTTP Contract & Resilience)  |
| **REQ-22** | Transient Outage Self-Healing Recovery | Contract (Supertest)     | `tests/contract/http-concurrency-resilience.test.ts` > _"recovers immediately and resumes exact quota enforcement when storage returns after an outage"_                            | **Verified** (HTTP Contract & Resilience)  |

> [!NOTE]
> **Boundary Notice:** Tier 1 in-memory tests prove deterministic mathematical algorithm correctness and state transitions for single-process Node.js execution. Tier 2 contract and Tier 3 Redis integration tests prove real distributed race safety, atomic admission, and shared server-time coordination across independent limiter instances on a healthy Redis primary. Neither tier substitutes for failover durability testing across asynchronous replication replicas.

---

## 3. Regression Scenarios Specifically Guarded

```mermaid
flowchart TD
    subgraph Regression Prevention Suite
        R1[Reg-01: Bypassed Middleware] -->|Assert| A1[Unit test passes != App passes;\nApp test verifies middleware execution]
        R2[Reg-02: Route Double-Mounting] -->|Assert| A2[GET /api/v1/limited returns 200;\nGET /api/api returns 404]
        R3[Reg-03: Header Spelling Bugs] -->|Assert| A3[Assert exact hyphenated name:\nX-RateLimit-Reset != XRateLimit-Reset]
        R4[Reg-04: Off-By-One Accounting] -->|Assert| A4[Strict check: Request 5 is 200 remaining 0;\nRequest 6 is 429]
        R5[Reg-05: Reset Drop Bug] -->|Assert| A5[New window admits AND counts request 1;\nremaining is 4, NOT 5]
        R6[Reg-06: Outage vs Quota Confusion] -->|Assert| A6[Redis crash returns 503 Service Unavailable;\nNEVER returns 429]
        R7[Reg-07: Clock Drift Fragility] -->|Assert| A7[Redis server time governs distributed windows;\nLocal clock skew cannot fragment keys]
        R8[Reg-08: Header Spoofing Evading Quota] -->|Assert| A8[Default mode anchors to IP;\nRotating X-Forwarded-For cannot evade quota]
        R9[Reg-09: Unmetred Route Contamination] -->|Assert| A9[Unrestricted routes never invoke consume();\nzero quota leakage on /health]
        R10[Reg-10: Self-Healing Recovery] -->|Assert| A10[Transient outage recovers without process restart;\nexact remaining count resumes]
    end
```

---

## 4. Test Execution Profiles & Toolchain Requirements

- **Runner:** Vitest (fast native ESM execution).
- **HTTP Engine:** Supertest against assembled Express app.
- **Clock Mocking:** Explicit dependency injection of `VirtualClock` for in-memory algorithm tests only.
- **Redis Fixture:** Docker container (`redis:7-alpine`) on `localhost:6379`. Tests skip or fail gracefully with clear diagnostics if Redis daemon is not detected.
