# Token bucket vs sliding window: trade-offs

A short write-up of what this project measured, and how to choose between the two algorithms.

## TL;DR

| If you need… | Use |
|---|---|
| Smooth traffic, friendliness to bursty clients, tiny memory | **Token bucket** |
| A strict "never more than N in any T seconds" guarantee | **Sliding window** |
| A strict-ish guarantee at large limits (thousands per window) | **Sliding window *counter*** (not built here, see below) |

Both are correct and race-free when run as Lua scripts in Redis. They differ in **what they promise**, **how they shape traffic** and **what they cost**.

## Setup

Both limiters were configured to the same average rate, **10 requests per 10 seconds**:

- Token bucket: capacity 10, refill 1 token/sec.
- Sliding window (log): at most 10 requests in any 10-second window.

Benchmarks ran on an Apple M1 with Redis 8 on localhost. Absolute numbers will differ elsewhere; the comparisons hold.

## 1. They promise different things

This was the most important finding.

| Scenario | Token bucket: most allowed in any 10 s | Sliding window: most allowed in any 10 s |
|---|---|---|
| Steady overload (3 req/s) | **19** | 10 |
| Bursty client | **15** | 10 |

- **Sliding window** enforces a hard cap: at most `limit` requests in *every* window, no matter where the window starts.
- **Token bucket** enforces a long-run average, plus a burst allowance. In the worst case it allows `capacity + rate × window` in one window (10 + 9 = 19 here), because a full bucket can be emptied and then refilled within the same window.

So "10 per 10 seconds" means different things. If a downstream system breaks at 11 requests in 10 seconds, the token bucket isn't safe at these settings. You'd have to halve its capacity, which makes it stricter for everyone.

## 2. They shape traffic differently

See the charts in the [README](../README.md#traffic-shaping-over-time).

- **Token bucket smooths.** Under steady overload, output settles at exactly the refill rate (1/sec). A client that pauses earns capacity back gradually.
- **Sliding window comes in waves.** Under steady overload it lets 10 through, then blocks for ~7 seconds until those slide out, then lets the next 10 through. Downstream services see bursts instead of a steady flow.
- **Recovery after a burst:** 3 seconds after using the full limit, the token bucket allowed 3 more requests and the sliding window allowed 0. A sliding window punishes the client for the whole window.

For user-facing APIs, the token bucket usually feels fairer: brief spikes (page loads, retries) go through, sustained abuse is throttled. For protecting a fragile resource, the sliding window's hard cap is easier to reason about.

## 3. Cost

**Latency and throughput are not the deciding factor.** Both Redis scripts cost the same (~0.3 ms p50, ~150k checks/sec on one connection). Through HTTP, either limiter cost ~7–8% throughput versus an unlimited route. Express and HTTP parsing cost far more than the limiter.

**Memory is.** Redis memory per client, filled to its limit:

| Limit | Token bucket | Sliding window log |
|---|---|---|
| 10 | 106 B | 543 B |
| 100 | 106 B | 4.9 KB |
| 1,000 | 94 B | 108 KB |

The token bucket stores two numbers (`tokens`, `ts`) regardless of the limit, so it's O(1) per client. The sliding window log stores one sorted-set entry per request, so it's O(limit) per client. At 1 million active clients with a limit of 1,000, that's roughly **100 MB vs 100 GB**.

The sliding window log also does more work per call (`ZREMRANGEBYSCORE`, `ZCARD`, `ZADD`), which is O(log n) in the set size. At small limits this didn't show up in the benchmark.

## 4. What's the same for both

These design decisions apply to either algorithm:

- **Atomicity via Lua.** The race demo showed a naive `GET`/`SET` limiter allowing 100 of 100 requests across 5 connections when the limit was 10. Lua scripts run atomically in Redis; `MULTI`/`EXEC` can't branch on a value read inside the transaction, and `WATCH` retries pile up under exactly the bursty load a limiter exists for.
- **Shared state via Redis.** With 3 instances, in-memory limiters allowed 30 of 30 (3× the limit). Redis held it at 10.
- **One clock.** Scripts use Redis `TIME`, so app servers with skewed clocks still agree.
- **One key per script.** Each script touches a single key, so it works unchanged on Redis Cluster (each client's key lives on one shard).
- **Expiring keys.** Every key has a TTL, so idle clients cost nothing.
- **Failure mode.** If Redis is unreachable, the middleware fails open by default (stays available, unprotected). Sensitive routes such as login should use `failOpen: false` and return 503.

## 5. Alternatives not built here

- **Fixed window counter.** One `INCR` per window. Cheapest of all, but allows up to 2× the limit around window boundaries (N at 0:59, N at 1:00). One of the unit tests checks that the sliding window doesn't have this flaw.
- **Sliding window counter.** Keeps counts for the current and previous fixed windows and weights the previous one by how much of it still overlaps. O(1) memory like the token bucket, close to the sliding log's strictness. This is the usual production choice when limits are large. It's the natural next step for this project.
- **GCRA (generic cell rate algorithm).** Mathematically equivalent to a token bucket but stores a single timestamp. Used by several production rate-limiting libraries.
- **Leaky bucket (as a queue).** Delays requests instead of rejecting them, which gives a perfectly smooth output rate at the cost of added latency.

## 6. Limitations of this study

- Redis ran on the same machine. Over a real network each check adds ~0.5–1 ms, which makes the limiter a bigger share of request latency.
- Single Redis node. Redis replication is asynchronous, so a failover can lose recent counts and briefly over-allow. That's usually acceptable for rate limiting.
- One hot key concentrates load on one Redis shard. Very high-traffic keys may need local pre-limiting in each instance before checking Redis.
- Burst charts use a simulated clock with the in-memory implementations. These implement the same algorithms as the Lua scripts, and the live Redis burst demo produced identical numbers.

## Conclusion

Neither algorithm is better in general. **Pick by the guarantee you need, then check the memory cost:**

- Default to a **token bucket** for public APIs: smooth, burst-tolerant, tiny.
- Use a **sliding window** when a hard per-window cap is the requirement, and switch from the log to the counter variant once limits get large.
