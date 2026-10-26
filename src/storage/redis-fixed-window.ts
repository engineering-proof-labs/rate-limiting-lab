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
 * Operational contract:
 * - Declared key contract: Operates exclusively on KEYS[1] (one key per client).
 * - Internal state: Stored as a Redis Hash with fields 'w' (windowId) and 'c' (counter).
 * - Time authority: Reads Redis server time via `TIME` ([seconds, microseconds]).
 *   Redis TIME reflects host OS wall-clock and is not strictly monotonic (subject to NTP slews).
 * - Expiration: Sets absolute expiration via PEXPIREAT at resetTimeMs on initial creation
 *   or window transition. Subsequent requests do not alter the expiration boundary.
 * - Saturation: When quota is exhausted, counter caps at limit + 1.
 * - Single-primary atomicity: Atomically evaluated on the Redis primary thread;
 *   does not imply failover durability across asynchronous replication.
 */
const FIXED_WINDOW_LUA_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])

local time = redis.call('TIME')
local nowMs = math.floor(tonumber(time[1]) * 1000 + tonumber(time[2]) / 1000)

local windowId = math.floor(nowMs / windowMs)
local resetTimeMs = (windowId + 1) * windowMs

local state = redis.call('HMGET', key, 'w', 'c')
local storedWindowId = tonumber(state[1])
local count = tonumber(state[2])

local allowed = 0
local remaining = 0

if storedWindowId == nil or storedWindowId ~= windowId then
  count = 1
  redis.call('HSET', key, 'w', windowId, 'c', 1)
  redis.call('PEXPIREAT', key, resetTimeMs)
  allowed = 1
  remaining = limit - 1
else
  if count < limit then
    count = count + 1
    redis.call('HSET', key, 'c', count)
    allowed = 1
    remaining = limit - count
  else
    allowed = 0
    remaining = 0
    if count == limit then
      count = limit + 1
      redis.call('HSET', key, 'c', count)
    end
  end
end

local retryAfterSeconds = 0
if allowed == 0 then
  local ttlMs = math.max(1, resetTimeMs - nowMs)
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

  public getClientRedisKey(key: string): string {
    return `${this.keyPrefix}:${key}`;
  }

  public async consume(key: string): Promise<RateLimitResult> {
    if (!key || typeof key !== 'string' || key.trim().length === 0) {
      throw new Error('Rate limit key must be a non-empty string');
    }

    const redisKey = this.getClientRedisKey(key);

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

  /**
   * Resets rate-limit state.
   *
   * If a specific client key is provided, performs an exact O(1) DEL on that client's key,
   * completely avoiding glob pattern matching and accidental pattern expansion.
   *
   * If no key is provided, performs an administrative blanket reset of all keys under keyPrefix
   * using iterative SCAN batches. Note: SCAN-based blanket reset is non-atomic under concurrent writes.
   */
  public async reset(key?: string): Promise<void> {
    if (key !== undefined) {
      if (!key || typeof key !== 'string' || key.trim().length === 0) {
        throw new Error('Rate limit key must be a non-empty string');
      }
      await this.redis.del(this.getClientRedisKey(key));
      return;
    }

    const pattern = `${this.keyPrefix}:*`;
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

  public async getRawCounter(key: string): Promise<number | null> {
    const redisKey = this.getClientRedisKey(key);
    const countStr = await this.redis.hget(redisKey, 'c');
    return countStr !== null ? Number.parseInt(countStr, 10) : null;
  }

  public async getRawState(key: string): Promise<{ windowId: number; count: number } | null> {
    const redisKey = this.getClientRedisKey(key);
    const [windowIdStr, countStr] = await this.redis.hmget(redisKey, 'w', 'c');
    if (windowIdStr === null || countStr === null) {
      return null;
    }
    return {
      windowId: Number.parseInt(windowIdStr, 10),
      count: Number.parseInt(countStr, 10),
    };
  }

  public async getTTL(key: string): Promise<number> {
    const redisKey = this.getClientRedisKey(key);
    return this.redis.pttl(redisKey);
  }
}
