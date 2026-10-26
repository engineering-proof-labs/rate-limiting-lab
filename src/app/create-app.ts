import express, { type Express, type Request, type Response, Router } from 'express';
import {
  createRateLimitMiddleware,
  type RateLimiter,
  type FailurePolicy,
} from '../middleware/rate-limit.js';

export interface CreateAppOptions {
  readonly limiter?: RateLimiter | undefined;
  readonly failurePolicy?: FailurePolicy | undefined;
}

export function createApp(options?: CreateAppOptions): Express {
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

  // Protected endpoint with rate limiting
  if (options?.limiter) {
    const rateLimitMiddleware = createRateLimitMiddleware({
      limiter: options.limiter,
      failurePolicy: options.failurePolicy,
    });
    apiV1Router.get('/limited', rateLimitMiddleware, (_req: Request, res: Response) => {
      res.status(200).json({ success: true, message: 'Access granted' });
    });
  } else {
    apiV1Router.get('/limited', (_req: Request, res: Response) => {
      res.status(200).json({ success: true, message: 'Access granted' });
    });
  }

  // Mount router at /api/v1
  app.use('/api/v1', apiV1Router);

  return app;
}
