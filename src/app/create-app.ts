import express, { type Express, type Request, type Response, Router } from 'express';
import {
  createRateLimitMiddleware,
  type RateLimiter,
  type FailurePolicy,
} from '../middleware/rate-limit.js';

export interface CreateAppOptions {
  readonly limiter: RateLimiter;
  readonly failurePolicy?: FailurePolicy | undefined;
  readonly enableDemoHeaders?: boolean | undefined;
  readonly keyGenerator?: ((req: Request) => string) | undefined;
}

export function createApp(options: CreateAppOptions): Express {
  if (!options || !options.limiter) {
    throw new Error('createApp requires a configured RateLimiter instance');
  }

  const app = express();

  app.use(express.json());

  // Public unthrottled health check
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // API v1 Router mounted strictly under /api/v1
  const apiV1Router = Router();

  // Unthrottled control endpoint
  apiV1Router.get('/unlimited', (_req: Request, res: Response) => {
    res.status(200).json({ success: true, message: 'Unlimited endpoint' });
  });

  // Protected endpoint with rate limiting — always guarded by rateLimitMiddleware
  const rateLimitMiddleware = createRateLimitMiddleware({
    limiter: options.limiter,
    ...(options.failurePolicy !== undefined ? { failurePolicy: options.failurePolicy } : {}),
    ...(options.enableDemoHeaders !== undefined
      ? { enableDemoHeaders: options.enableDemoHeaders }
      : {}),
    ...(options.keyGenerator !== undefined ? { keyGenerator: options.keyGenerator } : {}),
  });

  apiV1Router.get('/limited', rateLimitMiddleware, (_req: Request, res: Response) => {
    res.status(200).json({ success: true, message: 'Access granted' });
  });

  // Mount router at /api/v1
  app.use('/api/v1', apiV1Router);

  return app;
}
