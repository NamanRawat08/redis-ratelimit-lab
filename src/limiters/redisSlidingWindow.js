// Sliding window backed by Redis. Same interface as InMemorySlidingWindow.
// All the logic lives in src/lua/slidingWindow.lua.

import { randomUUID } from 'node:crypto';

export class RedisSlidingWindow {
  constructor({ redis, limit, windowMs, prefix = 'rl' }) {
    this.redis = redis;
    this.limit = limit;
    this.windowMs = windowMs;
    this.prefix = prefix;
  }

  async consume(key) {
    const [allowed, remaining, retryAfterMs] = await this.redis.slidingWindow(
      `${this.prefix}:sw:${key}`,
      this.limit,
      this.windowMs,
      randomUUID(), // unique member for the sorted set
    );

    return { allowed: allowed === 1, limit: this.limit, remaining, retryAfterMs };
  }
}
