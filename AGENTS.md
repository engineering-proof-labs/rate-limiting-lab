# AGENTS.md — Rate Limiting Laboratory

Welcome to the **Rate Limiting Lab** repository (`engineering-proof-labs/rate-limiting-lab`).  
This document defines architectural standards, engineering principles, and operational rules for AI agents and human contributors working within this codebase.

---

## 1. Laboratory Mission & Scope

This repository is a production-grade, public engineering laboratory demonstrating resilient, high-concurrency rate limiting architectures built with **TypeScript**, **Node.js**, and **Redis**.

The lab's purpose is not merely academic theory, but **production proof**:

- Real-world distributed concurrency safety (zero race conditions).
- Measurable throughput and latency benchmarks.
- Exhaustive verification suites simulating burst traffic, distributed clients, and clock drift.
- Transparent architectural decision records (ADRs) evaluating tradeoffs between memory, precision, and CPU overhead.

---

## 2. Workspace & Git Isolation Rules

1. **Autonomous Repository:**
   - This repository is independently versioned and tracked under `git@github.com:engineering-proof-labs/rate-limiting-lab.git`.
   - Never import, reference, require, or leak files or dependencies from any parent or sibling folders outside this repository root.
2. **Local Agent Ignored:**
   - Any local `.agents/` directory created inside this repository is git-ignored.
   - All shared guidelines for AI pair programmers must be committed directly to this `AGENTS.md` file.
3. **Clean Commit History:**
   - Follow [Conventional Commits](https://www.conventionalcommits.org/):
     - `feat:`, `fix:`, `docs:`, `refactor:`, `perf:`, `test:`, `chore:`, `ci:`.
   - Keep commits atomic and self-contained.
4. **Shared Engineering Standard (Local Development Only):**
   - Development agents working within this workspace should consult the shared engineering standards in `../ENGINEERING_VOICE.md` (or `../.agents/standards/ENGINEERING_VOICE.md`) when available.
   - _Precedence & Build Isolation:_ Public builds, test runners, and CI workflows must **never** depend on this external document. If the shared guidance ever conflicts with repository specifications (`SPEC.md`), architectural records (ADRs), or `AGENTS.md`, project-specific contracts take precedence.

---

## 3. Engineering & Architectural Standards

### 3.1 Rate Limiting Algorithms

The core algorithm scope is strictly focused on:

1. **Fixed Window Counter:** Minimal memory footprint baseline; demonstrates boundary spike tradeoffs.
2. **Token Bucket:** Smooth sustained load while permitting defined burst capacity.
3. **Sliding Window Log:** Maximum precision with timestamp logs, evaluating memory vs accuracy tradeoffs.
4. **Sliding Window Counter:** Approximation using weighted counts across adjacent windows for low memory and high throughput.

_Scope Note:_ Leaky Bucket may be documented as a potential future extension, but is NOT mandatory. Do not expand algorithm scope without explicit authorization.

### 3.2 Concurrency & Distributed State

- **Atomic Admission Decisions:** All rate limiting checks and counter updates must be strictly atomic to eliminate race conditions under concurrent load. The architectural design phase (Phase 03) will evaluate Redis primitives, transactions, Lua scripts, and their respective operational tradeoffs. Every chosen implementation mechanism must be explicitly justified by correctness requirements.
- **Fail-Closed vs Fail-Open Policies:** When the distributed backing store (Redis) is unreachable or times out, the initial default policy is **fail-closed** (rejecting admission to protect downstream services, returning a 5xx service outage rather than quota exhaustion). A **fail-open** policy must also be supported as a separately configurable option. Both behaviors must be explicitly documented and covered by automated test suites. Importantly, Redis unavailability is a dependency outage and must never be treated as equivalent to quota exhaustion (HTTP 429 is reserved exclusively for quota exhaustion).
- **HTTP Header Contract:** The initial demonstration will use the established de facto conventions:
  - `X-RateLimit-Limit`
  - `X-RateLimit-Remaining`
  - `X-RateLimit-Reset`
  - `Retry-After` (sent on HTTP 429 responses)
    _Note:_ These legacy X-prefixed headers represent widely adopted ecosystem conventions rather than an official universal HTTP standard. Exact semantics, reset units (e.g., Unix timestamp vs seconds remaining), and required response conditions will be formalized during Phase 03. Any alternative header convention must be explicitly documented and tested rather than silently introduced.

### 3.3 TypeScript & Code Quality

- **Strict TypeScript:** Enforce `strict: true`, `noImplicitAny: true`, and `exactOptionalPropertyTypes`.
- **Minimal Abstractions & No Speculative Complexity:** Keep components focused and lean. Avoid premature generalizations, unnecessary indirection, or bloated dependency trees.
- **Deterministic Testing & Honest Verification:**
  - Fast unit tests using virtual/fake clocks for deterministic time-window calculations.
  - High-concurrency integration tests verifying that concurrent requests (`Promise.all`) trigger exact allowed vs throttled counts.

---

## 4. Verification Workflow

Before proposing or committing changes:

1. Ensure TypeScript builds without errors: `npm run build` or `npx tsc --noEmit`.
2. Run test suites: `npm test`.
3. Verify concurrency tests pass under load without intermittent race conditions or flaky assertions.
