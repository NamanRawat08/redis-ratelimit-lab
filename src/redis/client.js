// Creates a Redis connection and registers our Lua scripts on it.
//
// ioredis's defineCommand() turns each script into a method on the client.
// Under the hood it sends the script once, Redis caches it by its SHA1 hash,
// and later calls send just the hash (EVALSHA). That saves resending the
// whole script on every request.

import { readFileSync } from 'node:fs';
import Redis from 'ioredis';

const lua = (name) => readFileSync(new URL(`../lua/${name}.lua`, import.meta.url), 'utf8');

export function createRedisClient(url = process.env.REDIS_URL || 'redis://localhost:6379') {
  const redis = new Redis(url, {
    // Don't let a request hang while Redis is down or slow: fail fast, so the
    // middleware can fall back (see failOpen in rateLimit.js).
    maxRetriesPerRequest: 1,
    commandTimeout: 500,
  });

  redis.defineCommand('tokenBucket', { numberOfKeys: 1, lua: lua('tokenBucket') });
  redis.defineCommand('slidingWindow', { numberOfKeys: 1, lua: lua('slidingWindow') });

  redis.on('error', (err) => console.error('[redis]', err.message));
  return redis;
}
