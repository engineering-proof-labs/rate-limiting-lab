import { Redis } from 'ioredis';
import { createApp } from './app/create-app.js';
import { RedisFixedWindowRateLimiter } from './storage/redis-fixed-window.js';

const PORT = Number(process.env.PORT ?? 3000);
const REDIS_URL = process.env.REDIS_URL;
const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
const ENABLE_DEMO_HEADERS =
  process.env.ENABLE_DEMO_HEADERS === 'true' || process.argv.includes('--demo');

const connectionTarget = REDIS_URL ?? `${REDIS_HOST}:${REDIS_PORT}`;

const redisOptions = {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
  enableOfflineQueue: false,
};

const redis = REDIS_URL
  ? new Redis(REDIS_URL, redisOptions)
  : new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      ...redisOptions,
    });

// Deliberately handle background client errors to prevent unhandled EventEmitter error events
redis.on('error', (err: Error) => {
  if (process.env.DEBUG_REDIS === 'true') {
    console.debug(`[rate-limiting-lab] Redis background error: ${err.message}`);
  }
});

async function bootstrap(): Promise<void> {
  try {
    await redis.connect();
    console.log(`[rate-limiting-lab] Connected to Redis at ${connectionTarget}`);
  } catch (err) {
    console.warn(
      `[rate-limiting-lab] Warning: Could not connect to Redis at ${connectionTarget}. Starting in fail-closed mode. (${(err as Error).message})`,
    );
  }

  const limiter = new RedisFixedWindowRateLimiter({
    redis,
    policy: {
      limit: 5,
      windowMs: 60_000,
    },
    keyPrefix: 'rate-limit:demo:',
  });

  const app = createApp({
    limiter,
    enableDemoHeaders: ENABLE_DEMO_HEADERS,
  });

  const server = app.listen(PORT, () => {
    console.log(`[rate-limiting-lab] Server listening on http://localhost:${PORT}`);
    console.log(
      `[rate-limiting-lab] Demo headers (X-Demo-Client-Id): ${
        ENABLE_DEMO_HEADERS ? 'ENABLED' : 'DISABLED (default: IP-anchored)'
      }`,
    );
    console.log(`[rate-limiting-lab] Rate limit policy: 5 requests / 60,000 ms per client`);
  });

  const shutdown = (): void => {
    console.log('\n[rate-limiting-lab] Shutting down server...');
    const forceExitTimeout = setTimeout(() => {
      console.warn('[rate-limiting-lab] Forced exit after shutdown timeout');
      process.exit(1);
    }, 5000);

    server.close(() => {
      clearTimeout(forceExitTimeout);
      void (async () => {
        try {
          if (redis.status === 'ready' || redis.status === 'connecting') {
            await redis.quit();
          }
        } catch {
          redis.disconnect();
        } finally {
          process.exit(0);
        }
      })();
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void bootstrap();
