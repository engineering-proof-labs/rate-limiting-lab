import type { Clock, RateLimitResult, TokenBucketPolicy } from './types.js';
import { SystemClock } from './clock.js';

interface ClientBucketState {
  tokens: number;
  lastRefillTimeMs: number;
}

/**
 * Numerical precision epsilon for floating-point token calculations.
 * Used to guard against IEEE 754 summation errors (e.g. 10 * 0.1 = 0.9999999999999999).
 */
const EPSILON = 1e-9;

/**
 * In-memory reference implementation of the Token Bucket rate limiting algorithm.
 *
 * Operational contract:
 * - Capacity (B): Maximum tokens stored in the bucket; defines maximum burst size.
 * - Refill Rate (r) / Interval (I): Refills r tokens every I milliseconds.
 * - Initial state: A new client starts with a full bucket (tokens = capacity).
 * - Continuous fractional refill: Accrues tokens proportional to elapsed time:
 *   deltaTokens = elapsedMs * (refillRate / refillIntervalMs).
 *   Internal state tracks fractional tokens (IEEE 754 float) to prevent starvation under rapid checks.
 * - Precision snapping: Snaps to exact integer within EPSILON to prevent floating point drift.
 * - Saturation: During inactivity, tokens cap strictly at capacity (never overflows).
 * - Exact admission boundary: Admitted if tokens + EPSILON >= cost (tokens decremented by cost);
 *   throttled if tokens < cost (tokens unchanged).
 * - Meaning of remaining capacity: When admitted, floor(tokens / costPerRequest); when throttled, 0.
 * - Retry-After: Seconds until enough tokens accrue to satisfy the requested cost.
 * - Reset time: Timestamp when the bucket will replenish back to full capacity.
 * - Clock regression defense: Elapsed time is clamped to >= 0, so backward clock adjustments
 *   do not deduct tokens.
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
    } else {
      // Refill tokens based on elapsed time since last refill
      const elapsedMs = Math.max(0, nowMs - state.lastRefillTimeMs);
      if (elapsedMs > 0) {
        const tokensToAdd = elapsedMs * (this.policy.refillRate / this.policy.refillIntervalMs);
        state.tokens = Math.min(this.policy.capacity, state.tokens + tokensToAdd);

        // Snap to nearest integer if within floating-point epsilon
        if (Math.abs(state.tokens - Math.round(state.tokens)) < EPSILON) {
          state.tokens = Math.round(state.tokens);
        }

        state.lastRefillTimeMs = nowMs;
      }
    }

    // Determine admission
    if (state.tokens + EPSILON >= cost) {
      state.tokens = Math.max(0, state.tokens - cost);

      // Snap to nearest integer if within floating-point epsilon
      if (Math.abs(state.tokens - Math.round(state.tokens)) < EPSILON) {
        state.tokens = Math.round(state.tokens);
      }

      const tokensDeficit = this.policy.capacity - state.tokens;
      const msToFull = Math.ceil(
        tokensDeficit * (this.policy.refillIntervalMs / this.policy.refillRate),
      );
      const resetTimeMs = nowMs + msToFull;

      return {
        allowed: true,
        limit: this.policy.capacity,
        remaining: Math.floor(state.tokens / this.policy.costPerRequest),
        resetTimeMs,
      };
    }

    // Throttled: insufficient tokens
    const tokensNeeded = Math.max(0, cost - state.tokens);
    const waitMs = Math.ceil(
      tokensNeeded * (this.policy.refillIntervalMs / this.policy.refillRate),
    );
    const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));

    const tokensDeficit = this.policy.capacity - state.tokens;
    const msToFull = Math.ceil(
      tokensDeficit * (this.policy.refillIntervalMs / this.policy.refillRate),
    );
    const resetTimeMs = nowMs + msToFull;

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
    return state ? state.tokens : null;
  }
}
