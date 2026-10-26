import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Redis } from 'ioredis';
import { RedisFixedWindowRateLimiter } from '../../src/storage/redis-fixed-window.js';
import type { RateLimitPolicy } from '../../src/core/types.js';

const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

describe('RedisFixedWindowRateLimiter — Integration Test Suite', () => {
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

  describe('Contract Adherence & Basic Admissions (5 requests / 60,000 ms)', () => {
    const standardPolicy: RateLimitPolicy = {
      limit: 5,
      windowMs: 60_000,
    };
    const keyPrefix = 'test:fixed:standard';
    let limiter: RedisFixedWindowRateLimiter;

    beforeEach(async () => {
      limiter = new RedisFixedWindowRateLimiter({
        redis,
        policy: standardPolicy,
        keyPrefix,
      });
      await limiter.reset();
    });

    afterEach(async () => {
      await limiter.reset();
    });

    it('admits initial 5 requests and decrements remaining quota down to zero', async () => {
      const clientId = 'client-basic-1';

      // Request 1
      const res1 = await limiter.consume(clientId);
      expect(res1.allowed).toBe(true);
      expect(res1.limit).toBe(5);
      expect(res1.remaining).toBe(4);
      expect(res1.resetTimeMs).toBeGreaterThan(Date.now() - 1000);
      expect(res1.retryAfterSeconds).toBeUndefined();

      // Requests 2 through 5
      for (let i = 2; i <= 5; i++) {
        const res = await limiter.consume(clientId);
        expect(res.allowed).toBe(true);
        expect(res.limit).toBe(5);
        expect(res.remaining).toBe(5 - i);
        expect(res.resetTimeMs).toBe(res1.resetTimeMs);
        expect(res.retryAfterSeconds).toBeUndefined();
      }

      // Request 6 (Quota Exhausted)
      const res6 = await limiter.consume(clientId);
      expect(res6.allowed).toBe(false);
      expect(res6.limit).toBe(5);
      expect(res6.remaining).toBe(0);
      expect(res6.resetTimeMs).toBe(res1.resetTimeMs);
      expect(res6.retryAfterSeconds).toBeDefined();
      expect(res6.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(res6.retryAfterSeconds).toBeLessThanOrEqual(60);

      // Request 7 (Remains throttled)
      const res7 = await limiter.consume(clientId);
      expect(res7.allowed).toBe(false);
      expect(res7.remaining).toBe(0);
      expect(res7.retryAfterSeconds).toBeDefined();
    });

    it('maintains strict quota isolation between independent client identifiers', async () => {
      const clientA = 'client-iso-a';
      const clientB = 'client-iso-b';

      // Exhaust Client A's quota
      for (let i = 0; i < 5; i++) {
        const resA = await limiter.consume(clientA);
        expect(resA.allowed).toBe(true);
      }
      const resAExhausted = await limiter.consume(clientA);
      expect(resAExhausted.allowed).toBe(false);
      expect(resAExhausted.remaining).toBe(0);

      // Client B should be completely unaffected
      const resB = await limiter.consume(clientB);
      expect(resB.allowed).toBe(true);
      expect(resB.limit).toBe(5);
      expect(resB.remaining).toBe(4);
    });
  });

  describe('High-Concurrency Race Condition Safety (Atomic Admission)', () => {
    const concurrencyPolicy: RateLimitPolicy = {
      limit: 5,
      windowMs: 60_000,
    };
    const keyPrefix = 'test:fixed:concurrency';
    let limiter: RedisFixedWindowRateLimiter;

    beforeEach(async () => {
      limiter = new RedisFixedWindowRateLimiter({
        redis,
        policy: concurrencyPolicy,
        keyPrefix,
      });
      await limiter.reset();
    });

    afterEach(async () => {
      await limiter.reset();
    });

    it('strictly admits exactly 5 and rejects 15 under 20 concurrent requests without race conditions', async () => {
      const clientId = 'client-concurrent';

      // Launch 20 simultaneous requests
      const promises = Array.from({ length: 20 }, () => limiter.consume(clientId));
      const results = await Promise.all(promises);

      const admitted = results.filter((r) => r.allowed);
      const rejected = results.filter((r) => !r.allowed);

      // Invariant 1: Exactly 5 admitted, exactly 15 rejected
      expect(admitted).toHaveLength(5);
      expect(rejected).toHaveLength(15);

      // Invariant 2: Admitted requests have unique remaining values [4, 3, 2, 1, 0]
      const remainingCounts = admitted.map((r) => r.remaining).sort((a, b) => b - a);
      expect(remainingCounts).toEqual([4, 3, 2, 1, 0]);

      // Invariant 3: All admitted have consistent resetTimeMs
      const expectedResetTimeMs = admitted[0].resetTimeMs;
      for (const res of admitted) {
        expect(res.resetTimeMs).toBe(expectedResetTimeMs);
        expect(res.retryAfterSeconds).toBeUndefined();
      }

      // Invariant 4: All rejected have remaining = 0 and valid retryAfterSeconds
      for (const res of rejected) {
        expect(res.remaining).toBe(0);
        expect(res.resetTimeMs).toBe(expectedResetTimeMs);
        expect(res.retryAfterSeconds).toBeDefined();
        expect(res.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      }

      // Invariant 5: Stored counter is capped at limit + 1 (6), NOT 20
      const rawCounter = await limiter.getRawCounter(clientId);
      expect(rawCounter).toBe(6);
    });
  });

  describe('Independent Multi-Instance Coordination', () => {
    const sharedPolicy: RateLimitPolicy = {
      limit: 5,
      windowMs: 60_000,
    };
    const keyPrefix = 'test:fixed:multi-instance';
    let instanceA: RedisFixedWindowRateLimiter;
    let instanceB: RedisFixedWindowRateLimiter;

    beforeEach(async () => {
      instanceA = new RedisFixedWindowRateLimiter({
        redis,
        policy: sharedPolicy,
        keyPrefix,
      });
      instanceB = new RedisFixedWindowRateLimiter({
        redis,
        policy: sharedPolicy,
        keyPrefix,
      });
      await instanceA.reset();
    });

    afterEach(async () => {
      await instanceA.reset();
    });

    it('coordinates quota consumption across two separate limiter instances', async () => {
      const clientId = 'client-shared-coord';

      // Instance A consumes 3 requests
      const resA1 = await instanceA.consume(clientId);
      expect(resA1.allowed).toBe(true);
      expect(resA1.remaining).toBe(4);

      const resA2 = await instanceA.consume(clientId);
      expect(resA2.allowed).toBe(true);
      expect(resA2.remaining).toBe(3);

      const resA3 = await instanceA.consume(clientId);
      expect(resA3.allowed).toBe(true);
      expect(resA3.remaining).toBe(2);

      // Instance B consumes 2 requests
      const resB1 = await instanceB.consume(clientId);
      expect(resB1.allowed).toBe(true);
      expect(resB1.remaining).toBe(1);

      const resB2 = await instanceB.consume(clientId);
      expect(resB2.allowed).toBe(true);
      expect(resB2.remaining).toBe(0);

      // Both instances now observe quota exhaustion
      const resA4 = await instanceA.consume(clientId);
      expect(resA4.allowed).toBe(false);
      expect(resA4.remaining).toBe(0);

      const resB3 = await instanceB.consume(clientId);
      expect(resB3.allowed).toBe(false);
      expect(resB3.remaining).toBe(0);
    });
  });

  describe('Window Rollover & Key Expiration (Fast 1,000 ms Fixture)', () => {
    const fastPolicy: RateLimitPolicy = {
      limit: 5,
      windowMs: 1000,
    };
    const keyPrefix = 'test:fixed:fast-rollover';
    let limiter: RedisFixedWindowRateLimiter;

    beforeEach(async () => {
      limiter = new RedisFixedWindowRateLimiter({
        redis,
        policy: fastPolicy,
        keyPrefix,
      });
      await limiter.reset();
    });

    afterEach(async () => {
      await limiter.reset();
    });

    it('resets quota and counts the first request in the new window across expiration', async () => {
      const clientId = 'client-rollover';

      // Exhaust quota in current window
      for (let i = 0; i < 5; i++) {
        const res = await limiter.consume(clientId);
        expect(res.allowed).toBe(true);
      }

      const resExhausted = await limiter.consume(clientId);
      expect(resExhausted.allowed).toBe(false);

      const oldResetTimeMs = resExhausted.resetTimeMs;
      const oldWindowId = Math.floor(oldResetTimeMs / 1000) - 1;

      // Verify old key exists and has TTL <= 1000 ms
      const ttlBefore = await limiter.getTTL(clientId, oldWindowId);
      expect(ttlBefore).toBeGreaterThan(0);
      expect(ttlBefore).toBeLessThanOrEqual(1000);

      // Wait for window to expire completely (1,150 ms)
      await new Promise((resolve) => setTimeout(resolve, 1150));

      // First request in the new window
      const resNewWindow = await limiter.consume(clientId);
      expect(resNewWindow.allowed).toBe(true);
      expect(resNewWindow.limit).toBe(5);
      // Critical check: First request is counted, so remaining is 4, NOT 5
      expect(resNewWindow.remaining).toBe(4);
      expect(resNewWindow.resetTimeMs).toBeGreaterThan(oldResetTimeMs);

      // Verify old key has expired from Redis
      const oldKeyCounter = await limiter.getRawCounter(clientId, oldWindowId);
      expect(oldKeyCounter).toBeNull();
    }, 15000);
  });

  describe('Key Expiration Alignment with Epoch Window Boundary', () => {
    const alignmentPolicy: RateLimitPolicy = {
      limit: 5,
      windowMs: 60_000,
    };
    const keyPrefix = 'test:fixed:ttl-alignment';
    let limiter: RedisFixedWindowRateLimiter;

    beforeEach(async () => {
      limiter = new RedisFixedWindowRateLimiter({
        redis,
        policy: alignmentPolicy,
        keyPrefix,
      });
      await limiter.reset();
    });

    afterEach(async () => {
      await limiter.reset();
    });

    it('sets TTL aligning with epoch boundary on initial request and does not refresh TTL on subsequent requests', async () => {
      const clientId = 'client-ttl-test';

      const res1 = await limiter.consume(clientId);
      expect(res1.allowed).toBe(true);

      const ttl1 = await limiter.getTTL(clientId);
      expect(ttl1).toBeGreaterThan(0);
      expect(ttl1).toBeLessThanOrEqual(60_000);

      // Wait 150 ms
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Second request in same window
      const res2 = await limiter.consume(clientId);
      expect(res2.allowed).toBe(true);

      const ttl2 = await limiter.getTTL(clientId);
      // TTL should have decreased, NOT refreshed back to full window duration
      expect(ttl2).toBeLessThanOrEqual(ttl1 - 100);
    });
  });

  describe('Counter Saturation Ceiling', () => {
    const saturationPolicy: RateLimitPolicy = {
      limit: 5,
      windowMs: 60_000,
    };
    const keyPrefix = 'test:fixed:saturation';
    let limiter: RedisFixedWindowRateLimiter;

    beforeEach(async () => {
      limiter = new RedisFixedWindowRateLimiter({
        redis,
        policy: saturationPolicy,
        keyPrefix,
      });
      await limiter.reset();
    });

    afterEach(async () => {
      await limiter.reset();
    });

    it('saturates the Redis counter at limit + 1 regardless of rejected request volume', async () => {
      const clientId = 'client-saturate';

      // 5 admitted requests
      for (let i = 0; i < 5; i++) {
        await limiter.consume(clientId);
      }

      // 15 rejected requests
      for (let i = 0; i < 15; i++) {
        const res = await limiter.consume(clientId);
        expect(res.allowed).toBe(false);
        expect(res.remaining).toBe(0);
      }

      // Assert counter in Redis is capped at 6 (limit + 1), not 20
      const counter = await limiter.getRawCounter(clientId);
      expect(counter).toBe(6);
    });
  });

  describe('Redis Dependency Failure Resilience (Fail-Closed Contract)', () => {
    it('throws a connection error when Redis is unreachable and never masks outage as quota exceeded', async () => {
      const unreachableRedis = new Redis({
        host: '127.0.0.1',
        port: 6399, // Dead port
        maxRetriesPerRequest: 0,
        lazyConnect: true,
        enableOfflineQueue: false,
        connectTimeout: 500,
      });

      const limiter = new RedisFixedWindowRateLimiter({
        redis: unreachableRedis,
        policy: { limit: 5, windowMs: 60_000 },
        keyPrefix: 'test:fixed:unreachable',
      });

      // Calling consume on an unreachable Redis must throw, NEVER return { allowed: false }
      await expect(limiter.consume('client-failure-test')).rejects.toThrow();

      unreachableRedis.disconnect();
    });
  });

  describe('Supported Numeric Range & Parameter Validation', () => {
    it('rejects non-positive, non-integer, or overflowing limits', () => {
      expect(
        () =>
          new RedisFixedWindowRateLimiter({
            redis,
            policy: { limit: 0, windowMs: 60_000 },
          }),
      ).toThrow('Rate limit must be a positive safe integer');

      expect(
        () =>
          new RedisFixedWindowRateLimiter({
            redis,
            policy: { limit: -5, windowMs: 60_000 },
          }),
      ).toThrow('Rate limit must be a positive safe integer');

      expect(
        () =>
          new RedisFixedWindowRateLimiter({
            redis,
            policy: { limit: 3.5, windowMs: 60_000 },
          }),
      ).toThrow('Rate limit must be a positive safe integer');

      expect(
        () =>
          new RedisFixedWindowRateLimiter({
            redis,
            policy: { limit: Number.MAX_SAFE_INTEGER, windowMs: 60_000 },
          }),
      ).toThrow('less than Number.MAX_SAFE_INTEGER');
    });

    it('rejects non-positive or non-integer window durations', () => {
      expect(
        () =>
          new RedisFixedWindowRateLimiter({
            redis,
            policy: { limit: 5, windowMs: 0 },
          }),
      ).toThrow('Window duration must be a positive safe integer');

      expect(
        () =>
          new RedisFixedWindowRateLimiter({
            redis,
            policy: { limit: 5, windowMs: -1000 },
          }),
      ).toThrow('Window duration must be a positive safe integer');

      expect(
        () =>
          new RedisFixedWindowRateLimiter({
            redis,
            policy: { limit: 5, windowMs: 1000.5 },
          }),
      ).toThrow('Window duration must be a positive safe integer');
    });

    it('rejects empty or whitespace-only rate limit keys', async () => {
      const limiter = new RedisFixedWindowRateLimiter({
        redis,
        policy: { limit: 5, windowMs: 60_000 },
      });

      await expect(limiter.consume('')).rejects.toThrow(
        'Rate limit key must be a non-empty string',
      );
      await expect(limiter.consume('   ')).rejects.toThrow(
        'Rate limit key must be a non-empty string',
      );
    });
  });

  describe('Limiter Reset Semantics', () => {
    const resetPolicy: RateLimitPolicy = {
      limit: 5,
      windowMs: 60_000,
    };
    const keyPrefix = 'test:fixed:reset';
    let limiter: RedisFixedWindowRateLimiter;

    beforeEach(async () => {
      limiter = new RedisFixedWindowRateLimiter({
        redis,
        policy: resetPolicy,
        keyPrefix,
      });
      await limiter.reset();
    });

    afterEach(async () => {
      await limiter.reset();
    });

    it('selectively resets a single client key without wiping sibling keys', async () => {
      const client1 = 'client-reset-1';
      const client2 = 'client-reset-2';

      await limiter.consume(client1);
      await limiter.consume(client2);

      expect(await limiter.getRawCounter(client1)).toBe(1);
      expect(await limiter.getRawCounter(client2)).toBe(1);

      // Selectively reset client1
      await limiter.reset(client1);

      expect(await limiter.getRawCounter(client1)).toBeNull();
      expect(await limiter.getRawCounter(client2)).toBe(1);
    });

    it('clears all keys under the configured prefix on blanket reset()', async () => {
      const client1 = 'client-all-1';
      const client2 = 'client-all-2';

      await limiter.consume(client1);
      await limiter.consume(client2);

      await limiter.reset();

      expect(await limiter.getRawCounter(client1)).toBeNull();
      expect(await limiter.getRawCounter(client2)).toBeNull();
    });
  });
});
