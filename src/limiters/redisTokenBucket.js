// Token bucket backed by Redis. Same interface as InMemoryTokenBucket, so the
// middleware can use either. All the logic lives in src/lua/tokenBucket.lua;
// this class just calls the script and shapes the result.

export class RedisTokenBucket {
  constructor({ redis, capacity, refillPerSec, prefix = 'rl' }) {
    this.redis = redis; // a client from createRedisClient()
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.prefix = prefix;
  }

  async consume(key) {
    const [allowed, remaining, retryAfterMs] = await this.redis.tokenBucket(
      `${this.prefix}:tb:${key}`,
      this.capacity,
      this.refillPerSec,
    );

    return { allowed: allowed === 1, limit: this.capacity, remaining, retryAfterMs };
  }
}
