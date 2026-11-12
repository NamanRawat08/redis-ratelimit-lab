// Unit tests for the in-memory limiters. Run with: npm test
//
// We pass a fake clock (`now`) into each limiter, so we can "jump" time forward
// instantly instead of actually waiting seconds in a test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTokenBucket } from '../src/limiters/tokenBucket.js';
import { InMemorySlidingWindow } from '../src/limiters/slidingWindow.js';

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

async function countAllowed(limiter, key, n) {
  let allowed = 0;
  for (let i = 0; i < n; i++) {
    if ((await limiter.consume(key)).allowed) allowed++;
  }
  return allowed;
}

test('token bucket: allows a burst up to capacity, then rejects', async () => {
  const clock = fakeClock();
  const limiter = new InMemoryTokenBucket({ capacity: 5, refillPerSec: 1, now: clock.now });

  assert.equal(await countAllowed(limiter, 'a', 8), 5);
});

test('token bucket: refills over time, but never above capacity', async () => {
  const clock = fakeClock();
  const limiter = new InMemoryTokenBucket({ capacity: 5, refillPerSec: 1, now: clock.now });

  await countAllowed(limiter, 'a', 5); // empty the bucket
  clock.advance(2000); // 2 tokens drip back in
  assert.equal(await countAllowed(limiter, 'a', 5), 2);

  clock.advance(60_000); // a long idle time still only refills to capacity
  assert.equal(await countAllowed(limiter, 'a', 10), 5);
});

test('token bucket: reports when to retry', async () => {
  const clock = fakeClock();
  const limiter = new InMemoryTokenBucket({ capacity: 1, refillPerSec: 2, now: clock.now });

  await limiter.consume('a');
  const result = await limiter.consume('a');
  assert.equal(result.allowed, false);
  assert.equal(result.retryAfterMs, 500); // 2 tokens/sec => one every 500ms
});

test('sliding window: allows `limit` requests, then rejects', async () => {
  const clock = fakeClock();
  const limiter = new InMemorySlidingWindow({ limit: 5, windowMs: 10_000, now: clock.now });

  assert.equal(await countAllowed(limiter, 'a', 8), 5);
});

test('sliding window: slots free up only as old requests slide out', async () => {
  const clock = fakeClock();
  const limiter = new InMemorySlidingWindow({ limit: 2, windowMs: 10_000, now: clock.now });

  await limiter.consume('a'); // t=0
  clock.advance(4000);
  await limiter.consume('a'); // t=4s, window now full

  clock.advance(5000); // t=9s: both still inside the window
  assert.equal((await limiter.consume('a')).allowed, false);

  clock.advance(1000); // t=10s: the t=0 request slides out, one slot opens
  assert.equal(await countAllowed(limiter, 'a', 2), 1);
});

test('sliding window: no double burst at a window boundary', async () => {
  const clock = fakeClock();
  const limiter = new InMemorySlidingWindow({ limit: 5, windowMs: 10_000, now: clock.now });

  clock.advance(9_900);
  assert.equal(await countAllowed(limiter, 'a', 5), 5); // end of one "window"
  clock.advance(200);
  // A fixed-window limiter would reset here and allow 5 more. Sliding doesn't.
  assert.equal(await countAllowed(limiter, 'a', 5), 0);
});

test('each key gets its own limit', async () => {
  const limiter = new InMemoryTokenBucket({ capacity: 2, refillPerSec: 1 });

  assert.equal(await countAllowed(limiter, 'alice', 3), 2);
  assert.equal(await countAllowed(limiter, 'bob', 3), 2);
});
