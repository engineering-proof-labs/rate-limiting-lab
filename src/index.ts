export type { RateLimitPolicy, RateLimitResult, Clock } from './core/types.js';
export { SystemClock, VirtualClock } from './core/clock.js';
export { InMemoryFixedWindowRateLimiter } from './core/fixed-window.js';
export {
  RedisFixedWindowRateLimiter,
  type RedisFixedWindowOptions,
} from './storage/redis-fixed-window.js';
export {
  createRateLimitMiddleware,
  defaultKeyGenerator,
  demoHeaderKeyGenerator,
  type RateLimiter,
  type FailurePolicy,
  type RateLimitMiddlewareOptions,
} from './middleware/rate-limit.js';
export { createApp, type CreateAppOptions } from './app/create-app.js';

export const LAB_METADATA = {
  name: 'rate-limiting-lab',
  version: '0.1.0',
  description: 'Production-minded rate limiting laboratory',
} as const;

export function getLabVersion(): string {
  return LAB_METADATA.version;
}
