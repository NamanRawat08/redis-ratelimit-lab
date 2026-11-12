// Turns any limiter into Express middleware.
//
// A "limiter" is anything with: async consume(key) -> { allowed, limit, remaining, retryAfterMs }
// Both in-memory limiters have that shape, and so will the Redis ones. This
// middleware works with all of them without changes (the "strategy pattern").
//
// `keyFn` decides WHO is being limited. By default it's the client's IP, but
// it could be a user ID or API key instead.

export function rateLimit({ limiter, keyFn = (req) => req.ip }) {
  return async function rateLimitMiddleware(req, res, next) {
    try {
      const key = keyFn(req);
      const result = await limiter.consume(key);

      // Standard-ish headers so clients can see their quota.
      res.set('RateLimit-Limit', String(result.limit));
      res.set('RateLimit-Remaining', String(Math.max(0, result.remaining)));

      if (result.allowed) {
        return next(); // under the limit: let the request through
      }

      // Over the limit: stop here, don't call next().
      // Retry-After is in whole seconds, per the HTTP spec.
      res.set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      return res.status(429).json({
        error: 'Too Many Requests',
        retryAfterMs: result.retryAfterMs,
      });
    } catch (err) {
      // Express 4 doesn't catch errors from async functions, so we pass them on.
      // (In stage 3 we'll decide what to do if Redis is down: "fail open" or "fail closed".)
      next(err);
    }
  };
}
