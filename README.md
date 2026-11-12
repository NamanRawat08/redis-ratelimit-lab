# redis-ratelimit-lab

A distributed rate limiter for Express, backed by Redis and Lua scripts. It implements **token bucket** and **sliding window** limiters and compares how they behave under bursts of traffic.

> 🚧 Work in progress. See [Roadmap](#roadmap).

## Quick start

Requires Node.js 18+.

```bash
npm install
npm start          # server on http://localhost:3000
npm test           # unit tests
npm run burst      # burst comparison (run while the server is up)
```

## Endpoints

| Route | Limiter |
|---|---|
| `GET /health` | none |
| `GET /api/data` | none |
| `GET /api/token-bucket` | token bucket: capacity 10, refills 1 token/sec |
| `GET /api/sliding-window` | sliding window: 10 requests per 10 sec |

Limited responses include `RateLimit-Limit` and `RateLimit-Remaining` headers. Rejected requests get `429 Too Many Requests` with a `Retry-After` header.

## Burst comparison

Both limiters average 10 requests per 10 seconds. Output of `npm run burst`:

| Time | Burst size | Token bucket | Sliding window |
|---|---|---|---|
| t=0s | 15 | 10 allowed | 10 allowed |
| t=3s | 5 | 3 allowed | 0 allowed |
| t=11s | 15 | 8 allowed | 10 allowed |

- **Token bucket** recovers gradually: capacity refills at a steady rate, so a client gets a little back every second.
- **Sliding window** recovers in steps: nothing is freed until old requests leave the window, then a lot frees at once.

## Project structure

```
src/
  server.js                 Express app and routes
  limiters/
    tokenBucket.js          token bucket (in-memory)
    slidingWindow.js        sliding window log (in-memory)
  middleware/
    rateLimit.js            wraps any limiter as Express middleware
    requestLogger.js        logs each request
test/
  limiters.test.js          unit tests (fake clock, no waiting)
scripts/
  burst.js                  burst comparison demo
```

## Roadmap

- [x] Stage 1: Express server and middleware
- [x] Stage 2: In-memory token bucket and sliding window
- [ ] Stage 3: Redis-backed limiters with atomic Lua scripts
- [ ] Stage 4: Multi-instance test (several servers sharing one Redis)
- [ ] Stage 5: Benchmark (throughput and latency) and burst graphs
- [ ] Stage 6: Write-up on the trade-offs
