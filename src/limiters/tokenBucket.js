// Token bucket limiter (in-memory version).
//
// Picture a bucket that holds at most `capacity` tokens.
//   - Tokens drip in at a steady rate: `refillPerSec` tokens per second.
//   - Each request takes 1 token out.
//   - If the bucket is empty, the request is rejected.
//
// Because the bucket can fill up while a client is idle, a client is allowed
// a short BURST of up to `capacity` requests, then settles at the refill rate.
//
// We don't run a timer to add tokens. Instead, each time a request arrives we
// work out how many tokens WOULD have dripped in since we last looked
// ("lazy refill"). That's cheap, and it's exactly what the Redis/Lua version
// will do in stage 3.

export class InMemoryTokenBucket {
  constructor({ capacity, refillPerSec, now = Date.now }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now; // injectable clock, so tests don't have to really wait
    this.buckets = new Map(); // key -> { tokens, lastRefill }
  }

  // async even though it doesn't need to be: the Redis version will be async,
  // so both share the same interface and the middleware doesn't care which it gets.
  async consume(key) {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, lastRefill: now };

    // 1. Lazy refill: add the tokens earned since lastRefill, capped at capacity.
    const elapsedSec = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
    bucket.lastRefill = now;

    // 2. Take a token if there is one.
    let allowed = false;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      allowed = true;
    }
    this.buckets.set(key, bucket);

    // 3. If rejected, when will the next whole token arrive?
    const retryAfterMs = allowed ? 0 : Math.ceil(((1 - bucket.tokens) / this.refillPerSec) * 1000);

    return {
      allowed,
      limit: this.capacity,
      remaining: Math.floor(bucket.tokens),
      retryAfterMs,
    };
  }
}
