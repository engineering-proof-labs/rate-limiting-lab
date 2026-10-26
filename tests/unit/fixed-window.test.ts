import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryFixedWindowRateLimiter } from '../../src/core/fixed-window.js';
import { VirtualClock } from '../../src/core/clock.js';
import type { RateLimitPolicy } from '../../src/core/types.js';

describe('InMemoryFixedWindowRateLimiter', () => {
  let clock: VirtualClock;
  const INITIAL_TIMESTAMP_MS = 100_000;

  beforeEach(() => {
    clock = new VirtualClock(INITIAL_TIMESTAMP_MS);
  });

  describe.each([
    {
      name: 'Standard Baseline (5 req / 60,000 ms)',
      policy: { limit: 5, windowMs: 60_000 } satisfies RateLimitPolicy,
      expectedInitialResetTimeMs: 120_000,
      expectedNextResetTimeMs: 180_000,
    },
    {
      name: 'Regression Fixture (5 req / 1,000 ms)',
      policy: { limit: 5, windowMs: 1_000 } satisfies RateLimitPolicy,
      expectedInitialResetTimeMs: 101_000,
      expectedNextResetTimeMs: 102_000,
    },
  ])('$name', ({ policy, expectedInitialResetTimeMs, expectedNextResetTimeMs }) => {
    it('admits requests within quota and decrements remaining allowance', () => {
      const limiter = new InMemoryFixedWindowRateLimiter(policy, clock);
      const clientId = 'client_1';

      for (let count = 1; count <= policy.limit; count++) {
        const result = limiter.consume(clientId);
        expect(result.allowed).toBe(true);
        expect(result.limit).toBe(policy.limit);
        expect(result.remaining).toBe(policy.limit - count);
        expect(result.resetTimeMs).toBe(expectedInitialResetTimeMs);
        expect(result.retryAfterSeconds).toBeUndefined();
      }
    });

    it('rejects requests once limit is reached and calculates retry duration', () => {
      const limiter = new InMemoryFixedWindowRateLimiter(policy, clock);
      const clientId = 'client_1';

      for (let i = 0; i < policy.limit; i++) {
        limiter.consume(clientId);
      }

      const rejection = limiter.consume(clientId);
      expect(rejection.allowed).toBe(false);
      expect(rejection.remaining).toBe(0);
      expect(rejection.resetTimeMs).toBe(expectedInitialResetTimeMs);

      const expectedRetrySeconds = Math.ceil(
        (expectedInitialResetTimeMs - INITIAL_TIMESTAMP_MS) / 1000,
      );
      expect(rejection.retryAfterSeconds).toBe(expectedRetrySeconds);
    });

    it('maintains independent quotas for distinct client keys', () => {
      const limiter = new InMemoryFixedWindowRateLimiter(policy, clock);

      for (let i = 0; i < policy.limit; i++) {
        limiter.consume('client_A');
      }
      expect(limiter.consume('client_A').allowed).toBe(false);

      const resultB = limiter.consume('client_B');
      expect(resultB.allowed).toBe(true);
      expect(resultB.remaining).toBe(policy.limit - 1);
    });

    it('blocks requests 1 ms prior to window boundary', () => {
      const limiter = new InMemoryFixedWindowRateLimiter(policy, clock);
      const clientId = 'client_1';

      for (let i = 0; i < policy.limit; i++) {
        limiter.consume(clientId);
      }

      clock.setTime(expectedInitialResetTimeMs - 1);
      const blocked = limiter.consume(clientId);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.retryAfterSeconds).toBe(1);
    });

    it('admits and counts first request at exact window boundary', () => {
      const limiter = new InMemoryFixedWindowRateLimiter(policy, clock);
      const clientId = 'client_1';

      for (let i = 0; i < policy.limit; i++) {
        limiter.consume(clientId);
      }

      clock.setTime(expectedInitialResetTimeMs);

      const rollover = limiter.consume(clientId);
      expect(rollover.allowed).toBe(true);
      expect(rollover.remaining).toBe(policy.limit - 1);
      expect(rollover.resetTimeMs).toBe(expectedNextResetTimeMs);
    });

    it('re-enforces full quota in new window after quota exhaustion and multiple rejections', () => {
      const limiter = new InMemoryFixedWindowRateLimiter(policy, clock);
      const clientId = 'client_1';

      for (let i = 0; i < policy.limit; i++) {
        limiter.consume(clientId);
      }

      // Multiple rejections in current window
      for (let i = 0; i < 5; i++) {
        const rejected = limiter.consume(clientId);
        expect(rejected.allowed).toBe(false);
        expect(rejected.remaining).toBe(0);
      }

      // Transition to next window
      clock.setTime(expectedInitialResetTimeMs);

      for (let count = 1; count <= policy.limit; count++) {
        const admitted = limiter.consume(clientId);
        expect(admitted.allowed).toBe(true);
        expect(admitted.remaining).toBe(policy.limit - count);
      }

      const blockedAgain = limiter.consume(clientId);
      expect(blockedAgain.allowed).toBe(false);
      expect(blockedAgain.remaining).toBe(0);
    });

    it('clears state on reset', () => {
      const limiter = new InMemoryFixedWindowRateLimiter(policy, clock);

      for (let i = 0; i < policy.limit; i++) {
        limiter.consume('client_A');
        limiter.consume('client_B');
      }

      limiter.reset('client_A');
      expect(limiter.consume('client_A').allowed).toBe(true);
      expect(limiter.consume('client_B').allowed).toBe(false);

      limiter.reset();
      expect(limiter.consume('client_B').allowed).toBe(true);
    });
  });

  describe('Policy Immutability & Numeric Validation', () => {
    it('prevents external mutation of policy after construction', () => {
      const mutablePolicy = { limit: 5, windowMs: 1000 };
      const limiter = new InMemoryFixedWindowRateLimiter(mutablePolicy, clock);

      // Mutate original object
      mutablePolicy.limit = 100;
      mutablePolicy.windowMs = 50000;

      expect(limiter.policy.limit).toBe(5);
      expect(limiter.policy.windowMs).toBe(1000);
      expect(() => {
        // @ts-expect-error - testing runtime freeze
        limiter.policy.limit = 999;
      }).toThrow();
    });

    it('rejects invalid limit values (<= 0, non-integer, NaN, Infinity, unsafe numbers)', () => {
      const invalidLimits = [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];

      for (const limit of invalidLimits) {
        expect(() => new InMemoryFixedWindowRateLimiter({ limit, windowMs: 1000 })).toThrow(
          /Rate limit must be a positive safe integer/,
        );
      }
    });

    it('rejects invalid windowMs values (<= 0, non-integer, NaN, Infinity, unsafe numbers)', () => {
      const invalidDurations = [
        0,
        -1,
        500.5,
        NaN,
        Infinity,
        -Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ];

      for (const windowMs of invalidDurations) {
        expect(() => new InMemoryFixedWindowRateLimiter({ limit: 5, windowMs })).toThrow(
          /Window duration must be a positive safe integer/,
        );
      }
    });
  });

  describe('VirtualClock Constraints', () => {
    it('validates construction and advance arguments', () => {
      expect(() => new VirtualClock(-1)).toThrow(/non-negative safe integer/);
      expect(() => new VirtualClock(NaN)).toThrow(/non-negative safe integer/);

      const vClock = new VirtualClock(100);
      expect(() => vClock.advance(-10)).toThrow(/non-negative safe integer/);
      expect(() => vClock.advance(NaN)).toThrow(/non-negative safe integer/);
      expect(() => vClock.setTime(-50)).toThrow(/non-negative safe integer/);
    });
  });
});
