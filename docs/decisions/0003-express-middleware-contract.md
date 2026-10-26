# ADR 0003: Express Rate Limit Middleware, Routing Topologies & Error Handling

**Status:** Accepted
**Date:** 2026-10-26
**Context:** Phase 07 — Express HTTP Middleware, Router & Contract Compliance

---

## 1. Context & Problem Statement

Phase 05 and Phase 06 established the core algorithm and Redis distributed storage layer.
Phase 07 requires exposing the rate-limiting functionality over HTTP using Express while:

1. Adhering to the exact HTTP header and status code specifications established in `SPEC.md`.
2. Preventing common middleware mounting bugs, double-prefixes (e.g. `/api/api`), and accidental route leakage.
3. Defining a deliberate client identity resolution strategy that validates input and rejects malformed values.
4. Implementing fail-closed (default) and fail-open policies during backing store outages without conflating outages with quota exhaustion.

---

## 2. Decision Log

### 2.1 Route Architecture & Mandatory Limiter Protection

- **Routes:**
  - `GET /health`: Liveness probe. Completely bypasses rate limiting; returns `200 OK` `{"status": "ok"}` with no rate-limit headers.
  - `GET /api/v1/unlimited`: Unthrottled control route mounted on the API router; returns `200 OK` `{"success": true, "message": "Unlimited endpoint"}` with no rate-limit headers.
  - `GET /api/v1/limited`: Protected endpoint guarded by `createRateLimitMiddleware`. Returns `200 OK` when admitted; returns `429 Too Many Requests` when quota is exhausted.
- **Mandatory Limiter Protection:** `createApp()` strictly requires a valid `RateLimiter` instance. If omitted, it immediately throws a runtime error. This ensures a supposedly rate-limited route can never be accidentally or silently exposed without its limiter configured.
- **Mounting Invariant:** API routes are mounted strictly on `/api/v1`. Calling `/limited`, `/api/limited`, or `/api/api/v1/limited` returns `404 Not Found`, guarding against silent route nesting bugs.

### 2.2 Client Identity Strategy: Secure IP Default vs Opt-In Demo Headers

- **Default Secure Mode (Connection IP Anchoring):**
  - By default, client keys resolve strictly to the TCP remote socket IP address (`ip:${req.ip ?? req.socket.remoteAddress ?? '127.0.0.1'}`).
  - Caller-supplied identity headers (`X-Demo-Client-Id`, `X-Client-Id`, `X-Forwarded-For`) are completely ignored by default. This eliminates quota bypass attacks where clients rotate arbitrary unauthenticated headers.
- **Opt-In Demo Headers (`enableDemoHeaders: true`):**
  - For automated multi-client demonstrations and benchmarking suites, header-based client identification can be explicitly enabled.
  - When enabled, `X-Demo-Client-Id` or `X-Client-Id` is parsed and validated against `/^[a-zA-Z0-9_-]{1,64}$/`. Malformed headers immediately return `400 Bad Request`.
- **Proxy Considerations:** Global Express `trust proxy` is disabled by default to prevent spoofed `X-Forwarded-For` injection. When deploying behind a trusted reverse proxy (e.g. Nginx, ALB), proxy trust must be configured at the deployment edge and custom `keyGenerator` used for verified identity claims.

### 2.3 HTTP Header Contract & Status Codes

- **Admitted Responses (HTTP 200):**
  - `X-RateLimit-Limit`: Total permitted requests in window ($L$).
  - `X-RateLimit-Remaining`: Remaining capacity in current window.
  - `X-RateLimit-Reset`: Unix timestamp in seconds (`Math.ceil(resetTimeMs / 1000)`).
  - `Retry-After` is **omitted**.
- **Throttled Responses (HTTP 429):**
  - Status: `429 Too Many Requests`.
  - Headers: Same `X-RateLimit-*` headers (`Remaining: 0`) + `Retry-After: <seconds>`.
  - Body:
    ```json
    {
      "error": "Too Many Requests",
      "message": "Rate limit quota exceeded. Try again in 42 seconds.",
      "retryAfter": 42
    }
    ```

### 2.4 Storage Failure Policies: Fail-Closed vs Fail-Open

- **Fail-Closed (Default):**
  - When the backing store throws (e.g., Redis outage or connection timeout), the middleware returns `HTTP 503 Service Unavailable` with body:
    ```json
    {
      "error": "Service Unavailable",
      "message": "Rate limiting service temporarily unavailable"
    }
    ```
  - `Retry-After` is omitted by default to avoid artificial recovery promises.
  - **Critical Rule:** Dependency failure is an infrastructure outage, **never quota exhaustion**. It must never return HTTP 429.
- **Fail-Open (Configurable):**
  - When configured, caught storage errors set diagnostic header `X-RateLimit-Fallback: fail-open` and call `next()`. The downstream route handler executes normally, producing its natural response.

### 2.5 Express 4 Asynchronous Handling

- Express 4 does not natively await promises returned by middleware. The middleware wraps async evaluation inside `void (async () => { ... })().catch(next)` to comply with `@typescript-eslint/no-misused-promises` and forward unexpected runtime errors to Express error handlers.

---

## 3. Consequences & Tradeoffs

### Positive

- **Strict Contract Enforcement:** 12 end-to-end Supertest contract tests verify headers, status codes, bodies, and failure policies.
- **Clean Separation:** Express concerns reside in `src/middleware/` and `src/app/`, decoupled from core algorithms and Redis storage.
- **Robust Failure Resilience:** Clear distinction between HTTP 429 (quota exhausted) and HTTP 503 (backing store failure).

### Negative & Known Tradeoffs

- **Demo Identity Trust:** Headers (`X-Demo-Client-Id`) are acceptable for laboratory demonstration and benchmarking, but in public production, rate limiting keys should be derived from authenticated credentials (e.g. validated JWT or API token).
