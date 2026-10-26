import type { Clock, RateLimitPolicy, RateLimitResult } from './types.js';
import { SystemClock } from './clock.js';

interface ClientWindowState {
  count: number;
  windowId: number;
}

/**
 * In-memory reference implementation of Fixed Window Counter rate limiting.
 *
 * Memory retention characteristics:
 * State is stored in a JavaScript Map keyed by client identifier. For an active client,
 * stale windows are replaced on subsequent requests. However, inactive client keys are
 * retained in memory until explicit `reset()` is called. In distributed deployments,
 * this is handled by Redis key TTL expiration.
 */
export class InMemoryFixedWindowRateLimiter {
  public readonly policy: Readonly<RateLimitPolicy>;
  private readonly clients = new Map<string, ClientWindowState>();

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
    const nowMs = this.clock.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error('Clock returned an invalid timestamp');
    }

    const windowId = Math.floor(nowMs / this.policy.windowMs);
    const resetTimeMs = (windowId + 1) * this.policy.windowMs;

    const existing = this.clients.get(key);

    if (!existing || existing.windowId !== windowId) {
      this.clients.set(key, { count: 1, windowId });
      return {
        allowed: true,
        limit: this.policy.limit,
        remaining: this.policy.limit - 1,
        resetTimeMs,
      };
    }

    if (existing.count < this.policy.limit) {
      existing.count += 1;
      return {
        allowed: true,
        limit: this.policy.limit,
        remaining: this.policy.limit - existing.count,
        resetTimeMs,
      };
    }

    // Quota exhausted: cap stored counter at limit + 1
    existing.count = this.policy.limit + 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((resetTimeMs - nowMs) / 1000));

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
}
