import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryTokenBucketRateLimiter } from '../../src/core/token-bucket.js';
import { VirtualClock } from '../../src/core/clock.js';
import type { TokenBucketPolicy } from '../../src/core/types.js';

describe('InMemoryTokenBucketRateLimiter — Reference Unit Suite', () => {
  let clock: VirtualClock;

  beforeEach(() => {
    clock = new VirtualClock(0);
  });

  describe('Initial Capacity & Bounded Burst Exhaustion', () => {
    const policy: TokenBucketPolicy = {
      capacity: 5,
      refillRate: 1,
      refillIntervalMs: 1000,
    };

    it('initializes a fresh client with full capacity and allows an immediate burst of 5 requests', () => {
      const limiter = new InMemoryTokenBucketRateLimiter(policy, clock);
      const clientId = 'client-burst';

      // 5 immediate requests at timestamp 0
      for (let i = 1; i <= 5; i++) {
        const res = limiter.consume(clientId);
        expect(res.allowed).toBe(true);
        expect(res.limit).toBe(5);
        expect(res.remaining).toBe(5 - i);
        expect(res.resetTimeMs).toBe(i * 1000); // Time to refill back to 5
        expect(res.retryAfterSeconds).toBeUndefined();
      }

      // 6th request is rejected (bucket empty)
      const res6 = limiter.consume(clientId);
      expect(res6.allowed).toBe(false);
      expect(res6.limit).toBe(5);
      expect(res6.remaining).toBe(0);
      expect(res6.retryAfterSeconds).toBe(1);
      expect(res6.resetTimeMs).toBe(5000);
    });

    it('retains rejection on consecutive calls without time advancement', () => {
      const limiter = new InMemoryTokenBucketRateLimiter(policy, clock);
      const clientId = 'client-consecutive-reject';

      // Exhaust all 5 tokens
      for (let i = 0; i < 5; i++) {
        limiter.consume(clientId);
      }

      // Three consecutive rejected requests at the same timestamp
      for (let j = 0; j < 3; j++) {
        const res = limiter.consume(clientId);
        expect(res.allowed).toBe(false);
        expect(res.remaining).toBe(0);
        expect(res.retryAfterSeconds).toBe(1);
      }
    });
  });

  describe('Deterministic Refill Boundaries & Sustained Rate', () => {
    const policy: TokenBucketPolicy = {
      capacity: 5,
      refillRate: 1,
      refillIntervalMs: 1000, // 1 token every 1,000 ms
    };

    it('rejects at 999 ms and admits exactly at 1000 ms refill boundary', () => {
      const limiter = new InMemoryTokenBucketRateLimiter(policy, clock);
      const clientId = 'client-boundary';

      // Exhaust capacity at t = 0
      for (let i = 0; i < 5; i++) {
        limiter.consume(clientId);
      }

      // At t = 999 ms: 0.999 tokens refilled (< 1 required)
      clock.advance(999);
      const res999 = limiter.consume(clientId);
      expect(res999.allowed).toBe(false);
      expect(res999.remaining).toBe(0);
      expect(res999.retryAfterSeconds).toBe(1);

      // At t = 1000 ms: exactly 1.0 token refilled
      clock.advance(1);
      const res1000 = limiter.consume(clientId);
      expect(res1000.allowed).toBe(true);
      expect(res1000.remaining).toBe(0); // 1 - 1 = 0 remaining
    });

    it('accumulates multiple tokens during longer intervals and admits consecutive requests', () => {
      const limiter = new InMemoryTokenBucketRateLimiter(policy, clock);
      const clientId = 'client-multi-refill';

      // Exhaust at t = 0
      for (let i = 0; i < 5; i++) {
        limiter.consume(clientId);
      }

      // Advance by 3,000 ms (3 tokens refilled)
      clock.advance(3000);

      // Request 1
      const res1 = limiter.consume(clientId);
      expect(res1.allowed).toBe(true);
      expect(res1.remaining).toBe(2);

      // Request 2
      const res2 = limiter.consume(clientId);
      expect(res2.allowed).toBe(true);
      expect(res2.remaining).toBe(1);

      // Request 3
      const res3 = limiter.consume(clientId);
      expect(res3.allowed).toBe(true);
      expect(res3.remaining).toBe(0);

      // Request 4: Throttled (all 3 refilled tokens consumed)
      const res4 = limiter.consume(clientId);
      expect(res4.allowed).toBe(false);
      expect(res4.remaining).toBe(0);
    });
  });

  describe('Bucket Saturation After Prolonged Inactivity', () => {
    const policy: TokenBucketPolicy = {
      capacity: 5,
      refillRate: 1,
      refillIntervalMs: 1000,
    };

    it('caps accumulated tokens strictly at capacity after long idle periods', () => {
      const limiter = new InMemoryTokenBucketRateLimiter(policy, clock);
      const clientId = 'client-idle';

      // Exhaust at t = 0
      for (let i = 0; i < 5; i++) {
        limiter.consume(clientId);
      }

      // Idle for 100,000 ms (100 seconds)
      clock.advance(100_000);

      // Next request: should have 5 tokens, consume 1, leaving exactly 4 (not 99)
      const res = limiter.consume(clientId);
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(4);
      expect(limiter.getTokens(clientId)).toBe(4);
    });
  });

  describe('Fractional Token Accumulation & Precision', () => {
    const policy: TokenBucketPolicy = {
      capacity: 5,
      refillRate: 1,
      refillIntervalMs: 1000, // 0.001 tokens per ms
    };

    it('accumulates fractional tokens across rapid sub-interval checks without truncation loss', () => {
      const limiter = new InMemoryTokenBucketRateLimiter(policy, clock);
      const clientId = 'client-fractional';

      // Exhaust at t = 0
      for (let i = 0; i < 5; i++) {
        limiter.consume(clientId);
      }

      // Perform 10 small advances of 100 ms (each adds 0.1 tokens, total 1.0 token)
      for (let step = 1; step <= 9; step++) {
        clock.advance(100);
        const res = limiter.consume(clientId);
        // Each step has < 1 token, so must be rejected
        expect(res.allowed).toBe(false);
      }

      // 10th step: total elapsed = 1,000 ms (tokens should reach exactly 1.0)
      clock.advance(100);
      const resFinal = limiter.consume(clientId);
      expect(resFinal.allowed).toBe(true);
      expect(resFinal.remaining).toBe(0);
    });
  });

  describe('Custom Token Cost Per Request', () => {
    const policy: TokenBucketPolicy = {
      capacity: 10,
      refillRate: 2,
      refillIntervalMs: 1000,
      costPerRequest: 2, // Default 2 tokens per request
    };

    it('consumes default configured cost per request', () => {
      const limiter = new InMemoryTokenBucketRateLimiter(policy, clock);
      const clientId = 'client-cost-default';

      // 10 capacity, cost 2 -> 5 requests possible
      for (let i = 1; i <= 5; i++) {
        const res = limiter.consume(clientId);
        expect(res.allowed).toBe(true);
        expect(res.remaining).toBe(5 - i);
      }

      const resReject = limiter.consume(clientId);
      expect(resReject.allowed).toBe(false);
      expect(resReject.remaining).toBe(0);
    });

    it('allows overriding token cost per individual consume call', () => {
      const limiter = new InMemoryTokenBucketRateLimiter(policy, clock);
      const clientId = 'client-custom-cost';

      // Initial tokens: 10. Consume 7 tokens.
      const res1 = limiter.consume(clientId, 7);
      expect(res1.allowed).toBe(true);
      expect(limiter.getTokens(clientId)).toBe(3);
      // With default costPerRequest = 2, 3 tokens leave floor(3 / 2) = 1 remaining request
      expect(res1.remaining).toBe(1);

      // Attempt to consume 4 tokens (only 3 available)
      const res2 = limiter.consume(clientId, 4);
      expect(res2.allowed).toBe(false);
      expect(res2.remaining).toBe(0); // floor(3 / 4) = 0
      // Tokens needed: 4 - 3 = 1 token. With refillRate: 2 tokens / 1000 ms (1 token / 500 ms) -> waitMs = 500
      expect(res2.retryAfterSeconds).toBe(1);
    });

    it('throws when requested cost exceeds total bucket capacity', () => {
      const limiter = new InMemoryTokenBucketRateLimiter(policy, clock);
      expect(() => limiter.consume('client-too-expensive', 15)).toThrow(
        'Requested token cost (15) exceeds bucket capacity (10)',
      );
    });
  });

  describe('Client Isolation & State Reset', () => {
    const policy: TokenBucketPolicy = {
      capacity: 5,
      refillRate: 1,
      refillIntervalMs: 1000,
    };

    it('maintains strict quota isolation between independent client keys', () => {
      const limiter = new InMemoryTokenBucketRateLimiter(policy, clock);
      const clientA = 'tenant-a';
      const clientB = 'tenant-b';

      // Exhaust Client A
      for (let i = 0; i < 5; i++) {
        limiter.consume(clientA);
      }
      expect(limiter.consume(clientA).allowed).toBe(false);

      // Client B has full bucket
      const resB = limiter.consume(clientB);
      expect(resB.allowed).toBe(true);
      expect(resB.remaining).toBe(4);
    });

    it('selectively resets specific client without affecting others', () => {
      const limiter = new InMemoryTokenBucketRateLimiter(policy, clock);
      const clientA = 'tenant-reset-a';
      const clientB = 'tenant-reset-b';

      limiter.consume(clientA);
      limiter.consume(clientB);

      limiter.reset(clientA);

      expect(limiter.getTokens(clientA)).toBeNull();
      expect(limiter.getTokens(clientB)).toBe(4);
    });

    it('clears all clients on blanket reset()', () => {
      const limiter = new InMemoryTokenBucketRateLimiter(policy, clock);
      limiter.consume('client-1');
      limiter.consume('client-2');

      limiter.reset();

      expect(limiter.getTokens('client-1')).toBeNull();
      expect(limiter.getTokens('client-2')).toBeNull();
    });
  });

  describe('Clock Skew & Negative Elapsed Time Defense', () => {
    const policy: TokenBucketPolicy = {
      capacity: 5,
      refillRate: 1,
      refillIntervalMs: 1000,
    };

    it('prevents negative elapsed time from deducting tokens when system clock steps backward', () => {
      const limiter = new InMemoryTokenBucketRateLimiter(policy, clock);
      const clientId = 'client-clock-step';

      clock.setTime(10_000);
      limiter.consume(clientId); // 5 - 1 = 4 tokens, lastRefill = 10,000

      // Clock steps backward to 5,000 (e.g. NTP backwards adjustment)
      clock.setTime(5_000);
      const res = limiter.consume(clientId);

      // Clamped to elapsed = 0, so tokens remain 4, consumes 1 -> 3
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(3);
      expect(limiter.getTokens(clientId)).toBe(3);
    });

    it('prevents duplicate token refill when clock steps backward and advances back to previous timestamp', () => {
      const limiter = new InMemoryTokenBucketRateLimiter(policy, clock);
      const clientId = 'client-clock-dup';

      clock.setTime(10_000);
      // Consume all 5 tokens at t = 10,000
      for (let i = 0; i < 5; i++) {
        limiter.consume(clientId);
      }
      expect(limiter.getTokens(clientId)).toBe(0);

      // Clock steps backward to 5,000 and advances to 8,000
      clock.setTime(5_000);
      limiter.consume(clientId); // Throttled, elapsed = 0
      clock.setTime(8_000);
      limiter.consume(clientId); // Throttled, elapsed = 0 (still < 10,000)

      expect(limiter.getTokens(clientId)).toBe(0);

      // Clock advances to 11,000 (1 second past the original 10,000 anchor)
      clock.setTime(11_000);
      const res = limiter.consume(clientId);
      // Exactly 1 token refilled from 10,000 to 11,000 (not 6 tokens from 5,000 to 11,000)
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(0);
      expect(limiter.getTokens(clientId)).toBe(0);
    });

    it('throws when clock returns non-safe-integer or negative timestamp', () => {
      const badClock = { now: () => -50 };
      const limiter = new InMemoryTokenBucketRateLimiter(policy, badClock);
      expect(() => limiter.consume('client-bad-time')).toThrow(
        'Clock returned an invalid timestamp',
      );
    });
  });

  describe('Numerical Robustness & Edge Cases (Phase 09 Corrections)', () => {
    it('rejects premature admission before sufficient refill accrued (reproduction of EPSILON premature grant)', () => {
      const longIntervalPolicy: TokenBucketPolicy = {
        capacity: 1,
        refillRate: 1,
        refillIntervalMs: 1_000_000_000_000,
      };
      const limiter = new InMemoryTokenBucketRateLimiter(longIntervalPolicy, clock);
      const clientId = 'client-long-interval';

      // At t = 0: consume initial token
      const res0 = limiter.consume(clientId);
      expect(res0.allowed).toBe(true);
      expect(res0.remaining).toBe(0);

      // At t = 999_999_999_000 ms: bucket has 0.999999999 tokens (< 1 required).
      // Must be rejected.
      clock.advance(999_999_999_000);
      const resThrottled = limiter.consume(clientId);
      expect(resThrottled.allowed).toBe(false);
      expect(resThrottled.remaining).toBe(0);

      // At t = 1_000_000_000_000 ms: bucket has exactly 1.0 token. Must be admitted.
      clock.advance(1_000);
      const resAllowed = limiter.consume(clientId);
      expect(resAllowed.allowed).toBe(true);
      expect(resAllowed.remaining).toBe(0);
    });

    it('preserves fractional token accrual under rapid 1 ms polling without truncation loss', () => {
      const slowRefillPolicy: TokenBucketPolicy = {
        capacity: 1,
        refillRate: 5e-7,
        refillIntervalMs: 1000,
      };
      const limiter = new InMemoryTokenBucketRateLimiter(slowRefillPolicy, clock);
      const clientId = 'client-polling';

      // Consume initial token at t = 0
      const res0 = limiter.consume(clientId);
      expect(res0.allowed).toBe(true);

      // Poll 1,000 times at 1 ms increments
      for (let i = 0; i < 1000; i++) {
        clock.advance(1);
        const pollRes = limiter.consume(clientId);
        expect(pollRes.allowed).toBe(false);
      }

      // After 1000 ms, accrued fractional tokens should be approximately 5e-7 (not 0)
      const currentTokens = limiter.getTokens(clientId);
      expect(currentTokens).not.toBeNull();
      expect(currentTokens).toBeCloseTo(5e-7, 12);
    });

    it('rejects refill rates and intervals causing numerical underflow or overflow', () => {
      // Underflow: ratePerMs <= 0 due to Number.MIN_VALUE
      expect(
        () =>
          new InMemoryTokenBucketRateLimiter({
            capacity: 1,
            refillRate: Number.MIN_VALUE,
            refillIntervalMs: 1000,
          }),
      ).toThrow(/numerical underflow|positive and finite/i);

      // Overflow: time per token exceeds Number.MAX_SAFE_INTEGER
      expect(
        () =>
          new InMemoryTokenBucketRateLimiter({
            capacity: 1,
            refillRate: 1e-16,
            refillIntervalMs: 1_000_000,
          }),
      ).toThrow(/time per token exceeds Number.MAX_SAFE_INTEGER/i);
    });

    it('admits exactly at refill interval boundary without premature or delayed admission (interval: 49 ms)', () => {
      const boundaryPolicy: TokenBucketPolicy = {
        capacity: 1,
        refillRate: 1,
        refillIntervalMs: 49,
      };
      const limiter = new InMemoryTokenBucketRateLimiter(boundaryPolicy, clock);
      const clientId = 'client-boundary-49';

      // t = 0: consume initial token
      expect(limiter.consume(clientId).allowed).toBe(true);

      // t = 48: must reject
      clock.setTime(48);
      const res48 = limiter.consume(clientId);
      expect(res48.allowed).toBe(false);
      expect(res48.remaining).toBe(0);

      // t = 49: must admit (49 * (1/49) must not round below 1.0)
      clock.setTime(49);
      const res49 = limiter.consume(clientId);
      expect(res49.allowed).toBe(true);
      expect(res49.remaining).toBe(0);
    });

    it('enforces exact refill boundaries for nontrivial rates and intervals', () => {
      const nontrivialPolicy: TokenBucketPolicy = {
        capacity: 5,
        refillRate: 3,
        refillIntervalMs: 70,
      };
      const limiter = new InMemoryTokenBucketRateLimiter(nontrivialPolicy, clock);
      const clientId = 'client-nontrivial-refill';

      // Exhaust all 5 tokens at t = 0
      for (let i = 0; i < 5; i++) {
        limiter.consume(clientId);
      }
      expect(limiter.consume(clientId).allowed).toBe(false);

      // At t = 69: (69 * 3) / 70 = 2.957 tokens refilled. Consuming cost 3 must be throttled.
      clock.setTime(69);
      expect(limiter.consume(clientId, 3).allowed).toBe(false);

      // At t = 70: exactly 3.0 tokens refilled. Consuming cost 3 must succeed.
      clock.setTime(70);
      const res70 = limiter.consume(clientId, 3);
      expect(res70.allowed).toBe(true);
      expect(res70.remaining).toBe(0);

      // At t = 140: exactly another 3.0 tokens refilled.
      clock.setTime(140);
      const res140 = limiter.consume(clientId, 3);
      expect(res140.allowed).toBe(true);
    });
  });

  describe('Policy Configuration Validation', () => {
    it('rejects invalid capacity values', () => {
      expect(
        () =>
          new InMemoryTokenBucketRateLimiter({
            capacity: 0,
            refillRate: 1,
            refillIntervalMs: 1000,
          }),
      ).toThrow('Capacity must be a positive safe integer');

      expect(
        () =>
          new InMemoryTokenBucketRateLimiter({
            capacity: -5,
            refillRate: 1,
            refillIntervalMs: 1000,
          }),
      ).toThrow('Capacity must be a positive safe integer');

      expect(
        () =>
          new InMemoryTokenBucketRateLimiter({
            capacity: 2.5,
            refillRate: 1,
            refillIntervalMs: 1000,
          }),
      ).toThrow('Capacity must be a positive safe integer');
    });

    it('rejects invalid refill rates and intervals', () => {
      expect(
        () =>
          new InMemoryTokenBucketRateLimiter({
            capacity: 5,
            refillRate: 0,
            refillIntervalMs: 1000,
          }),
      ).toThrow('Refill rate must be a positive number');

      expect(
        () =>
          new InMemoryTokenBucketRateLimiter({
            capacity: 5,
            refillRate: -1,
            refillIntervalMs: 1000,
          }),
      ).toThrow('Refill rate must be a positive number');

      expect(
        () =>
          new InMemoryTokenBucketRateLimiter({
            capacity: 5,
            refillRate: 1,
            refillIntervalMs: 0,
          }),
      ).toThrow('Refill interval must be a positive safe integer');
    });

    it('rejects invalid costPerRequest configuration', () => {
      expect(
        () =>
          new InMemoryTokenBucketRateLimiter({
            capacity: 5,
            refillRate: 1,
            refillIntervalMs: 1000,
            costPerRequest: 0,
          }),
      ).toThrow('Cost per request must be a positive safe integer');

      expect(
        () =>
          new InMemoryTokenBucketRateLimiter({
            capacity: 5,
            refillRate: 1,
            refillIntervalMs: 1000,
            costPerRequest: 10,
          }),
      ).toThrow('Cost per request cannot exceed bucket capacity');
    });

    it('rejects empty or whitespace-only client keys', () => {
      const limiter = new InMemoryTokenBucketRateLimiter({
        capacity: 5,
        refillRate: 1,
        refillIntervalMs: 1000,
      });

      expect(() => limiter.consume('')).toThrow('Rate limit key must be a non-empty string');
      expect(() => limiter.consume('   ')).toThrow('Rate limit key must be a non-empty string');
    });
  });
});
