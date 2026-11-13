// Benchmark 1: how fast is each limiter, and how much Redis memory does it use?
//
// Calls limiter.consume() directly (no HTTP), so we measure only the limiter.
//   - Throughput: operations per second, with 50 calls in flight at once
//     (like 50 concurrent requests hitting one server).
//   - Latency: p50 / p99 time per call. p99 = "99% of calls were faster than this".
//   - Two key patterns: one "hot" client, and 1,000 different clients.
//   - Memory: Redis bytes per client key, for different limits.
//
// Usage: npm run bench   (needs Redis running)

import { InMemoryTokenBucket } from '../src/limiters/tokenBucket.js';
import { InMemorySlidingWindow } from '../src/limiters/slidingWindow.js';
import { RedisTokenBucket } from '../src/limiters/redisTokenBucket.js';
import { RedisSlidingWindow } from '../src/limiters/redisSlidingWindow.js';
import { createRedisClient } from '../src/redis/client.js';

const OPS = 20_000;
const CONCURRENCY = 50;
const prefix = `bench:${Date.now()}`;
const redis = createRedisClient();

// Same average rate for both: 100 requests per second per client.
const limiters = {
  'memory token bucket': new InMemoryTokenBucket({ capacity: 100, refillPerSec: 100 }),
  'memory sliding window': new InMemorySlidingWindow({ limit: 100, windowMs: 1000 }),
  'redis token bucket': new RedisTokenBucket({ redis, prefix, capacity: 100, refillPerSec: 100 }),
  'redis sliding window': new RedisSlidingWindow({ redis, prefix, limit: 100, windowMs: 1000 }),
};

const keyPatterns = {
  'hot key': () => 'client-0',
  '1k keys': (i) => `client-${i % 1000}`,
};

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function run(limiter, keyFor) {
  const latencies = new Array(OPS);
  let next = 0;

  // CONCURRENCY workers each pull the next op number until OPS are done.
  async function worker() {
    while (next < OPS) {
      const i = next++;
      const start = process.hrtime.bigint();
      await limiter.consume(keyFor(i));
      latencies[i] = Number(process.hrtime.bigint() - start) / 1e6; // ms
    }
  }

  const start = process.hrtime.bigint();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const seconds = Number(process.hrtime.bigint() - start) / 1e9;

  latencies.sort((a, b) => a - b);
  return {
    opsPerSec: Math.round(OPS / seconds),
    p50: percentile(latencies, 50),
    p99: percentile(latencies, 99),
  };
}

// Warm up: loads the Lua scripts into Redis and lets V8 optimise the code.
for (const limiter of Object.values(limiters)) {
  for (let i = 0; i < 2000; i++) await limiter.consume(`warmup-${i % 10}`);
}

const fmt = (ms) => (ms < 0.01 ? '<0.01' : ms.toFixed(2)).padStart(6);

console.log(`Throughput & latency: ${OPS.toLocaleString()} calls, ${CONCURRENCY} in flight\n`);
console.log(`${'limiter'.padEnd(24)}${'keys'.padEnd(10)}${'ops/sec'.padStart(10)}${'p50 ms'.padStart(9)}${'p99 ms'.padStart(9)}`);
const results = [];
for (const [name, limiter] of Object.entries(limiters)) {
  for (const [pattern, keyFor] of Object.entries(keyPatterns)) {
    const r = await run(limiter, keyFor);
    results.push({ limiter: name, keys: pattern, ...r });
    console.log(
      `${name.padEnd(24)}${pattern.padEnd(10)}${r.opsPerSec.toLocaleString().padStart(10)}   ${fmt(r.p50)}   ${fmt(r.p99)}`,
    );
  }
}

// Memory: fill one client's key to its limit, then ask Redis how big it is.
console.log(`\nRedis memory per client key (filled to its limit)\n`);
console.log(`${'limit'.padEnd(8)}${'token bucket'.padStart(14)}${'sliding window'.padStart(16)}`);
const memory = [];
for (const limit of [10, 100, 1000]) {
  const tb = new RedisTokenBucket({ redis, prefix, capacity: limit, refillPerSec: 1 });
  const sw = new RedisSlidingWindow({ redis, prefix, limit, windowMs: 60_000 });
  for (let i = 0; i < limit; i++) {
    await tb.consume(`mem-${limit}`);
    await sw.consume(`mem-${limit}`);
  }
  const tbBytes = await redis.memory('USAGE', `${prefix}:tb:mem-${limit}`);
  const swBytes = await redis.memory('USAGE', `${prefix}:sw:mem-${limit}`);
  memory.push({ limit, tokenBucketBytes: tbBytes, slidingWindowBytes: swBytes });
  console.log(`${String(limit).padEnd(8)}${`${tbBytes} B`.padStart(14)}${`${swBytes.toLocaleString()} B`.padStart(16)}`);
}

// Clean up our keys and save raw numbers for the write-up.
const keys = await redis.keys(`${prefix}:*`);
if (keys.length) await redis.del(...keys);
await redis.quit();

const { writeFileSync, mkdirSync } = await import('node:fs');
mkdirSync('docs', { recursive: true });
writeFileSync('docs/bench-limiters.json', JSON.stringify({ ops: OPS, concurrency: CONCURRENCY, results, memory }, null, 2));
console.log('\nSaved docs/bench-limiters.json');
