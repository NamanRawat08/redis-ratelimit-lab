// A tiny example middleware.
//
// Every Express middleware has the same shape: (req, res, next).
//   - req  : the incoming request (URL, headers, IP, ...)
//   - res  : the response we will send back
//   - next : call this to pass the request on to the next middleware/route
//
// Our rate limiter will have exactly this shape too. The only difference:
// instead of always calling next(), it will sometimes reply with
// "429 Too Many Requests" and stop the request right there.

export function requestLogger(req, res, next) {
  const start = Date.now();

  // 'finish' fires after the response has been sent, so we can log the status.
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });

  next();
}
