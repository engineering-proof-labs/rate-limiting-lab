import type { Clock, RateLimitPolicy, RateLimitResult } from './types.js';
import { SystemClock } from './clock.js';

/**
 * In-memory reference implementation of the Sliding Window Log rate limiting algorithm.
 *
 * Operational contract:
 * - Exact rolling window: Tracks individual timestamps of admitted requests within the active interval.
 * - Interval boundary: A request at timestamp t expires precisely at t + windowMs. Timestamps older than
 *   (nowMs - windowMs) are pruned on arrival.
 * - Exact admission invariant: If pruned timestamp count < limit, request is admitted and current timestamp
 *   is appended to the log. If pruned count >= limit, request is rejected.
 * - Memory hygiene & worst-case bound: Rejected requests are NOT appended to the log. Therefore, the log
 *   for any client is strictly bounded by limit entries (at most L timestamps).
 * - Client retention: Active clients retain at most limit timestamps. Inactive client keys remain in
 *   the Map until explicit reset() is called.
 */
export class InMemorySlidingWindowLogRateLimiter {
  public readonly policy: Readonly<RateLimitPolicy>;
  private readonly clients = new Map<string, number[]>();

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

    const windowStart = nowMs - this.policy.windowMs;
    const existing = this.clients.get(key) ?? [];

    // Prune timestamps that have fallen outside the rolling window (ts <= windowStart)
    const activeTimestamps = existing.filter((ts) => ts > windowStart);

    if (activeTimestamps.length < this.policy.limit) {
      activeTimestamps.push(nowMs);
      this.clients.set(key, activeTimestamps);

      const remaining = this.policy.limit - activeTimestamps.length;
      const resetTimeMs = (activeTimestamps[0] ?? nowMs) + this.policy.windowMs;

      return {
        allowed: true,
        limit: this.policy.limit,
        remaining,
        resetTimeMs,
      };
    }

    // Quota exhausted: do NOT record rejected timestamp (preserves bounded memory)
    this.clients.set(key, activeTimestamps);
    const resetTimeMs = (activeTimestamps[0] ?? nowMs) + this.policy.windowMs;
    const waitMs = Math.max(0, resetTimeMs - nowMs);
    const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));

    return {
      allowed: false,
      limit: this.policy.limit,
      remaining: 0,
      resetTimeMs,
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

  public getTimestamps(key: string): readonly number[] | null {
    const existing = this.clients.get(key);
    if (!existing) {
      return null;
    }
    const nowMs = this.clock.now();
    const windowStart = nowMs - this.policy.windowMs;
    return existing.filter((ts) => ts > windowStart);
  }
}
