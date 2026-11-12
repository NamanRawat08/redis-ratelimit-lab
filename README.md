# redis-ratelimit-lab

A distributed rate limiter for Express, backed by Redis and Lua scripts. It implements **token bucket** and **sliding window** limiters and compares how they behave under bursts of traffic.

> 🚧 Work in progress. See [Roadmap](#roadmap).

## Quick start

Requires Node.js 18+ and Redis (`brew install redis && brew services start redis` on macOS).

```bash
npm install
npm start          # server on http://localhost:3000
npm test           # unit + Redis integration tests
npm run burst      # burst comparison (run while the server is up)
npm run race       # race condition demo: naive GET/SET vs Lua
```

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `LIMITER_BACKEND` | `redis` | `redis` (shared across instances) or `memory` (per process) |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |

## How it works

Each limiter is a Lua script that runs **inside Redis**. Redis executes a script start to finish without running other commands in between, so the read → check → write sequence is atomic, even with many app servers sharing one Redis.

- **Token bucket:** a hash `{tokens, ts}` per client. Tokens are refilled lazily from elapsed time on each request.
- **Sliding window:** a sorted set per client, one member per request, scored by timestamp. Old entries are trimmed with `ZREMRANGEBYSCORE`, then counted with `ZCARD`.
- Scripts use Redis's own clock (`TIME`), so app servers with skewed clocks still agree.
- Every key gets a TTL, so idle clients don't use memory.
- If Redis is unreachable, the middleware **fails open** by default (requests pass, an error is logged). Pass `failOpen: false` to reject with `503` instead.

## Why Lua? The race condition

`npm run race` sends 100 simultaneous requests for one client across 5 Redis connections (simulating 5 app servers), with a limit of 10:

```
Naive GET/SET limiter : allowed 100  <- over the limit!
Lua script limiter    : allowed 10
```

The naive version reads the count, checks it in JavaScript, then writes it back. Every server reads the same stale count before anyone writes, so they all allow the request.

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
  lua/
    tokenBucket.lua         atomic token bucket script
    slidingWindow.lua       atomic sliding window script
  limiters/
    redisTokenBucket.js     calls tokenBucket.lua
    redisSlidingWindow.js   calls slidingWindow.lua
    tokenBucket.js          in-memory token bucket
    slidingWindow.js        in-memory sliding window log
  middleware/
    rateLimit.js            wraps any limiter as Express middleware
    requestLogger.js        logs each request
  redis/
    client.js               Redis connection + script registration
test/
  limiters.test.js          in-memory unit tests (fake clock, no waiting)
  redis.test.js             Redis integration tests (skipped if Redis is down)
scripts/
  burst.js                  burst comparison demo
  race-demo.js              naive vs Lua race condition demo
```

## Roadmap

- [x] Stage 1: Express server and middleware
- [x] Stage 2: In-memory token bucket and sliding window
- [x] Stage 3: Redis-backed limiters with atomic Lua scripts
- [ ] Stage 4: Multi-instance test (several servers sharing one Redis)
- [ ] Stage 5: Benchmark (throughput and latency) and burst graphs
- [ ] Stage 6: Write-up on the trade-offs
