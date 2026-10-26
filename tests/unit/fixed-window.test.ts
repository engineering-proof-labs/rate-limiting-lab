import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryFixedWindowRateLimiter } from '../../src/core/fixed-window.js';
import { VirtualClock } from '../../src/core/clock.js';
import type { RateLimitPolicy } from '../../src/core/types.js';

describe('InMemoryFixedWindowRateLimiter', () => {
  let clock: VirtualClock;

  beforeEach(() => {
    // Start at a known fixed epoch timestamp (e.g. 100,000 ms)
    clock = new VirtualClock(100_000);
  });

  describe.each([
    {
      name: 'Standard Baseline Profile (5 req / 60,000 ms)',
      policy: { limit: 5, windowMs: 60_000 } satisfies RateLimitPolicy,
    },
    {
      name: 'Assessment Regression Fixture (5 req / 1,000 ms)',
      policy: { limit: 5, windowMs: 1_000 } satisfies RateLimitPolicy,
    },
  ])('$name', ({ policy }) => {
    it('admits initial requests and decrements remaining quota down to zero', () => {
      const limiter = new InMemoryFixedWindowRateLimiter(policy, clock);
      const clientId = 'client_test';

      for (let i = 1; i <= policy.limit; i++) {
        const result = limiter.consume(clientId);
        expect(result.allowed).toBe(true);
        expect(result.limit).toBe(policy.limit);
        expect(result.remaining).toBe(policy.limit - i);
        expect(result.retryAfterSeconds).toBeUndefined();
      }
    });

    it('rejects the 6th request with HTTP 429 semantics (allowed=false, remaining=0, retryAfterSeconds present)', () => {
      const limiter = new InMemoryFixedWindowRateLimiter(policy, clock);
      const clientId = 'client_test';

      // Exhaust quota
      for (let i = 0; i < policy.limit; i++) {
        limiter.consume(clientId);
      }

      // 6th request
      const rejection = limiter.consume(clientId);
      expect(rejection.allowed).toBe(false);
      expect(rejection.remaining).toBe(0);
      expect(rejection.limit).toBe(policy.limit);
      expect(rejection.retryAfterSeconds).toBeGreaterThan(0);
      expect(Number.isInteger(rejection.retryAfterSeconds)).toBe(true);
    });

    it('saturates the counter and keeps remaining at 0 for subsequent rejected requests', () => {
      const limiter = new InMemoryFixedWindowRateLimiter(policy, clock);
      const clientId = 'client_test';

      for (let i = 0; i < policy.limit; i++) {
        limiter.consume(clientId);
      }

      // Requests 6, 7, 8
      for (let i = 0; i < 3; i++) {
        const rej = limiter.consume(clientId);
        expect(rej.allowed).toBe(false);
        expect(rej.remaining).toBe(0);
      }

      // Verify internal counter is capped at limit + 1
      const state = limiter.getClientState(clientId);
      expect(state?.count).toBe(policy.limit + 1);
    });

    it('maintains strict isolation between different client identifiers', () => {
      const limiter = new InMemoryFixedWindowRateLimiter(policy, clock);
      const clientA = 'client_A';
      const clientB = 'client_B';

      // Exhaust Client A
      for (let i = 0; i < policy.limit; i++) {
        limiter.consume(clientA);
      }
      expect(limiter.consume(clientA).allowed).toBe(false);

      // Client B should have full quota available
      const firstB = limiter.consume(clientB);
      expect(firstB.allowed).toBe(true);
      expect(firstB.remaining).toBe(policy.limit - 1);
    });

    it('remains throttled before the exact window boundary', () => {
      const limiter = new InMemoryFixedWindowRateLimiter(policy, clock);
      const clientId = 'client_test';

      const initial = limiter.consume(clientId);
      for (let i = 1; i < policy.limit; i++) {
        limiter.consume(clientId);
      }
      expect(limiter.consume(clientId).allowed).toBe(false);

      // Advance time to 1 ms before the window boundary
      clock.setTime(initial.resetTimeMs - 1);
      const stillBlocked = limiter.consume(clientId);
      expect(stillBlocked.allowed).toBe(false);
      expect(stillBlocked.remaining).toBe(0);
      expect(stillBlocked.retryAfterSeconds).toBe(1);
    });

    it('admits and counts the first request at the exact window boundary', () => {
      const limiter = new InMemoryFixedWindowRateLimiter(policy, clock);
      const clientId = 'client_test';

      const firstResult = limiter.consume(clientId);
      for (let i = 1; i < policy.limit; i++) {
        limiter.consume(clientId);
      }
      expect(limiter.consume(clientId).allowed).toBe(false);

      // Advance clock to exact boundary timestamp
      clock.setTime(firstResult.resetTimeMs);

      // First request in new window: must be admitted AND counted
      const newWindowFirst = limiter.consume(clientId);
      expect(newWindowFirst.allowed).toBe(true);
      expect(newWindowFirst.remaining).toBe(policy.limit - 1);
      expect(newWindowFirst.resetTimeMs).toBe(firstResult.resetTimeMs + policy.windowMs);

      // Check internal state: count should be 1
      const state = limiter.getClientState(clientId);
      expect(state?.count).toBe(1);
    });

    it('allows full quota again in the new window before rejecting on the 6th request', () => {
      const limiter = new InMemoryFixedWindowRateLimiter(policy, clock);
      const clientId = 'client_test';

      const firstResult = limiter.consume(clientId);
      for (let i = 1; i < policy.limit; i++) {
        limiter.consume(clientId);
      }

      // Transition to new window
      clock.setTime(firstResult.resetTimeMs);

      // Consume full quota in new window (requests 1 through 5)
      for (let i = 1; i <= policy.limit; i++) {
        const res = limiter.consume(clientId);
        expect(res.allowed).toBe(true);
        expect(res.remaining).toBe(policy.limit - i);
      }

      // 6th request in new window must be rejected
      const rejectedAgain = limiter.consume(clientId);
      expect(rejectedAgain.allowed).toBe(false);
      expect(rejectedAgain.remaining).toBe(0);
    });

    it('supports manual reset of state', () => {
      const limiter = new InMemoryFixedWindowRateLimiter(policy, clock);
      const clientA = 'client_A';
      const clientB = 'client_B';

      for (let i = 0; i < policy.limit; i++) {
        limiter.consume(clientA);
        limiter.consume(clientB);
      }
      expect(limiter.consume(clientA).allowed).toBe(false);
      expect(limiter.consume(clientB).allowed).toBe(false);

      // Reset only client A
      limiter.reset(clientA);
      expect(limiter.consume(clientA).allowed).toBe(true);
      expect(limiter.consume(clientB).allowed).toBe(false);

      // Reset all
      limiter.reset();
      expect(limiter.consume(clientB).allowed).toBe(true);
    });
  });

  describe('Policy Validation', () => {
    it('throws error for non-positive or non-integer limits', () => {
      expect(() => new InMemoryFixedWindowRateLimiter({ limit: 0, windowMs: 1000 })).toThrow(
        /Rate limit must be a positive integer/,
      );
      expect(() => new InMemoryFixedWindowRateLimiter({ limit: -5, windowMs: 1000 })).toThrow(
        /Rate limit must be a positive integer/,
      );
      expect(() => new InMemoryFixedWindowRateLimiter({ limit: 2.5, windowMs: 1000 })).toThrow(
        /Rate limit must be a positive integer/,
      );
    });

    it('throws error for non-positive or non-integer window durations', () => {
      expect(() => new InMemoryFixedWindowRateLimiter({ limit: 5, windowMs: 0 })).toThrow(
        /Window duration must be a positive integer/,
      );
      expect(() => new InMemoryFixedWindowRateLimiter({ limit: 5, windowMs: -1000 })).toThrow(
        /Window duration must be a positive integer/,
      );
      expect(() => new InMemoryFixedWindowRateLimiter({ limit: 5, windowMs: 500.5 })).toThrow(
        /Window duration must be a positive integer/,
      );
    });
  });

  describe('VirtualClock Edge Cases', () => {
    it('prevents negative time advances', () => {
      const vClock = new VirtualClock(1000);
      expect(() => vClock.advance(-100)).toThrow(/cannot advance backwards/);
    });
  });
});
