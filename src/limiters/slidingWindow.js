// Sliding window limiter (in-memory version, "sliding log" variant).
//
// Rule: at most `limit` requests in ANY window of `windowMs` milliseconds,
// measured backwards from right now.
//
// We keep a log of timestamps of the requests we allowed. On each new request:
//   1. Throw away timestamps older than (now - windowMs). They've "slid out".
//   2. If fewer than `limit` remain, allow and record this request's timestamp.
//   3. Otherwise reject.
//
// Why not a simple "fixed window" (reset the counter every minute on the minute)?
// Because a client could send `limit` requests at 0:59 and another `limit` at
// 1:00, which is 2x the limit in two seconds. The sliding window has no such edge.
//
// Trade-off: we store one timestamp per request, so memory grows with `limit`.
// In stage 3 this log becomes a Redis sorted set.

export class InMemorySlidingWindow {
  constructor({ limit, windowMs, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.logs = new Map(); // key -> array of timestamps, oldest first
  }

  async consume(key) {
    const now = this.now();
    const windowStart = now - this.windowMs;
    const log = this.logs.get(key) ?? [];

    // 1. Drop requests that are outside the window (oldest are at the front).
    while (log.length > 0 && log[0] <= windowStart) {
      log.shift();
    }

    // 2. Allow if there's room, and record it.
    let allowed = false;
    if (log.length < this.limit) {
      log.push(now);
      allowed = true;
    }
    this.logs.set(key, log);

    // 3. If rejected, the oldest request leaving the window frees up a slot.
    const retryAfterMs = allowed ? 0 : log[0] + this.windowMs - now;

    return {
      allowed,
      limit: this.limit,
      remaining: this.limit - log.length,
      retryAfterMs,
    };
  }
}
