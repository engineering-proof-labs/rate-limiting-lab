# Rate Limiting Laboratory (`rate-limiting-lab`)

A production-minded, reproducible reference laboratory and testing harness for rate limiting architectures built with **TypeScript**, **Node.js**, and **Redis**.

The laboratory focuses on concurrency correctness, atomic admission control, and failure resilience.

---

## 1. Quick Start

### Prerequisites

- Node.js >= 22.0.0
- npm >= 10.0.0
- Docker Desktop (for Redis container)

### Start Redis

```bash
docker compose up -d
```

### Run Verification Pipeline

```bash
# Complete verification (typecheck, lint, formatting, unit, contract, integration, build)
npm run verify

# Run unit tests only (zero network / no Redis required)
npm run test

# Run HTTP contract tests (Express + Supertest against Redis)
npm run test:contract

# Run Redis distributed concurrency tests
npm run test:integration
```

---

## 2. API Routes & Runnable `curl` Examples

### 2.1 Unthrottled Health Check

```bash
curl -i http://localhost:3000/health
```

**Response (`200 OK`):**

```json
{
  "status": "ok"
}
```

### 2.2 Unthrottled Control Route

```bash
curl -i http://localhost:3000/api/v1/unlimited
```

**Response (`200 OK`):**

```json
{
  "success": true,
  "message": "Unlimited endpoint"
}
```

### 2.3 Protected Rate-Limited Route

```bash
# Request with explicit client identifier (Allowed, requests 1–5)
curl -i -H "X-Demo-Client-Id: client_alpha" http://localhost:3000/api/v1/limited
```

**Response (`200 OK`):**

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 4
X-RateLimit-Reset: 1793043600

{
  "success": true,
  "message": "Access granted"
}
```

```bash
# Request on quota exhaustion (Request 6)
curl -i -H "X-Demo-Client-Id: client_alpha" http://localhost:3000/api/v1/limited
```

**Response (`429 Too Many Requests`):**

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json; charset=utf-8
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1793043600
Retry-After: 42

{
  "error": "Too Many Requests",
  "message": "Rate limit quota exceeded. Try again in 42 seconds.",
  "retryAfter": 42
}
```

### 2.4 Backing Store Outage (Fail-Closed Default)

When Redis is unreachable, the API fails closed to protect downstream services:

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json; charset=utf-8

{
  "error": "Service Unavailable",
  "message": "Rate limiting service temporarily unavailable"
}
```

_(Notice: Dependency outages return HTTP 503, never HTTP 429)._

---

## 3. Architecture & Documentation

- [`SPEC.md`](SPEC.md) — System specification, mathematical models, and contracts.
- [`docs/architecture.md`](docs/architecture.md) — Module map, sequence diagrams, and dependency boundaries.
- [`docs/test-matrix.md`](docs/test-matrix.md) — Requirements traceability and verification status (REQ-01 to REQ-15).
- [`docs/decisions/`](docs/decisions/) — Architectural Decision Records (ADR 0001, ADR 0002, ADR 0003).
