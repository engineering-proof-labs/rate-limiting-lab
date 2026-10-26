export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
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
