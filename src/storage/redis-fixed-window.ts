import type { Redis } from 'ioredis';
import type { RateLimitPolicy, RateLimitResult } from '../core/types.js';

export interface RedisFixedWindowOptions {
  readonly redis: Redis;
  readonly policy: RateLimitPolicy;
  readonly keyPrefix?: string;
}

/**
 * Lua script for atomic Fixed Window Counter evaluation in Redis.
 *
 * Operational, Correctness & Concurrency Model:
 *
 * 1. Distributed Time Authority & Non-Monotonicity:
 *    Uses Redis server time via `redis.call('TIME')` [seconds, microseconds] to ensure
 *    independent application instances share an identical clock authority, preventing
 *    cross-instance clock drift from fragmenting epoch windows.
 *    IMPORTANT: Redis TIME returns the host operating system wall-clock (via gettimeofday)
 *    and is NOT strictly monotonic. NTP slews, step corrections, or leap seconds on the
 *    Redis host can alter time. It is a shared wall-clock authority, not a monotonic timer.
 *
 * 2. Supported Numeric Range:
 *    - Limits: 1 <= limit < Number.MAX_SAFE_INTEGER (2^53 - 1, or 9,007,199,254,740,991).
 *    - Window: 1 <= windowMs <= Number.MAX_SAFE_INTEGER.
 *    Redis 7 embedded Lua 5.1 represents numbers as IEEE 754 double-precision floats with
 *    53 bits of integer precision. Bounding limits strictly below 2^53 guarantees exact
 *    integer arithmetic in both Node.js and Redis Lua.
 *
 * 3. Atomicity on Single Primary:
 *    The entire read, increment, expiration assignment, and saturation logic executes
 *    atomically in a single Redis event loop tick, eliminating time-of-check to
 *    time-of-use (TOCTOU) race conditions under concurrent client requests.
 *
 * 4. Atomicity vs Failover Durability:
 *    Single-primary atomicity guarantees that concurrent commands do not interleave on a
 *    healthy primary. It DOES NOT guarantee durability across failover. Redis uses
 *    asynchronous replication; if the primary crashes before acknowledged writes are
 *    replicated, newly written window counts may be lost. For transient rate limiting,
 *    this ephemeral loss is an accepted tradeoff (recovering in <= W), but must not be
 *    confused with ACID transactional durability.
 *
 * 5. Window Alignment & Expiration:
 *    Windows are epoch-aligned: windowId = floor(nowMs / windowMs), resetTimeMs = (windowId + 1) * windowMs.
 *    Key TTL is set via PEXPIRE to (resetTimeMs - nowMs) strictly on the initial request
 *    of the window (count === 1). Subsequent requests do NOT refresh or prolong the TTL.
 *    This aligns key expiration directly with epoch window boundaries.
 *
 * 6. Counter Saturation:
 *    On quota exhaustion (count > limit), the counter saturates at limit + 1 using SET ... KEEPTTL.
 *    This records the breach for observability and auditing without permitting unbounded
 *    counter growth or integer overflow under high-concurrency request floods.
 */
const FIXED_WINDOW_LUA_SCRIPT = `
local time = redis.call('TIME')
local nowMs = math.floor(tonumber(time[1]) * 1000 + tonumber(time[2]) / 1000)
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])

local windowId = math.floor(nowMs / windowMs)
local resetTimeMs = (windowId + 1) * windowMs
local ttlMs = math.max(1, resetTimeMs - nowMs)

local key = KEYS[1] .. ":" .. windowId

local count = redis.call('INCR', key)
if count == 1 then
  redis.call('PEXPIRE', key, ttlMs)
end

local allowed = 0
local remaining = 0

if count <= limit then
  allowed = 1
  remaining = limit - count
else
  allowed = 0
  remaining = 0
  if count > limit + 1 then
    redis.call('SET', key, limit + 1, 'KEEPTTL')
  end
end

local retryAfterSeconds = 0
if allowed == 0 then
  retryAfterSeconds = math.max(1, math.ceil(ttlMs / 1000))
end

return { allowed, limit, remaining, resetTimeMs, retryAfterSeconds, nowMs }
`;

export class RedisFixedWindowRateLimiter {
  public readonly policy: Readonly<RateLimitPolicy>;
  public readonly keyPrefix: string;
  private readonly redis: Redis;

  constructor(options: RedisFixedWindowOptions) {
    this.validatePolicy(options.policy);
    this.policy = Object.freeze({ ...options.policy });
    this.redis = options.redis;
    this.keyPrefix = options.keyPrefix ?? 'ratelimit:fixed';
  }

  private validatePolicy(policy: RateLimitPolicy): void {
    if (
      !Number.isSafeInteger(policy.limit) ||
      policy.limit <= 0 ||
      policy.limit >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error(
        `Rate limit must be a positive safe integer less than Number.MAX_SAFE_INTEGER (1 <= limit < ${Number.MAX_SAFE_INTEGER})`,
      );
    }
    if (
      !Number.isSafeInteger(policy.windowMs) ||
      policy.windowMs <= 0 ||
      policy.windowMs > Number.MAX_SAFE_INTEGER
    ) {
      throw new Error(
        `Window duration must be a positive safe integer in milliseconds (1 <= windowMs <= ${Number.MAX_SAFE_INTEGER})`,
      );
    }
  }

  public async consume(key: string): Promise<RateLimitResult> {
    if (!key || typeof key !== 'string' || key.trim().length === 0) {
      throw new Error('Rate limit key must be a non-empty string');
    }

    const redisKey = `${this.keyPrefix}:${key}`;

    const raw = (await this.redis.eval(
      FIXED_WINDOW_LUA_SCRIPT,
      1,
      redisKey,
      this.policy.limit,
      this.policy.windowMs,
    )) as [number, number, number, number, number, number];

    const [allowedNum, limit, remaining, resetTimeMs, retryAfterSeconds] = raw;
    const allowed = allowedNum === 1;

    return {
      allowed,
      limit,
      remaining,
      resetTimeMs,
      ...(allowed ? {} : { retryAfterSeconds }),
    };
  }

  public async reset(key?: string): Promise<void> {
    const pattern = key !== undefined ? `${this.keyPrefix}:${key}:*` : `${this.keyPrefix}:*`;

    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } while (cursor !== '0');
  }

  public async getCurrentWindowId(): Promise<number> {
    const timeRes = await this.redis.time();
    const nowMs = Math.floor(Number(timeRes[0]) * 1000 + Number(timeRes[1]) / 1000);
    return Math.floor(nowMs / this.policy.windowMs);
  }

  public async getRawCounter(key: string, windowId?: number): Promise<number | null> {
    const targetWindowId = windowId ?? (await this.getCurrentWindowId());
    const redisKey = `${this.keyPrefix}:${key}:${targetWindowId}`;
    const value = await this.redis.get(redisKey);
    return value !== null ? Number.parseInt(value, 10) : null;
  }

  public async getTTL(key: string, windowId?: number): Promise<number> {
    const targetWindowId = windowId ?? (await this.getCurrentWindowId());
    const redisKey = `${this.keyPrefix}:${key}:${targetWindowId}`;
    return this.redis.pttl(redisKey);
  }
}
