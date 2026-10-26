import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { RateLimitPolicy, RateLimitResult } from '../core/types.js';

export interface RateLimiter {
  readonly policy: Readonly<RateLimitPolicy>;
  consume(key: string): RateLimitResult | Promise<RateLimitResult>;
}

export type FailurePolicy = 'fail-closed' | 'fail-open';

export interface RateLimitMiddlewareOptions {
  readonly limiter: RateLimiter;
  readonly failurePolicy?: FailurePolicy | undefined;
  readonly keyGenerator?: ((req: Request) => string) | undefined;
}

const CLIENT_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export function defaultKeyGenerator(req: Request): string {
  const rawId = req.headers['x-demo-client-id'] ?? req.headers['x-client-id'];

  if (rawId !== undefined) {
    const candidate = Array.isArray(rawId) ? rawId[0] : rawId;
    if (typeof candidate === 'string' && CLIENT_ID_REGEX.test(candidate)) {
      return `client:${candidate}`;
    }
    throw new Error('MALFORMED_CLIENT_ID');
  }

  // Fallback to client IP
  const ip = req.ip ?? req.socket.remoteAddress ?? '127.0.0.1';
  return `ip:${ip}`;
}

export function createRateLimitMiddleware(options: RateLimitMiddlewareOptions): RequestHandler {
  const { limiter, failurePolicy = 'fail-closed', keyGenerator = defaultKeyGenerator } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      let clientKey: string;
      try {
        clientKey = keyGenerator(req);
      } catch (err) {
        if (err instanceof Error && err.message === 'MALFORMED_CLIENT_ID') {
          res.status(400).json({
            error: 'Bad Request',
            message:
              'Malformed client identifier. Allowed characters: [a-zA-Z0-9_-], max length 64.',
          });
          return;
        }
        throw err;
      }

      let result: RateLimitResult;
      try {
        result = await limiter.consume(clientKey);
      } catch {
        // Storage Outage Handling
        if (failurePolicy === 'fail-open') {
          res.setHeader('X-RateLimit-Fallback', 'fail-open');
          next();
          return;
        }

        // Default: Fail-Closed (503 Service Unavailable, no Retry-After by default)
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'Rate limiting service temporarily unavailable',
        });
        return;
      }

      const resetSeconds = Math.ceil(result.resetTimeMs / 1000);

      res.setHeader('X-RateLimit-Limit', String(result.limit));
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      res.setHeader('X-RateLimit-Reset', String(resetSeconds));

      if (!result.allowed) {
        const retryAfter =
          result.retryAfterSeconds ?? Math.max(1, resetSeconds - Math.floor(Date.now() / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({
          error: 'Too Many Requests',
          message: `Rate limit quota exceeded. Try again in ${retryAfter} seconds.`,
          retryAfter,
        });
        return;
      }

      next();
    })().catch(next);
  };
}
