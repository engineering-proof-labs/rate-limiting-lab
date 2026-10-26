import type { Clock, RateLimitPolicy, RateLimitResult } from './types.js';
import { SystemClock } from './clock.js';

interface ClientCounterState {
  currentWindowId: number;
  currentCount: number;
  previousCount: number;
}

/**
 * In-memory reference implementation of the Sliding Window Counter rate limiting algorithm.
 *
 * Operational contract:
 * - Weighted approximation: Approximates a continuous sliding window by computing a weighted
 *   sum of requests across the current and previous fixed epoch windows.
 * - Weighting formula:
 *     timeInCurrentWindow = nowMs % windowMs
 *     previousWindowWeight = (windowMs - timeInCurrentWindow) / windowMs
 *     estimatedCount = previousCount * previousWindowWeight + currentCount
 * - Approximation limitation: Assumes uniform request distribution across the previous window.
 *   If previous-window traffic was concentrated near the boundary, this can slightly underestimate
 *   rolling usage (admitting an edge burst); if concentrated early in the previous window, it can
 *   overestimate rolling usage.
 * - Memory efficiency: Requires only O(1) storage per client (two integer counters and a window ID),
 *   avoiding the unbounded memory growth of timestamp logs under high traffic.
 * - Reset time: Aligned to the end of the current fixed window: (currentWindowId + 1) * windowMs.
 */
export class InMemorySlidingWindowCounterRateLimiter {
  public readonly policy: Readonly<RateLimitPolicy>;
  private readonly clients = new Map<string, ClientCounterState>();

  constructor(
    policy: RateLimitPolicy,
    private readonly clock: Clock = new SystemClock(),
  ) {
    this.validatePolicy(policy);
    this.policy = Object.freeze({ ...policy });
  }

  private validatePolicy(policy: RateLimitPolicy): void {
    if (!Number.isSafeInteger(policy.limit) || policy.limit <= 0) {
      throw new Error('Rate limit must be a positive safe integer');
    }
    if (!Number.isSafeInteger(policy.windowMs) || policy.windowMs <= 0) {
      throw new Error('Window duration must be a positive safe integer in milliseconds');
    }
  }

  public consume(key: string): RateLimitResult {
    if (!key || key.trim().length === 0) {
      throw new Error('Rate limit key must be a non-empty string');
    }

    const nowMs = this.clock.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error('Clock returned an invalid timestamp');
    }

    const windowId = Math.floor(nowMs / this.policy.windowMs);
    const resetTimeMs = (windowId + 1) * this.policy.windowMs;

    let state = this.clients.get(key);

    if (!state) {
      state = {
        currentWindowId: windowId,
        currentCount: 0,
        previousCount: 0,
      };
      this.clients.set(key, state);
    } else if (windowId === state.currentWindowId + 1) {
      // Transitioned to next adjacent window
      state.previousCount = state.currentCount;
      state.currentCount = 0;
      state.currentWindowId = windowId;
    } else if (windowId > state.currentWindowId + 1) {
      // More than 1 full window elapsed; previous counts have completely aged out
      state.previousCount = 0;
      state.currentCount = 0;
      state.currentWindowId = windowId;
    }
    // If windowId < state.currentWindowId (clock regression), keep current state defensively

    const timeInCurrentWindow = nowMs % this.policy.windowMs;
    const previousWeight = (this.policy.windowMs - timeInCurrentWindow) / this.policy.windowMs;
    const estimatedCount = state.previousCount * previousWeight + state.currentCount;

    if (estimatedCount < this.policy.limit) {
      state.currentCount += 1;
      const remaining = Math.max(0, this.policy.limit - Math.floor(estimatedCount + 1));

      return {
        allowed: true,
        limit: this.policy.limit,
        remaining,
        resetTimeMs,
      };
    }

    // Quota exhausted: derive earliest-admission time from the decaying weighted counter
    // Admission occurs when: previousCount * ((windowMs - t_elapsed) / windowMs) + currentCount < limit
    let earliestAdmissibleTimeMs: number;

    if (state.currentCount >= this.policy.limit) {
      // Current window already exhausted quota on its own; cannot open during this window
      earliestAdmissibleTimeMs = resetTimeMs;
    } else {
      // previousCount > 0 must hold since currentCount < limit and estimatedCount >= limit
      // Solve for t_elapsed:
      // (windowMs - t_elapsed) / windowMs < (limit - currentCount) / previousCount
      // t_elapsed > windowMs * (1 - (limit - currentCount) / previousCount)
      const deficit = this.policy.limit - state.currentCount;
      const thresholdElapsed = this.policy.windowMs * (1 - deficit / state.previousCount);
      // Discrete millisecond time: earliest admissible integer millisecond is floor(thresholdElapsed) + 1
      const admissibleElapsed = Math.floor(thresholdElapsed) + 1;

      if (admissibleElapsed >= this.policy.windowMs) {
        earliestAdmissibleTimeMs = resetTimeMs;
      } else {
        const windowStartMs = windowId * this.policy.windowMs;
        earliestAdmissibleTimeMs = windowStartMs + admissibleElapsed;
      }
    }

    const waitMs = Math.max(0, earliestAdmissibleTimeMs - nowMs);
    const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));

    return {
      allowed: false,
      limit: this.policy.limit,
      remaining: 0,
      resetTimeMs: earliestAdmissibleTimeMs,
      retryAfterSeconds,
    };
  }

  public reset(key?: string): void {
    if (key !== undefined) {
      this.clients.delete(key);
    } else {
      this.clients.clear();
    }
  }

  public getEstimatedCount(key: string): number | null {
    const state = this.clients.get(key);
    if (!state) {
      return null;
    }
    const nowMs = this.clock.now();
    const windowId = Math.floor(nowMs / this.policy.windowMs);

    let prev = state.previousCount;
    let curr = state.currentCount;

    if (windowId === state.currentWindowId + 1) {
      prev = state.currentCount;
      curr = 0;
    } else if (windowId > state.currentWindowId + 1) {
      prev = 0;
      curr = 0;
    }

    const timeInCurrentWindow = nowMs % this.policy.windowMs;
    const previousWeight = (this.policy.windowMs - timeInCurrentWindow) / this.policy.windowMs;
    return prev * previousWeight + curr;
  }
}
