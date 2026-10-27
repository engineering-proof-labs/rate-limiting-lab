import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import { createApp } from '../../src/app/create-app.js';
import { RedisFixedWindowRateLimiter } from '../../src/storage/redis-fixed-window.js';
import type { RateLimiter } from '../../src/middleware/rate-limit.js';
import type { RateLimitPolicy } from '../../src/core/types.js';

const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

describe('HTTP Concurrency & Failure Resilience Test Suite (Phase 08)', () => {
  let redis: Redis;

  /**
   * Guards against running time-sensitive tests too close to an epoch window boundary.
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
        `HTTP concurrency & resilience tests require an active Redis instance at ${REDIS_HOST}:${REDIS_PORT}. ` +
          `Verify that Docker is running and run 'docker compose up -d'. Error: ${String(error)}`,
      );
    }
  });

  afterAll(async () => {
    if (redis && redis.status === 'ready') {
      await redis.quit();
    }
  });

  describe('1. High-Concurrency HTTP Traffic Sharing a Single Quota', () => {
    const concurrencyPolicy: RateLimitPolicy = {
      limit: 5,
      windowMs: 60_000,
    };
    const keyPrefix = 'test:http:concurrency:single';
    let limiter: RedisFixedWindowRateLimiter;
    let app: Express;

    beforeEach(async () => {
      limiter = new RedisFixedWindowRateLimiter({
        redis,
        policy: concurrencyPolicy,
        keyPrefix,
      });
      await limiter.reset();
      await ensureWindowSafetyMargin(limiter, 1000);
      app = createApp({ limiter });
    });

    afterEach(async () => {
      await limiter.reset();
    });

    it('strictly admits exactly 5 and throttles 15 across 20 concurrent HTTP requests from the same IP', async () => {
      // Launch 20 simultaneous HTTP requests against the limited endpoint
      const promises = Array.from({ length: 20 }, () => request(app).get('/api/v1/limited'));
      const responses = await Promise.all(promises);

      const admitted = responses.filter((r) => r.status === 200);
      const throttled = responses.filter((r) => r.status === 429);

      // Invariant 1: Exactly 5 admitted (HTTP 200), exactly 15 throttled (HTTP 429)
      expect(admitted).toHaveLength(5);
      expect(throttled).toHaveLength(15);

      // Invariant 2: Admitted responses have unique remaining values [4, 3, 2, 1, 0]
      const remainingValues = admitted
        .map((r) => Number(r.headers['x-ratelimit-remaining']))
        .sort((a, b) => b - a);
      expect(remainingValues).toEqual([4, 3, 2, 1, 0]);

      // Invariant 3: All admitted have consistent reset timestamps and body
      const expectedResetHeader = admitted[0].headers['x-ratelimit-reset'];
      expect(expectedResetHeader).toBeDefined();

      for (const res of admitted) {
        expect(res.body).toEqual({ success: true, message: 'Access granted' });
        expect(res.headers['x-ratelimit-limit']).toBe('5');
        expect(res.headers['x-ratelimit-reset']).toBe(expectedResetHeader);
        expect(res.headers['retry-after']).toBeUndefined();
      }

      // Invariant 4: All throttled responses have remaining = 0 and valid Retry-After
      for (const res of throttled) {
        expect(res.headers['x-ratelimit-limit']).toBe('5');
        expect(res.headers['x-ratelimit-remaining']).toBe('0');
        expect(res.headers['x-ratelimit-reset']).toBe(expectedResetHeader);
        expect(res.headers['retry-after']).toBeDefined();
        const retryAfter = Number(res.headers['retry-after']);
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(60);
        expect(res.body).toMatchObject({
          error: 'Too Many Requests',
          retryAfter,
        });
      }

      // Invariant 5: Stored counter in Redis hash saturates at limit + 1 (6), not 20
      // Supports IPv4 127.0.0.1, IPv4-mapped IPv6 ::ffff:127.0.0.1, and IPv6 ::1 loopback formats
      const storedCount =
        (await limiter.getRawCounter('ip:127.0.0.1')) ??
        (await limiter.getRawCounter('ip:::ffff:127.0.0.1')) ??
        (await limiter.getRawCounter('ip:::1'));
      expect(storedCount).toBe(6);
    });
  });

  describe('2. Multi-Instance Concurrency (Independent Express Apps & Redis TCP Connections)', () => {
    const multiAppPolicy: RateLimitPolicy = {
      limit: 5,
      windowMs: 60_000,
    };
    const keyPrefix = 'test:http:multi-instance';
    let clientA: Redis;
    let clientB: Redis;
    let limiterA: RedisFixedWindowRateLimiter;
    let limiterB: RedisFixedWindowRateLimiter;
    let appA: Express;
    let appB: Express;

    beforeEach(async () => {
      clientA = new Redis({
        host: REDIS_HOST,
        port: REDIS_PORT,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        enableOfflineQueue: false,
      });
      clientB = new Redis({
        host: REDIS_HOST,
        port: REDIS_PORT,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        enableOfflineQueue: false,
      });

      await Promise.all([clientA.connect(), clientB.connect()]);

      limiterA = new RedisFixedWindowRateLimiter({
        redis: clientA,
        policy: multiAppPolicy,
        keyPrefix,
      });
      limiterB = new RedisFixedWindowRateLimiter({
        redis: clientB,
        policy: multiAppPolicy,
        keyPrefix,
      });

      appA = createApp({ limiter: limiterA });
      appB = createApp({ limiter: limiterB });

      await limiterA.reset();
      await ensureWindowSafetyMargin(limiterA, 1000);
    });

    afterEach(async () => {
      try {
        await limiterA.reset();
      } finally {
        await Promise.all([
          clientA.status === 'ready' ? clientA.quit() : Promise.resolve(),
          clientB.status === 'ready' ? clientB.quit() : Promise.resolve(),
        ]);
      }
    });

    it('collectively admits exactly 5 and throttles 15 across 20 concurrent requests split between two independent app instances', async () => {
      // 10 requests to App A, 10 requests to App B dispatched concurrently
      const promises = Array.from({ length: 20 }, (_, idx) =>
        idx % 2 === 0 ? request(appA).get('/api/v1/limited') : request(appB).get('/api/v1/limited'),
      );
      const responses = await Promise.all(promises);

      const admitted = responses.filter((r) => r.status === 200);
      const throttled = responses.filter((r) => r.status === 429);

      // Invariant: Cross-application coordination enforces the exact shared limit
      expect(admitted).toHaveLength(5);
      expect(throttled).toHaveLength(15);

      const remainingValues = admitted
        .map((r) => Number(r.headers['x-ratelimit-remaining']))
        .sort((a, b) => b - a);
      expect(remainingValues).toEqual([4, 3, 2, 1, 0]);

      for (const res of throttled) {
        expect(res.headers['x-ratelimit-remaining']).toBe('0');
        expect(res.headers['retry-after']).toBeDefined();
      }
    });
  });

  describe('3. Untrusted Identity Headers Defense under Default Express Configuration', () => {
    const defaultSecPolicy: RateLimitPolicy = {
      limit: 5,
      windowMs: 60_000,
    };
    const keyPrefix = 'test:http:untrusted-headers';
    let limiter: RedisFixedWindowRateLimiter;
    let app: Express;

    beforeEach(async () => {
      limiter = new RedisFixedWindowRateLimiter({
        redis,
        policy: defaultSecPolicy,
        keyPrefix,
      });
      await limiter.reset();
      await ensureWindowSafetyMargin(limiter, 1000);
      // Default: enableDemoHeaders is omitted (false), trust proxy is false
      app = createApp({ limiter });
    });

    afterEach(async () => {
      await limiter.reset();
    });

    it('proves that arbitrary X-Forwarded-For, X-Real-IP, and client identity headers cannot evade IP quota', async () => {
      const spoofedHeaders = [
        { 'X-Forwarded-For': '203.0.113.195' },
        { 'X-Forwarded-For': '198.51.100.22, 10.0.0.1' },
        { 'X-Real-IP': '192.0.2.1' },
        { 'True-Client-IP': '198.18.0.5' },
        { 'X-Client-Id': 'attacker-alias-alpha' },
      ];

      // Requests 1 to 5 carry varying spoofed headers, but all consume the connection IP's quota
      for (let i = 0; i < 5; i++) {
        const reqBuilder = request(app).get('/api/v1/limited');
        for (const [k, v] of Object.entries(spoofedHeaders[i])) {
          reqBuilder.set(k, v);
        }
        const res = await reqBuilder;
        expect(res.status).toBe(200);
        expect(res.headers['x-ratelimit-remaining']).toBe(String(4 - i));
      }

      // Request 6 with yet another distinct spoofed header is throttled with HTTP 429
      const res6 = await request(app)
        .get('/api/v1/limited')
        .set('X-Forwarded-For', '100.64.0.1')
        .set('X-Demo-Client-Id', 'fresh-identity');

      expect(res6.status).toBe(429);
      expect(res6.headers['x-ratelimit-remaining']).toBe('0');
      expect(res6.body).toMatchObject({ error: 'Too Many Requests' });
    });
  });

  describe('4. Client Identity Isolation under Concurrent Bursts', () => {
    const isoPolicy: RateLimitPolicy = {
      limit: 5,
      windowMs: 60_000,
    };
    const keyPrefix = 'test:http:iso:concurrency';
    let limiter: RedisFixedWindowRateLimiter;
    let app: Express;

    beforeEach(async () => {
      limiter = new RedisFixedWindowRateLimiter({
        redis,
        policy: isoPolicy,
        keyPrefix,
      });
      await limiter.reset();
      await ensureWindowSafetyMargin(limiter, 1000);
      app = createApp({ limiter, enableDemoHeaders: true });
    });

    afterEach(async () => {
      await limiter.reset();
    });

    it('maintains strict quota isolation between two distinct clients submitting concurrent bursts', async () => {
      const clientA = 'tenant-alpha';
      const clientB = 'tenant-beta';

      // 10 concurrent requests for Client A, 10 concurrent requests for Client B
      const promisesA = Array.from({ length: 10 }, () =>
        request(app).get('/api/v1/limited').set('X-Demo-Client-Id', clientA),
      );
      const promisesB = Array.from({ length: 10 }, () =>
        request(app).get('/api/v1/limited').set('X-Demo-Client-Id', clientB),
      );

      // Launch all 20 requests concurrently
      const [resA, resB] = await Promise.all([Promise.all(promisesA), Promise.all(promisesB)]);

      const admittedA = resA.filter((r) => r.status === 200);
      const throttledA = resA.filter((r) => r.status === 429);
      const admittedB = resB.filter((r) => r.status === 200);
      const throttledB = resB.filter((r) => r.status === 429);

      // Both clients independently receive exactly 5 admitted and 5 throttled
      expect(admittedA).toHaveLength(5);
      expect(throttledA).toHaveLength(5);
      expect(admittedB).toHaveLength(5);
      expect(throttledB).toHaveLength(5);

      const remainingA = admittedA
        .map((r) => Number(r.headers['x-ratelimit-remaining']))
        .sort((a, b) => b - a);
      const remainingB = admittedB
        .map((r) => Number(r.headers['x-ratelimit-remaining']))
        .sort((a, b) => b - a);

      expect(remainingA).toEqual([4, 3, 2, 1, 0]);
      expect(remainingB).toEqual([4, 3, 2, 1, 0]);
    });
  });

  describe('5. Window Rollover under Concurrent Burst Traffic (Fast 1,000 ms Fixture)', () => {
    const fastPolicy: RateLimitPolicy = {
      limit: 5,
      windowMs: 1000,
    };
    const keyPrefix = 'test:http:rollover:concurrent';
    let limiter: RedisFixedWindowRateLimiter;
    let app: Express;

    beforeEach(async () => {
      limiter = new RedisFixedWindowRateLimiter({
        redis,
        policy: fastPolicy,
        keyPrefix,
      });
      await limiter.reset();
      await ensureWindowSafetyMargin(limiter, 750);
      app = createApp({ limiter, enableDemoHeaders: true });
    });

    afterEach(async () => {
      await limiter.reset();
    });

    it('handles concurrent bursts across window expiration with exact quota reset', async () => {
      const clientId = 'client-burst-rollover';
      await ensureWindowSafetyMargin(limiter, 750);

      // Window 1: 15 concurrent requests
      const burst1 = await Promise.all(
        Array.from({ length: 15 }, () =>
          request(app).get('/api/v1/limited').set('X-Demo-Client-Id', clientId),
        ),
      );

      const admitted1 = burst1.filter((r) => r.status === 200);
      const throttled1 = burst1.filter((r) => r.status === 429);
      expect(admitted1).toHaveLength(5);
      expect(throttled1).toHaveLength(10);

      const window1ResetSec = Number(admitted1[0].headers['x-ratelimit-reset']);

      // Calculate time until expiration via Redis server time
      const timeRes = await redis.time();
      const redisNowMs = Math.floor(Number(timeRes[0]) * 1000 + Number(timeRes[1]) / 1000);
      const resetTimeMs = window1ResetSec * 1000;
      const msUntilExpiry = Math.max(20, resetTimeMs - redisNowMs + 50);

      await new Promise((resolve) => setTimeout(resolve, msUntilExpiry));

      // Window 2: Another 15 concurrent requests
      const burst2 = await Promise.all(
        Array.from({ length: 15 }, () =>
          request(app).get('/api/v1/limited').set('X-Demo-Client-Id', clientId),
        ),
      );

      const admitted2 = burst2.filter((r) => r.status === 200);
      const throttled2 = burst2.filter((r) => r.status === 429);
      expect(admitted2).toHaveLength(5);
      expect(throttled2).toHaveLength(10);

      const remaining2 = admitted2
        .map((r) => Number(r.headers['x-ratelimit-remaining']))
        .sort((a, b) => b - a);
      expect(remaining2).toEqual([4, 3, 2, 1, 0]);

      const window2ResetSec = Number(admitted2[0].headers['x-ratelimit-reset']);
      expect(window2ResetSec).toBeGreaterThan(window1ResetSec);
    }, 15000);
  });

  describe('6. Real Redis Infrastructure Outages (Fail-Closed vs Fail-Open)', () => {
    let unreachableRedis: Redis;
    let failingLimiter: RedisFixedWindowRateLimiter;

    beforeAll(() => {
      unreachableRedis = new Redis({
        host: '127.0.0.1',
        port: 6399, // Non-existent Redis port
        maxRetriesPerRequest: 0,
        lazyConnect: true,
        enableOfflineQueue: false,
        connectTimeout: 300,
      });
      // Attach no-op error listener to suppress unhandled error event logging in test output
      unreachableRedis.on('error', () => {});

      failingLimiter = new RedisFixedWindowRateLimiter({
        redis: unreachableRedis,
        policy: { limit: 5, windowMs: 60_000 },
        keyPrefix: 'test:http:failing',
      });
    });

    afterAll(() => {
      unreachableRedis.disconnect();
    });

    it('returns HTTP 503 Service Unavailable when Redis connection is refused under default fail-closed', async () => {
      const app = createApp({ limiter: failingLimiter });

      const res = await request(app).get('/api/v1/limited');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: 'Service Unavailable',
        message: 'Rate limiting service temporarily unavailable',
      });
      expect(res.headers['retry-after']).toBeUndefined();
      expect(res.status).not.toBe(429);

      // Unmetered endpoints remain fully operational during Redis outage
      const healthRes = await request(app).get('/health');
      expect(healthRes.status).toBe(200);
      expect(healthRes.body).toEqual({ status: 'ok' });

      const unlimitedRes = await request(app).get('/api/v1/unlimited');
      expect(unlimitedRes.status).toBe(200);
    });

    it('delegates downstream to route handler with diagnostic header when configured with fail-open', async () => {
      const app = createApp({
        limiter: failingLimiter,
        failurePolicy: 'fail-open',
      });

      const res = await request(app).get('/api/v1/limited');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, message: 'Access granted' });
      expect(res.headers['x-ratelimit-fallback']).toBe('fail-open');
    });

    it('handles Redis command-level rejections (e.g. READONLY replica error) according to failure policy', async () => {
      const readonlyLimiter: RateLimiter = {
        policy: { limit: 5, windowMs: 60_000 },
        consume: () => {
          throw new Error("READONLY You can't write against a read only replica.");
        },
      };

      // Fail-Closed
      const appClosed = createApp({ limiter: readonlyLimiter });
      const resClosed = await request(appClosed).get('/api/v1/limited');
      expect(resClosed.status).toBe(503);
      expect(resClosed.body).toEqual({
        error: 'Service Unavailable',
        message: 'Rate limiting service temporarily unavailable',
      });

      // Fail-Open
      const appOpen = createApp({
        limiter: readonlyLimiter,
        failurePolicy: 'fail-open',
      });
      const resOpen = await request(appOpen).get('/api/v1/limited');
      expect(resOpen.status).toBe(200);
      expect(resOpen.body).toEqual({ success: true, message: 'Access granted' });
      expect(resOpen.headers['x-ratelimit-fallback']).toBe('fail-open');
    });
  });

  describe('7. Recovery after Transient Storage Outage (Self-Healing)', () => {
    const recoveryPolicy: RateLimitPolicy = {
      limit: 5,
      windowMs: 60_000,
    };
    const keyPrefix = 'test:http:recovery';
    let realLimiter: RedisFixedWindowRateLimiter;

    beforeEach(async () => {
      realLimiter = new RedisFixedWindowRateLimiter({
        redis,
        policy: recoveryPolicy,
        keyPrefix,
      });
      await realLimiter.reset();
      await ensureWindowSafetyMargin(realLimiter, 1000);
    });

    afterEach(async () => {
      await realLimiter.reset();
    });

    it('recovers immediately and resumes exact quota enforcement when storage returns after an outage', async () => {
      let isStorageFailing = false;

      // Wrapping limiter that simulates a transient outage
      const resilientLimiter: RateLimiter = {
        policy: recoveryPolicy,
        consume: async (key: string) => {
          if (isStorageFailing) {
            throw new Error('Connection lost to Redis primary (ECONNRESET)');
          }
          return realLimiter.consume(key);
        },
      };

      const app = createApp({ limiter: resilientLimiter });

      // Phase 1: Healthy — Request 1 consumes quota
      const res1 = await request(app).get('/api/v1/limited');
      expect(res1.status).toBe(200);
      expect(res1.headers['x-ratelimit-remaining']).toBe('4');

      // Phase 2: Outage begins — Next 2 requests fail-closed with 503
      isStorageFailing = true;

      const resOutage1 = await request(app).get('/api/v1/limited');
      expect(resOutage1.status).toBe(503);
      expect(resOutage1.body).toMatchObject({ error: 'Service Unavailable' });

      const resOutage2 = await request(app).get('/api/v1/limited');
      expect(resOutage2.status).toBe(503);

      // Phase 3: Outage ends — Storage recovers immediately
      isStorageFailing = false;

      // Request 2 (after recovery): consumes quota from where it left off
      const res2 = await request(app).get('/api/v1/limited');
      expect(res2.status).toBe(200);
      expect(res2.headers['x-ratelimit-remaining']).toBe('3');

      const res3 = await request(app).get('/api/v1/limited');
      expect(res3.status).toBe(200);
      expect(res3.headers['x-ratelimit-remaining']).toBe('2');

      const res4 = await request(app).get('/api/v1/limited');
      expect(res4.status).toBe(200);
      expect(res4.headers['x-ratelimit-remaining']).toBe('1');

      const res5 = await request(app).get('/api/v1/limited');
      expect(res5.status).toBe(200);
      expect(res5.headers['x-ratelimit-remaining']).toBe('0');

      // Request 6 (after recovery): Throttled with 429
      const res6 = await request(app).get('/api/v1/limited');
      expect(res6.status).toBe(429);
      expect(res6.headers['x-ratelimit-remaining']).toBe('0');
      expect(res6.headers['retry-after']).toBeDefined();
    });
  });
});
