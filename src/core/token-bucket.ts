import type { Clock, RateLimitResult, TokenBucketPolicy } from './types.js';
import { SystemClock } from './clock.js';

interface ClientBucketState {
  tokens: number;
  lastRefillTimeMs: number;
}

/**
 * In-memory reference implementation of the Token Bucket rate limiting algorithm.
 *
 * Operational contract:
 * - Capacity (B): Maximum tokens stored in the bucket; defines maximum burst capacity.
 * - Refill Rate (r) / Interval (I): Refills r tokens every I milliseconds.
 * - Initial state: A new client starts with a full bucket (tokens = capacity).
 * - Continuous refill: Evaluated on arrival based on elapsed time since last deduction:
 *   currentTokens = min(capacity, storedTokens + elapsedMs * (refillRate / refillIntervalMs)).
 * - Exact admission boundary: Admitted if currentTokens >= cost (tokens decremented by cost);
 *   throttled if currentTokens < cost (stored state remains untouched).
 * - Fractional credit preservation: When requests are throttled, lastRefillTimeMs is NOT updated,
 *   preserving fractional elapsed time and eliminating cumulative rounding error under polling.
 * - Saturation: During inactivity, tokens cap strictly at capacity (never overflows).
 * - Meaning of remaining capacity: When admitted, floor(tokens / costPerRequest); when throttled, 0.
 * - Retry-After: Seconds until enough tokens accrue to satisfy the requested cost.
 * - Reset time: Timestamp when the bucket will replenish back to full capacity.
 * - Clock regression defense: If system clock steps backward, elapsed time is treated as 0 and
 *   lastRefillTimeMs is not regressed, preventing duplicate token refills.
 * - Memory retention: State is stored in a JavaScript Map keyed by client identifier.
 *   Inactive clients remain in memory until explicit reset().
 */
export class InMemoryTokenBucketRateLimiter {
  public readonly policy: Readonly<Required<TokenBucketPolicy>>;
  private readonly clients = new Map<string, ClientBucketState>();

  constructor(
    policy: TokenBucketPolicy,
    private readonly clock: Clock = new SystemClock(),
  ) {
    this.validatePolicy(policy);
    this.policy = Object.freeze({
      capacity: policy.capacity,
      refillRate: policy.refillRate,
      refillIntervalMs: policy.refillIntervalMs,
      costPerRequest: policy.costPerRequest ?? 1,
    });
  }

  private validatePolicy(policy: TokenBucketPolicy): void {
    if (!Number.isSafeInteger(policy.capacity) || policy.capacity <= 0) {
      throw new Error('Capacity must be a positive safe integer');
    }
    if (
      typeof policy.refillRate !== 'number' ||
      !Number.isFinite(policy.refillRate) ||
      policy.refillRate <= 0
    ) {
      throw new Error('Refill rate must be a positive number');
    }
    if (!Number.isSafeInteger(policy.refillIntervalMs) || policy.refillIntervalMs <= 0) {
      throw new Error('Refill interval must be a positive safe integer in milliseconds');
    }

    // Numerical limits validation: verify derived refill rates do not underflow to zero or overflow
    const ratePerMs = policy.refillRate / policy.refillIntervalMs;
    const msPerToken = policy.refillIntervalMs / policy.refillRate;

    if (ratePerMs <= 0 || !Number.isFinite(ratePerMs)) {
      throw new Error(
        'Refill rate and interval result in numerical underflow (tokens per millisecond must be positive and finite)',
      );
    }
    if (!Number.isFinite(msPerToken) || msPerToken > Number.MAX_SAFE_INTEGER) {
      throw new Error(
        'Refill rate is too small: time per token exceeds Number.MAX_SAFE_INTEGER milliseconds',
      );
    }

    if (
      policy.costPerRequest !== undefined &&
      (!Number.isSafeInteger(policy.costPerRequest) || policy.costPerRequest <= 0)
    ) {
      throw new Error('Cost per request must be a positive safe integer');
    }
    if (policy.costPerRequest !== undefined && policy.costPerRequest > policy.capacity) {
      throw new Error('Cost per request cannot exceed bucket capacity');
    }
  }

