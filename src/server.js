// Express server with token bucket and sliding window rate limiters.
// Both are tuned to the same average rate (10 requests per 10 seconds), so any
// difference you see is purely down to the algorithm, especially under bursts.
//
// LIMITER_BACKEND=redis (default) shares limits across every server instance.
// LIMITER_BACKEND=memory keeps them inside this one process.

import express from 'express';
import { requestLogger } from './middleware/requestLogger.js';
import { rateLimit } from './middleware/rateLimit.js';
import { InMemoryTokenBucket } from './limiters/tokenBucket.js';
import { InMemorySlidingWindow } from './limiters/slidingWindow.js';
import { RedisTokenBucket } from './limiters/redisTokenBucket.js';
import { RedisSlidingWindow } from './limiters/redisSlidingWindow.js';
import { createRedisClient } from './redis/client.js';

const app = express();
const PORT = process.env.PORT || 3000;
const BACKEND = process.env.LIMITER_BACKEND || 'redis';

// Token bucket: 10 tokens, refilling 1/sec  => burst of 10, then ~1 req/sec.
// Sliding window: at most 10 requests in any 10-second window.
const tokenBucketConfig = { capacity: 10, refillPerSec: 1 };
const slidingWindowConfig = { limit: 10, windowMs: 10_000 };

let tokenBucket;
let slidingWindow;
if (BACKEND === 'memory') {
  tokenBucket = new InMemoryTokenBucket(tokenBucketConfig);
  slidingWindow = new InMemorySlidingWindow(slidingWindowConfig);
} else {
  const redis = createRedisClient();
  tokenBucket = new RedisTokenBucket({ redis, ...tokenBucketConfig });
  slidingWindow = new RedisSlidingWindow({ redis, ...slidingWindowConfig });
}

// Middleware runs in the order it's registered, for every request.
app.use(requestLogger);

// Health check: used by load balancers and our benchmark to see if the server is up.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', backend: BACKEND });
});

// Unprotected endpoint, for comparison.
app.get('/api/data', (req, res) => {
  res.json({ message: 'Here is some data', time: new Date().toISOString() });
});

// Same handler, protected by each limiter. Passing middleware as an extra
// argument applies it to just that route.
app.get('/api/token-bucket', rateLimit({ limiter: tokenBucket }), (req, res) => {
  res.json({ message: 'allowed by token bucket' });
});

app.get('/api/sliding-window', rateLimit({ limiter: slidingWindow }), (req, res) => {
  res.json({ message: 'allowed by sliding window' });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT} (limiter backend: ${BACKEND})`);
});
