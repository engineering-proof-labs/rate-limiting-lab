import type { Clock, RateLimitPolicy, RateLimitResult } from './types.js';
import { SystemClock } from './clock.js';

interface ClientWindowState {
  count: number;
  windowId: number;
}

export class InMemoryFixedWindowRateLimiter {
  private readonly clients = new Map<string, ClientWindowState>();

  constructor(
    public readonly policy: RateLimitPolicy,
    private readonly clock: Clock = new SystemClock(),
  ) {
    this.validatePolicy(policy);
  }

  private validatePolicy(policy: RateLimitPolicy): void {
    if (!Number.isInteger(policy.limit) || policy.limit <= 0) {
      throw new Error('Rate limit must be a positive integer');
    }
    if (!Number.isInteger(policy.windowMs) || policy.windowMs <= 0) {
      throw new Error('Window duration must be a positive integer in milliseconds');
    }
  }

  public consume(key: string, explicitNowMs?: number): RateLimitResult {
    const nowMs = explicitNowMs !== undefined ? explicitNowMs : this.clock.now();
    const windowId = Math.floor(nowMs / this.policy.windowMs);
    const resetTimeMs = (windowId + 1) * this.policy.windowMs;

    const existing = this.clients.get(key);

    if (!existing || existing.windowId !== windowId) {
      // First request in a new window: admitted and counted
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

    // Quota exhausted: cap counter at limit + 1 and reject
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

  public getClientState(key: string): Readonly<ClientWindowState> | undefined {
    return this.clients.get(key);
  }
}