  public consume(key: string, customCost?: number): RateLimitResult {
    if (!key || typeof key !== 'string' || key.trim().length === 0) {
      throw new Error('Rate limit key must be a non-empty string');
    }

    const cost = customCost ?? this.policy.costPerRequest;
    if (!Number.isSafeInteger(cost) || cost <= 0) {
      throw new Error('Cost must be a positive safe integer');
    }
    if (cost > this.policy.capacity) {
      throw new Error(
        `Requested token cost (${cost}) exceeds bucket capacity (${this.policy.capacity})`,
      );
    }

    const nowMs = this.clock.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error('Clock returned an invalid timestamp');
    }

    let state = this.clients.get(key);

    if (!state) {
      // First request: client starts with a full bucket
      state = {
        tokens: this.policy.capacity,
        lastRefillTimeMs: nowMs,
      };
      this.clients.set(key, state);
    }

    // Refill tokens based on elapsed time since last deduction.
    // Operation ordering: multiply before dividing to preserve exact integer ratios at refill boundaries
    // (e.g. (49 * 1) / 49 = 1.0, whereas 49 * (1 / 49) = 0.9999999999999999 in IEEE 754 float).
    // Bound elapsedMs by timeToFull to prevent numerical overflow on large elapsed times.
    const elapsedMs = Math.max(0, nowMs - state.lastRefillTimeMs);
    const initialDeficit = this.policy.capacity - state.tokens;
    const msToFill = Math.ceil(
      initialDeficit * (this.policy.refillIntervalMs / this.policy.refillRate),
    );
    const tokensToAdd =
      elapsedMs >= msToFill
        ? initialDeficit
        : (elapsedMs * this.policy.refillRate) / this.policy.refillIntervalMs;
    const availableTokens = Math.min(this.policy.capacity, state.tokens + tokensToAdd);

    // Determine admission: exact boundary check (no tolerance offsets)
    if (availableTokens >= cost) {
      state.tokens = availableTokens - cost;
      // Advance lastRefillTimeMs forward (defend against backward clock jumps regressing refill timestamp)
      if (nowMs > state.lastRefillTimeMs) {
        state.lastRefillTimeMs = nowMs;
      }

      const tokensDeficit = this.policy.capacity - state.tokens;
      const msToFull = Math.ceil(
        tokensDeficit * (this.policy.refillIntervalMs / this.policy.refillRate),
      );
      const resetTimeMs = Math.min(Number.MAX_SAFE_INTEGER, nowMs + msToFull);

      return {
        allowed: true,
        limit: this.policy.capacity,
        remaining: Math.floor(state.tokens / this.policy.costPerRequest),
        resetTimeMs,
      };
    }

    // Throttled: insufficient tokens.
    // Crucial: state.tokens and state.lastRefillTimeMs remain unchanged so that fractional
    // elapsed time continues to accumulate toward the next admission without truncation loss.
    const tokensNeeded = cost - availableTokens;
    const waitMs = Math.ceil(
      tokensNeeded * (this.policy.refillIntervalMs / this.policy.refillRate),
    );
    const retryAfterSeconds = Math.min(
      Math.floor(Number.MAX_SAFE_INTEGER / 1000),
      Math.max(1, Math.ceil(waitMs / 1000)),
    );

    const tokensDeficit = this.policy.capacity - availableTokens;
    const msToFull = Math.ceil(
      tokensDeficit * (this.policy.refillIntervalMs / this.policy.refillRate),
    );
    const resetTimeMs = Math.min(Number.MAX_SAFE_INTEGER, nowMs + msToFull);

    return {
      allowed: false,
      limit: this.policy.capacity,
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

  public getTokens(key: string): number | null {
    const state = this.clients.get(key);
    if (!state) {
      return null;
    }
    const nowMs = this.clock.now();
    const elapsedMs = Math.max(0, nowMs - state.lastRefillTimeMs);
    const initialDeficit = this.policy.capacity - state.tokens;
    const msToFill = Math.ceil(
      initialDeficit * (this.policy.refillIntervalMs / this.policy.refillRate),
    );
    const tokensToAdd =
      elapsedMs >= msToFill
        ? initialDeficit
        : (elapsedMs * this.policy.refillRate) / this.policy.refillIntervalMs;
    return Math.min(this.policy.capacity, state.tokens + tokensToAdd);
  }
}
