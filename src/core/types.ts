export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

export interface TokenBucketPolicy {
  readonly capacity: number;
  readonly refillRate: number;
  readonly refillIntervalMs: number;
  readonly costPerRequest?: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetTimeMs: number;
  readonly retryAfterSeconds?: number;
}

export interface Clock {
  now(): number;
}
