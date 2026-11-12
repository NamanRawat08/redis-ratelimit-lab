// Integration tests for the Redis limiters. They need a real Redis
// (default redis://localhost:6379) and are skipped if it isn't running.
//
// These limiters use Redis's clock, so we can't fake time here. We test with
// small numbers and short waits instead.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRedisClient } from '../src/redis/client.js';
import { RedisTokenBucket } from '../src/limiters/redisTokenBucket.js';
import { RedisSlidingWindow } from '../src/limiters/redisSlidingWindow.js';

const prefix = `test:${process.pid}:${Date.now()}`; // keeps test keys apart from real ones
let redis;
let redisUp = false;

before(async () => {
  redis = createRedisClient();
  try {
    await redis.ping();
    redisUp = true;
  } catch {
    console.warn('Redis not reachable, skipping Redis tests');
  }
});

after(async () => {
  if (redisUp) {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length) await redis.del(...keys);
  }
  redis.disconnect();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function countAllowed(limiter, key, n) {
  const results = await Promise.all(Array.from({ length: n }, () => limiter.consume(key)));
  return results.filter((r) => r.allowed).length;
}

test('redis token bucket: allows a burst up to capacity, then refills', async (t) => {
  if (!redisUp) return t.skip();
  const limiter = new RedisTokenBucket({ redis, capacity: 5, refillPerSec: 10, prefix });

  assert.equal(await countAllowed(limiter, 'a', 8), 5);
  await sleep(250); // 10 tokens/sec => ~2 tokens back
  const allowed = await countAllowed(limiter, 'a', 5);
  assert.ok(allowed >= 2 && allowed <= 3, `expected 2-3, got ${allowed}`);
});

test('redis sliding window: allows `limit` per window', async (t) => {
  if (!redisUp) return t.skip();
  const limiter = new RedisSlidingWindow({ redis, limit: 5, windowMs: 300, prefix });

  assert.equal(await countAllowed(limiter, 'a', 8), 5);
  const rejected = await limiter.consume('a');
  assert.equal(rejected.allowed, false);
  assert.ok(rejected.retryAfterMs > 0 && rejected.retryAfterMs <= 300);

  await sleep(350); // the whole window has slid past
  assert.equal(await countAllowed(limiter, 'a', 8), 5);
});

test('limits hold across many connections at once (no race condition)', async (t) => {
  if (!redisUp) return t.skip();
  // 5 connections = 5 app servers sharing one Redis.
  const conns = Array.from({ length: 5 }, () => createRedisClient());
  const buckets = conns.map((r) => new RedisTokenBucket({ redis: r, capacity: 10, refillPerSec: 0.001, prefix }));
  const windows = conns.map((r) => new RedisSlidingWindow({ redis: r, limit: 10, windowMs: 60_000, prefix }));

  const fire = (limiters) =>
    Promise.all(Array.from({ length: 200 }, (_, i) => limiters[i % limiters.length].consume('shared')));

  assert.equal((await fire(buckets)).filter((r) => r.allowed).length, 10);
  assert.equal((await fire(windows)).filter((r) => r.allowed).length, 10);
  conns.forEach((r) => r.disconnect());
});

test('keys get an expiry, so idle clients do not leak memory', async (t) => {
  if (!redisUp) return t.skip();
  const bucket = new RedisTokenBucket({ redis, capacity: 5, refillPerSec: 1, prefix });
  const window = new RedisSlidingWindow({ redis, limit: 5, windowMs: 2000, prefix });

  await bucket.consume('ttl');
  await window.consume('ttl');
  assert.ok((await redis.pttl(`${prefix}:tb:ttl`)) > 0);
  assert.ok((await redis.pttl(`${prefix}:sw:ttl`)) > 0);
});
