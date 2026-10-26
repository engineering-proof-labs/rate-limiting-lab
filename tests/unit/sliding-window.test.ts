import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySlidingWindowLogRateLimiter } from '../../src/core/sliding-window-log.js';
import { InMemorySlidingWindowCounterRateLimiter } from '../../src/core/sliding-window-counter.js';
import { VirtualClock } from '../../src/core/clock.js';
import type { RateLimitPolicy } from '../../src/core/types.js';

describe('Phase 10 — Sliding Window In-Memory Reference Algorithms', () => {
  let clock: VirtualClock;

  beforeEach(() => {
    clock = new VirtualClock(0);
  });

  describe('A. InMemorySlidingWindowLogRateLimiter (Exact Log)', () => {
    const policy: RateLimitPolicy = {
      limit: 5,
      windowMs: 1000,
    };

    it('initializes fresh client, admits initial burst up to limit, and exhausts quota', () => {
      const limiter = new InMemorySlidingWindowLogRateLimiter(policy, clock);
      const clientId = 'client-log-burst';

      for (let i = 1; i <= 5; i++) {
        const res = limiter.consume(clientId);
        expect(res.allowed).toBe(true);
        expect(res.limit).toBe(5);
        expect(res.remaining).toBe(5 - i);
        expect(res.resetTimeMs).toBe(1000); // 0 + 1000
      }

      // 6th request at t = 0 is rejected
      const res6 = limiter.consume(clientId);
      expect(res6.allowed).toBe(false);
      expect(res6.remaining).toBe(0);
      expect(res6.retryAfterSeconds).toBe(1);
      expect(res6.resetTimeMs).toBe(1000);
    });

    it('enforces exact interval boundaries: throttles at 999 ms and admits at 1000 ms', () => {
      const limiter = new InMemorySlidingWindowLogRateLimiter(policy, clock);
      const clientId = 'client-log-boundary';

      // 1 request at t = 0
      limiter.consume(clientId);

      // 4 requests at t = 500 ms (total 5 active)
      clock.setTime(500);
      for (let i = 0; i < 4; i++) {
        limiter.consume(clientId);
      }

      // At t = 999 ms: the request at t = 0 has NOT expired (0 > 999 - 1000 is false, wait: 999 - 1000 = -1, so 0 > -1 is true)
      clock.setTime(999);
      const res999 = limiter.consume(clientId);
      expect(res999.allowed).toBe(false);
      expect(res999.remaining).toBe(0);

      // At t = 1000 ms: windowStart = 0. The request at t = 0 has expired (0 <= 0). Exactly 1 slot opens.
      clock.setTime(1000);
      const res1000 = limiter.consume(clientId);
      expect(res1000.allowed).toBe(true);
      expect(res1000.remaining).toBe(0); // 5 active: 4 at t=500, 1 at t=1000

      // Immediately throttles 2nd request at t = 1000 ms
      const res1000B = limiter.consume(clientId);
      expect(res1000B.allowed).toBe(false);

      // At t = 1500 ms: windowStart = 500. The 4 requests from t = 500 expire (500 <= 500). 4 slots open!
      clock.setTime(1500);
      for (let i = 1; i <= 4; i++) {
        const res = limiter.consume(clientId);
        expect(res.allowed).toBe(true);
        expect(res.remaining).toBe(4 - i);
      }
      expect(limiter.consume(clientId).allowed).toBe(false);
    });

    it('handles consecutive bursts distributed across the rolling window', () => {
      const limiter = new InMemorySlidingWindowLogRateLimiter(policy, clock);
      const clientId = 'client-log-bursts';

      // 3 requests at t = 100
      clock.setTime(100);
      limiter.consume(clientId);
      limiter.consume(clientId);
      limiter.consume(clientId);

      // 2 requests at t = 400
      clock.setTime(400);
      limiter.consume(clientId);
      limiter.consume(clientId);

      // Quota exhausted (5 requests)
      expect(limiter.consume(clientId).allowed).toBe(false);

      // Advance to t = 1100 (t=100 requests expire)
      clock.setTime(1100);
      // 3 slots available
      expect(limiter.consume(clientId).allowed).toBe(true);
      expect(limiter.consume(clientId).allowed).toBe(true);
      expect(limiter.consume(clientId).allowed).toBe(true);
      expect(limiter.consume(clientId).allowed).toBe(false);
    });

    it('bounds memory: does not append rejected requests to the timestamp log', () => {
      const limiter = new InMemorySlidingWindowLogRateLimiter(policy, clock);
      const clientId = 'client-log-memory';

      // Exhaust quota (5 requests)
      for (let i = 0; i < 5; i++) {
        limiter.consume(clientId);
      }

      // Send 50 rejected requests
      for (let i = 0; i < 50; i++) {
        const res = limiter.consume(clientId);
        expect(res.allowed).toBe(false);
      }

      // The internal active timestamps array must be capped strictly at limit (5), not 55
      const timestamps = limiter.getTimestamps(clientId);
      expect(timestamps).not.toBeNull();
      expect(timestamps!.length).toBe(5);
    });

    it('maintains strict isolation between client identities', () => {
      const limiter = new InMemorySlidingWindowLogRateLimiter(policy, clock);
      const clientA = 'tenant-a';
      const clientB = 'tenant-b';

      for (let i = 0; i < 5; i++) {
        limiter.consume(clientA);
      }
      expect(limiter.consume(clientA).allowed).toBe(false);

      // Client B is completely unconstrained
      const resB = limiter.consume(clientB);
      expect(resB.allowed).toBe(true);
      expect(resB.remaining).toBe(4);
    });

    it('resets specific client or all clients cleanly', () => {
      const limiter = new InMemorySlidingWindowLogRateLimiter(policy, clock);
      limiter.consume('client-1');
      limiter.consume('client-2');

      limiter.reset('client-1');
      expect(limiter.getTimestamps('client-1')).toBeNull();
      expect(limiter.getTimestamps('client-2')!.length).toBe(1);

      limiter.reset();
      expect(limiter.getTimestamps('client-2')).toBeNull();
    });

    it('defends against backward clock adjustments without granting duplicate quota', () => {
      const limiter = new InMemorySlidingWindowLogRateLimiter(policy, clock);
      const clientId = 'client-clock-step';

      clock.setTime(10_000);
      for (let i = 0; i < 5; i++) {
        limiter.consume(clientId);
      }
      expect(limiter.consume(clientId).allowed).toBe(false);

      // System clock regresses backward to 5,000
      clock.setTime(5_000);
      const resRegressed = limiter.consume(clientId);
      // Window start is 5000 - 1000 = 4000. Existing timestamps (10000) are > 4000, so not pruned.
      // Request remains rejected!
      expect(resRegressed.allowed).toBe(false);
      expect(resRegressed.remaining).toBe(0);
    });

    it('validates constructor policy parameters and keys', () => {
      expect(() => new InMemorySlidingWindowLogRateLimiter({ limit: 0, windowMs: 1000 })).toThrow(
        'Rate limit must be a positive safe integer',
      );
      expect(() => new InMemorySlidingWindowLogRateLimiter({ limit: 5, windowMs: -100 })).toThrow(
        'Window duration must be a positive safe integer',
      );

      const limiter = new InMemorySlidingWindowLogRateLimiter(policy, clock);
      expect(() => limiter.consume('')).toThrow('Rate limit key must be a non-empty string');
      expect(() => limiter.consume('   ')).toThrow('Rate limit key must be a non-empty string');
    });
  });

  describe('B. InMemorySlidingWindowCounterRateLimiter (Weighted Approximation)', () => {
    const policy: RateLimitPolicy = {
      limit: 5,
      windowMs: 1000,
    };

    it('initializes fresh client and exhausts capacity in initial fixed window', () => {
      const limiter = new InMemorySlidingWindowCounterRateLimiter(policy, clock);
      const clientId = 'client-counter-burst';

      for (let i = 1; i <= 5; i++) {
        const res = limiter.consume(clientId);
        expect(res.allowed).toBe(true);
        expect(res.limit).toBe(5);
        expect(res.remaining).toBe(5 - i);
        expect(res.resetTimeMs).toBe(1000);
      }

      const res6 = limiter.consume(clientId);
      expect(res6.allowed).toBe(false);
      expect(res6.remaining).toBe(0);
      expect(res6.retryAfterSeconds).toBe(1);
    });

    it('calculates weighted estimate across adjacent windows based on elapsed fraction', () => {
      const limiter = new InMemorySlidingWindowCounterRateLimiter(policy, clock);
      const clientId = 'client-counter-weighted';

      // 5 requests in Window 0 (t = 0..999)
      for (let i = 0; i < 5; i++) {
        limiter.consume(clientId);
      }

      // Advance to t = 1200 (Window 1, 200 ms elapsed)
      // weight = (1000 - 200) / 1000 = 0.8
      // estimatedCount = 5 * 0.8 + 0 = 4.0
      clock.setTime(1200);
      expect(limiter.getEstimatedCount(clientId)).toBeCloseTo(4.0, 5);

      // Since estimatedCount (4.0) < limit (5), 1 request is admitted
      const res1 = limiter.consume(clientId);
      expect(res1.allowed).toBe(true);
      // After admission, currentCount = 1, estimatedCount becomes 5.0
      expect(limiter.getEstimatedCount(clientId)).toBeCloseTo(5.0, 5);
      expect(res1.remaining).toBe(0);

      // 2nd request at t = 1200 is throttled because estimatedCount (5.0) >= limit (5)
      const res2 = limiter.consume(clientId);
      expect(res2.allowed).toBe(false);

      // Advance to t = 1500 (Window 1, 500 ms elapsed)
      // weight = (1000 - 500) / 1000 = 0.5
      // estimatedCount = 5 * 0.5 + 1 = 3.5
      clock.setTime(1500);
      expect(limiter.getEstimatedCount(clientId)).toBeCloseTo(3.5, 5);

      // Admitted: floor(3.5 + 1) = 4, remaining = 5 - 4 = 1
      const res3 = limiter.consume(clientId);
      expect(res3.allowed).toBe(true);
      expect(res3.remaining).toBe(1);

      // Consume the remaining slot at t = 1500: estimatedCount = 2.5 + 2 = 4.5 < 5 -> admitted, remaining = 0
      const res4 = limiter.consume(clientId);
      expect(res4.allowed).toBe(true);
      expect(res4.remaining).toBe(0);

      // 5th request at t = 1500: estimatedCount = 2.5 + 3 = 5.5 >= 5 -> throttled
      const res5 = limiter.consume(clientId);
      expect(res5.allowed).toBe(false);
    });

    it('demonstrates explicit mathematical divergence from exact Sliding Window Log', () => {
      // Comparison scenario:
      // In Window 0, 5 requests are sent all at t = 100 ms.
      // At t = 1200 ms:
      // - In Sliding Window Log: window is [200, 1200]. The requests at t = 100 have expired! Exact count = 0.
      // - In Sliding Window Counter: assumes uniform distribution in previous window.
      //   weight = 0.8, estimatedCount = 5 * 0.8 = 4.0.
      const logLimiter = new InMemorySlidingWindowLogRateLimiter(policy, clock);
      const counterLimiter = new InMemorySlidingWindowCounterRateLimiter(policy, clock);
      const clientId = 'client-compare';

      clock.setTime(100);
      for (let i = 0; i < 5; i++) {
        logLimiter.consume(clientId);
        counterLimiter.consume(clientId);
      }

      clock.setTime(1200);

      // Exact Log has 0 active requests, so all 5 are permitted
      const logRes = logLimiter.consume(clientId);
      expect(logRes.allowed).toBe(true);
      expect(logRes.remaining).toBe(4);

      // Counter Limiter estimates 4.0 active requests from previous window, permitting only 1 request
      const counterRes1 = counterLimiter.consume(clientId);
      expect(counterRes1.allowed).toBe(true);
      expect(counterRes1.remaining).toBe(0); // 5 - floor(4 + 1) = 0

      // Immediately throttled on second attempt (demonstrating approximation difference)
      const counterRes2 = counterLimiter.consume(clientId);
      expect(counterRes2.allowed).toBe(false);
    });

    it('ages out previous window counts after more than 1 window duration of inactivity', () => {
      const limiter = new InMemorySlidingWindowCounterRateLimiter(policy, clock);
      const clientId = 'client-counter-idle';

      // Window 0: consume all 5
      for (let i = 0; i < 5; i++) {
        limiter.consume(clientId);
      }

      // Advance by 2,500 ms (to Window 2, t = 2500)
      // Window 0 is completely aged out (more than 1 window elapsed)
      clock.setTime(2500);
      expect(limiter.getEstimatedCount(clientId)).toBe(0);

      // Fresh burst of 5 requests permitted in Window 2
      for (let i = 1; i <= 5; i++) {
        const res = limiter.consume(clientId);
        expect(res.allowed).toBe(true);
        expect(res.remaining).toBe(5 - i);
      }
    });

    it('maintains strict isolation between client identities', () => {
      const limiter = new InMemorySlidingWindowCounterRateLimiter(policy, clock);
      const clientA = 'tenant-counter-a';
      const clientB = 'tenant-counter-b';

      for (let i = 0; i < 5; i++) {
        limiter.consume(clientA);
      }
      expect(limiter.consume(clientA).allowed).toBe(false);

      const resB = limiter.consume(clientB);
      expect(resB.allowed).toBe(true);
      expect(resB.remaining).toBe(4);
    });

    it('resets specific client or all clients cleanly', () => {
      const limiter = new InMemorySlidingWindowCounterRateLimiter(policy, clock);
      limiter.consume('client-1');
      limiter.consume('client-2');

      limiter.reset('client-1');
      expect(limiter.getEstimatedCount('client-1')).toBeNull();
      expect(limiter.getEstimatedCount('client-2')).not.toBeNull();

      limiter.reset();
      expect(limiter.getEstimatedCount('client-2')).toBeNull();
    });

    it('defends against backward clock adjustments without granting duplicate quota', () => {
      const limiter = new InMemorySlidingWindowCounterRateLimiter(policy, clock);
      const clientId = 'client-counter-clock-step';

      clock.setTime(10_000); // Window 10
      for (let i = 0; i < 5; i++) {
        limiter.consume(clientId);
      }
      expect(limiter.consume(clientId).allowed).toBe(false);

      // System clock steps backward to 5,000 (Window 5)
      clock.setTime(5_000);
      const res = limiter.consume(clientId);
      // Defensive check: does not reset counters to 0 or regress windowId
      expect(res.allowed).toBe(false);
      expect(res.remaining).toBe(0);
    });

    it('validates constructor policy parameters and keys', () => {
      expect(
        () => new InMemorySlidingWindowCounterRateLimiter({ limit: -1, windowMs: 1000 }),
      ).toThrow('Rate limit must be a positive safe integer');
      expect(() => new InMemorySlidingWindowCounterRateLimiter({ limit: 5, windowMs: 0 })).toThrow(
        'Window duration must be a positive safe integer',
      );

      const limiter = new InMemorySlidingWindowCounterRateLimiter(policy, clock);
      expect(() => limiter.consume('')).toThrow('Rate limit key must be a non-empty string');
      expect(() => limiter.consume('   ')).toThrow('Rate limit key must be a non-empty string');
    });
  });
});
