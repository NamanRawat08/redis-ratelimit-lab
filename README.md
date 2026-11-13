# redis-ratelimit-lab

A distributed rate limiter for Express, backed by Redis and Lua scripts. It implements **token bucket** and **sliding window** limiters and compares how they behave under bursts of traffic.

📄 **[Read the trade-offs write-up](docs/TRADEOFFS.md)**

## Key results

- **Lua makes it race-free.** 100 simultaneous requests across 5 connections, limit 10: a naive `GET`/`SET` limiter allowed **100**; the Lua limiter allowed **10**.
- **Redis makes it distributed.** 3 server instances, limit 10: in-memory limiters allowed **30**; Redis allowed **10**.
- **"10 per 10 seconds" means different things.** The sliding window never allowed more than 10 in any 10 s span; the token bucket allowed up to **19**, because it enforces an average rate plus a burst.
- **Memory, not speed, separates them.** Both cost ~0.3 ms per check and ~7% HTTP throughput. But at a limit of 1,000, the token bucket uses **94 B** per client versus **108 KB** for the sliding window log.

## Quick start

Requires Node.js 18+ and Redis (`brew install redis && brew services start redis` on macOS).

```bash
npm install
npm start          # server on http://localhost:3000
npm test           # unit + Redis integration tests
npm run burst      # burst comparison (run while the server is up)
npm run race       # race condition demo: naive GET/SET vs Lua
npm run multi      # 3 server instances: in-memory vs Redis limits
npm run bench      # limiter throughput, latency and Redis memory
npm run bench:http # HTTP overhead of each limiter (autocannon)
npm run bench:burst # traffic-shaping simulation -> docs/*.svg charts
```

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `LIMITER_BACKEND` | `redis` | `redis` (shared across instances) or `memory` (per process) |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `RATE_LIMIT_PREFIX` | `rl` | Redis key prefix; instances with the same prefix share limits |

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

## Why Redis? Multiple instances

`npm run multi` starts 3 copies of the server and sends 30 requests from one client round-robin across them, as a load balancer would. The limit is 10:

```
memory  /api/token-bucket      allowed 30 / 30  <- limit broken!
memory  /api/sliding-window    allowed 30 / 30  <- limit broken!
redis   /api/token-bucket      allowed 10 / 30
redis   /api/sliding-window    allowed 10 / 30
```

In-memory limiters only see their own instance's traffic, so the real limit becomes `limit × instances`. With Redis, every instance reads and updates the same counters.

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

## Traffic shaping over time

`npm run bench:burst` replays two traffic patterns against both algorithms with a simulated clock (deterministic, same algorithms as the Lua scripts).

![Steady overload chart](docs/burst-steady-overload.svg)

Under steady overload, the **token bucket smooths output to its refill rate** (1/sec), while the **sliding window lets traffic through in waves**: 10 requests at the start of each window, then nothing for ~7 seconds.

![Bursty client chart](docs/burst-bursty.svg)

| Scenario | Algorithm | Allowed | Most in any 10s span |
|---|---|---|---|
| Steady overload (120 sent) | Token bucket | 49 | **19** |
| | Sliding window | 40 | 10 |
| Bursty (63 sent) | Token bucket | 37 | **15** |
| | Sliding window | 30 | 10 |

The sliding window **never** exceeds 10 in any 10-second span. The token bucket can allow up to `capacity + rate × window` (10 + 9 = 19), because a full bucket can be emptied and then refilled within one window. It's more forgiving to bursty clients, but it's a looser guarantee.

## Benchmarks

Apple M1 (8 cores), Redis 8 on localhost, Node.js 24. Absolute numbers depend on the machine; the comparisons are what matter.

**Limiter only** (`npm run bench`): 20,000 `consume()` calls, 50 in flight.

| Limiter | Keys | ops/sec | p50 | p99 |
|---|---|---|---|---|
| In-memory token bucket | 1 hot key | ~3.2M | <0.01 ms | 0.04 ms |
| In-memory sliding window | 1 hot key | ~4.4M | <0.01 ms | 0.02 ms |
| Redis token bucket | 1 hot key | ~137k | 0.30 ms | 1.50 ms |
| Redis token bucket | 1,000 keys | ~158k | 0.30 ms | 0.63 ms |
| Redis sliding window | 1 hot key | ~165k | 0.29 ms | 0.62 ms |
| Redis sliding window | 1,000 keys | ~161k | 0.29 ms | 0.54 ms |

Redis is ~20× slower than in-memory, because every call is a network round trip. That's the price of a shared, correct limit. Both Redis algorithms cost about the same per call.

**Through HTTP** (`npm run bench:http`): 50 connections, 10 s per route, Redis backend.

| Route | req/sec | p50 | p99 |
|---|---|---|---|
| `/api/data` (no limiter) | ~31.9k | 1 ms | 3 ms |
| `/api/token-bucket` | ~29.7k | 1 ms | 2 ms |
| `/api/sliding-window` | ~29.3k | 1 ms | 2 ms |

End to end, the Redis limiter costs **~7–8% throughput** and no visible latency at millisecond resolution.

**Redis memory per client** (filled to its limit):

| Limit | Token bucket | Sliding window |
|---|---|---|
| 10 | 106 B | 543 B |
| 100 | 106 B | 4.9 KB |
| 1,000 | 94 B | 108 KB |

The token bucket stores two numbers whatever the limit. The sliding window log stores one entry per request, so memory grows linearly with the limit. At 1,000 requests/window × 1 million clients, that's ~100 GB vs ~100 MB.

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
  multi-instance.js         3 instances: in-memory vs Redis
bench/
  limiters.js               throughput, latency, memory
  http.js                   HTTP load test with autocannon
  burst-sim.js              traffic-shaping simulation + SVG charts
docs/
  TRADEOFFS.md              write-up: which algorithm, when, and why
  *.svg, *.json             generated charts and raw benchmark data
```

## Possible next steps

- Sliding window *counter*: O(1) memory with near-strict limits
- Per-route and per-user limits (key by API key instead of IP)
- Run benchmarks against Redis over a real network
