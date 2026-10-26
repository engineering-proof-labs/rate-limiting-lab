import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Redis } from 'ioredis';
import type { Express } from 'express';
import { createApp } from '../../src/app/create-app.js';
import { RedisFixedWindowRateLimiter } from '../../src/storage/redis-fixed-window.js';
import type { RateLimitPolicy } from '../../src/core/types.js';
import type { RateLimiter } from '../../src/middleware/rate-limit.js';

const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

describe('Express HTTP Contract Test Suite', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    });

    try {
      await redis.connect();
      const pong = await redis.ping();
      expect(pong).toBe('PONG');
    } catch (error) {
      throw new Error(
        `Redis integration tests require an active Redis instance at ${REDIS_HOST}:${REDIS_PORT}. ` +
          `Verify that Docker is running and run 'docker compose up -d'. Error: ${String(error)}`,
      );
    }
  });

  afterAll(async () => {
    if (redis && redis.status === 'ready') {
      await redis.quit();
    }
  });

  /**
   * Guards against running test requests too close to a window boundary.
   */
  async function ensureWindowSafetyMargin(
    limiter: RedisFixedWindowRateLimiter,
    minMarginMs = 500,
  ): Promise<void> {
    const timeRes = await redis.time();
    const nowMs = Math.floor(Number(timeRes[0]) * 1000 + Number(timeRes[1]) / 1000);
    const windowMs = limiter.policy.windowMs;
    const remainingInWindow = windowMs - (nowMs % windowMs);
    if (remainingInWindow < minMarginMs) {
      await new Promise((resolve) => setTimeout(resolve, remainingInWindow + 20));
    }
  }

  describe('Standard Profile (5 requests / 60,000 ms)', () => {
    const standardPolicy: RateLimitPolicy = {
      limit: 5,
      windowMs: 60_000,
    };
    const keyPrefix = 'test:http:standard';
    let limiter: RedisFixedWindowRateLimiter;
    let app: Express;

    beforeEach(async () => {
      limiter = new RedisFixedWindowRateLimiter({
        redis,
        policy: standardPolicy,
        keyPrefix,
      });
      await limiter.reset();
      await ensureWindowSafetyMargin(limiter, 1000);
      app = createApp({ limiter });
    });

    afterEach(async () => {
      await limiter.reset();
    });

    it('admits requests within quota and returns HTTP 200 with standard rate limit headers', async () => {
      const response = await request(app)
        .get('/api/v1/limited')
        .set('X-Demo-Client-Id', 'client-http-1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: 'Access granted',
      });

      // Headers contract
      expect(response.headers['x-ratelimit-limit']).toBe('5');
      expect(response.headers['x-ratelimit-remaining']).toBe('4');
      expect(response.headers['x-ratelimit-reset']).toBeDefined();
      expect(Number(response.headers['x-ratelimit-reset'])).toBeGreaterThan(
        Math.floor(Date.now() / 1000) - 1,
      );
      // Retry-After must NOT be present on 200 OK
      expect(response.headers['retry-after']).toBeUndefined();

      // Misspelling guard: verify incorrect casings or misspellings are not present
      expect(response.headers['xratelimit-reset']).toBeUndefined();
      expect(response.headers['x-rate-limit-reset']).toBeUndefined();
    });

    it('admits exactly 5 requests and throttles the 6th with HTTP 429 and Retry-After', async () => {
      const clientId = 'client-http-burst';

      // First 5 requests must succeed
      for (let i = 1; i <= 5; i++) {
        const res = await request(app).get('/api/v1/limited').set('X-Demo-Client-Id', clientId);

        expect(res.status).toBe(200);
        expect(res.headers['x-ratelimit-limit']).toBe('5');
        expect(res.headers['x-ratelimit-remaining']).toBe(String(5 - i));
        expect(res.headers['retry-after']).toBeUndefined();
      }

      // 6th request must be throttled with HTTP 429
      const res6 = await request(app).get('/api/v1/limited').set('X-Demo-Client-Id', clientId);

      expect(res6.status).toBe(429);
      expect(res6.headers['x-ratelimit-limit']).toBe('5');
      expect(res6.headers['x-ratelimit-remaining']).toBe('0');
      expect(res6.headers['x-ratelimit-reset']).toBeDefined();
      expect(res6.headers['retry-after']).toBeDefined();

      const retryAfter = Number(res6.headers['retry-after']);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(60);

      // Verify JSON body matches SPEC
      expect(res6.body).toEqual({
        error: 'Too Many Requests',
        message: `Rate limit quota exceeded. Try again in ${retryAfter} seconds.`,
        retryAfter,
      });

      // 7th request remains throttled
      const res7 = await request(app).get('/api/v1/limited').set('X-Demo-Client-Id', clientId);
      expect(res7.status).toBe(429);
      expect(res7.headers['x-ratelimit-remaining']).toBe('0');
    });

    it('maintains independent quotas across different clients', async () => {
      const clientA = 'client-iso-a';
      const clientB = 'client-iso-b';

      // Exhaust Client A
      for (let i = 0; i < 5; i++) {
        const resA = await request(app).get('/api/v1/limited').set('X-Demo-Client-Id', clientA);
        expect(resA.status).toBe(200);
      }
      const resA6 = await request(app).get('/api/v1/limited').set('X-Demo-Client-Id', clientA);
      expect(resA6.status).toBe(429);

      // Client B should be completely fresh
      const resB = await request(app).get('/api/v1/limited').set('X-Demo-Client-Id', clientB);
      expect(resB.status).toBe(200);
      expect(resB.headers['x-ratelimit-remaining']).toBe('4');
    });

    it('supports X-Client-Id as well as X-Demo-Client-Id', async () => {
      const res = await request(app).get('/api/v1/limited').set('X-Client-Id', 'client-compat');

      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-remaining']).toBe('4');
    });

    it('falls back to IP address when no client header is supplied', async () => {
      const res1 = await request(app).get('/api/v1/limited');
      expect(res1.status).toBe(200);
      expect(res1.headers['x-ratelimit-remaining']).toBe('4');

      const res2 = await request(app).get('/api/v1/limited');
      expect(res2.status).toBe(200);
      expect(res2.headers['x-ratelimit-remaining']).toBe('3');
    });

    it('rejects malformed client identifiers with HTTP 400 Bad Request', async () => {
      // Space in identifier
      const res1 = await request(app)
        .get('/api/v1/limited')
        .set('X-Demo-Client-Id', 'invalid client with spaces');
      expect(res1.status).toBe(400);
      expect(res1.body).toEqual({
        error: 'Bad Request',
        message: 'Malformed client identifier. Allowed characters: [a-zA-Z0-9_-], max length 64.',
      });

      // Special characters
      const res2 = await request(app)
        .get('/api/v1/limited')
        .set('X-Demo-Client-Id', 'bad!@#$client');
      expect(res2.status).toBe(400);

      // Too long (> 64 characters)
      const res3 = await request(app)
        .get('/api/v1/limited')
        .set('X-Demo-Client-Id', 'a'.repeat(65));
      expect(res3.status).toBe(400);
    });
  });

  describe('Route Mounting & Path Isolation Guards', () => {
    let app: Express;

    beforeEach(() => {
      const dummyLimiter: RateLimiter = {
        policy: { limit: 5, windowMs: 60_000 },
        consume: () => ({
          allowed: true,
          limit: 5,
          remaining: 4,
          resetTimeMs: Date.now() + 60_000,
        }),
      };
      app = createApp({ limiter: dummyLimiter });
    });

    it('exposes GET /health unthrottled and without rate limit headers', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
      expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
    });

    it('exposes GET /api/v1/unlimited unthrottled and without consuming quota', async () => {
      const res = await request(app).get('/api/v1/unlimited');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, message: 'Unlimited endpoint' });
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
      expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
    });

    it('prevents route mounting bugs: /limited, /api/limited, and double-prefix /api/api/v1 return 404', async () => {
      const res1 = await request(app).get('/limited');
      expect(res1.status).toBe(404);

      const res2 = await request(app).get('/api/limited');
      expect(res2.status).toBe(404);

      const res3 = await request(app).get('/api/api/v1/limited');
      expect(res3.status).toBe(404);

      const res4 = await request(app).get('/api/v1/non-existent');
      expect(res4.status).toBe(404);
    });
  });

  describe('Storage Outage & Failure Policies (Fail-Closed vs Fail-Open)', () => {
    const failingLimiter: RateLimiter = {
      policy: { limit: 5, windowMs: 60_000 },
      consume: () => {
        throw new Error('Connection to Redis lost (ECONNREFUSED)');
      },
    };

    it('defaults to fail-closed returning HTTP 503 Service Unavailable and NEVER 429', async () => {
      const app = createApp({
        limiter: failingLimiter,
        failurePolicy: 'fail-closed',
      });

      const res = await request(app)
        .get('/api/v1/limited')
        .set('X-Demo-Client-Id', 'client-fail-closed');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: 'Service Unavailable',
        message: 'Rate limiting service temporarily unavailable',
      });
      // Crucial: 503 must not emit Retry-After by default
      expect(res.headers['retry-after']).toBeUndefined();
      // Crucial: outage is NOT quota exhaustion
      expect(res.status).not.toBe(429);
    });

    it('delegates to route handler when configured with fail-open and sets diagnostic header', async () => {
      const app = createApp({
        limiter: failingLimiter,
        failurePolicy: 'fail-open',
      });

      const res = await request(app)
        .get('/api/v1/limited')
        .set('X-Demo-Client-Id', 'client-fail-open');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: 'Access granted',
      });
      // Diagnostic header in demo mode
      expect(res.headers['x-ratelimit-fallback']).toBe('fail-open');
    });
  });

  describe('Window Rollover across Expiration via HTTP (Fast 1,000 ms Fixture)', () => {
    const fastPolicy: RateLimitPolicy = {
      limit: 5,
      windowMs: 1000,
    };
    const keyPrefix = 'test:http:rollover';
    let limiter: RedisFixedWindowRateLimiter;
    let app: Express;

    beforeEach(async () => {
      limiter = new RedisFixedWindowRateLimiter({
        redis,
        policy: fastPolicy,
        keyPrefix,
      });
      await limiter.reset();
      await ensureWindowSafetyMargin(limiter, 400);
      app = createApp({ limiter });
    });

    afterEach(async () => {
      await limiter.reset();
    });

    it('exhausts quota in initial window, waits for expiration, and admits requests in the new window', async () => {
      const clientId = 'client-http-rollover';

      // Exhaust initial window
      for (let i = 0; i < 5; i++) {
        const res = await request(app).get('/api/v1/limited').set('X-Demo-Client-Id', clientId);
        expect(res.status).toBe(200);
      }

      // 6th request is throttled
      const res6 = await request(app).get('/api/v1/limited').set('X-Demo-Client-Id', clientId);
      expect(res6.status).toBe(429);
      const oldResetSec = Number(res6.headers['x-ratelimit-reset']);

      // Calculate time until expiration via Redis server time
      const timeRes = await redis.time();
      const redisNowMs = Math.floor(Number(timeRes[0]) * 1000 + Number(timeRes[1]) / 1000);
      const resetTimeMs = oldResetSec * 1000;
      const msUntilExpiry = Math.max(20, resetTimeMs - redisNowMs + 50);

      await new Promise((resolve) => setTimeout(resolve, msUntilExpiry));

      // First request in new window must be admitted
      const resNew = await request(app).get('/api/v1/limited').set('X-Demo-Client-Id', clientId);
      expect(resNew.status).toBe(200);
      expect(resNew.body).toEqual({ success: true, message: 'Access granted' });
      expect(resNew.headers['x-ratelimit-remaining']).toBe('4');
      expect(Number(resNew.headers['x-ratelimit-reset'])).toBeGreaterThan(oldResetSec);
    }, 15000);
  });
});
