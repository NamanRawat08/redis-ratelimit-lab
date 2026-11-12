// Race condition demo: why we need Lua scripts.
//
// We simulate 5 app servers (5 separate Redis connections) all limiting the
// same client to 10 requests, and fire 100 requests at once.
//
//   Naive limiter : GET the count, check it in JavaScript, then SET count + 1.
//                   Between the GET and the SET, other servers read the same
//                   old count, so they ALL think there's room.
//   Lua limiter   : the whole read-check-write runs inside Redis as one step,
//                   so nothing can sneak in between.
//
// Usage: npm run race   (needs Redis running)

import { createRedisClient } from '../src/redis/client.js';
import { RedisSlidingWindow } from '../src/limiters/redisSlidingWindow.js';

const SERVERS = 5;
const REQUESTS = 100;
const LIMIT = 10;

const servers = Array.from({ length: SERVERS }, () => createRedisClient());
const key = `race-demo:${Date.now()}`;

// The broken version. Each step on its own is fine; the gap between them isn't.
async function naiveConsume(redis) {
  const count = Number(await redis.get(`${key}:naive`)) || 0; // 1. read
  if (count >= LIMIT) return false; //                            2. check
  await redis.set(`${key}:naive`, count + 1, 'PX', 10_000); //   3. write
  return true;
}

const limiters = servers.map(
  (redis) => new RedisSlidingWindow({ redis, limit: LIMIT, windowMs: 10_000, prefix: key }),
);

// Spread the requests across the "servers", round-robin, all at once.
const naiveResults = await Promise.all(
  Array.from({ length: REQUESTS }, (_, i) => naiveConsume(servers[i % SERVERS])),
);
const luaResults = await Promise.all(
  Array.from({ length: REQUESTS }, (_, i) => limiters[i % SERVERS].consume('client-1')),
);

const naiveAllowed = naiveResults.filter(Boolean).length;
const luaAllowed = luaResults.filter((r) => r.allowed).length;

console.log(`${REQUESTS} simultaneous requests from 1 client, across ${SERVERS} servers, limit ${LIMIT}:\n`);
console.log(`  Naive GET/SET limiter : allowed ${naiveAllowed}  ${naiveAllowed > LIMIT ? '<- over the limit!' : ''}`);
console.log(`  Lua script limiter    : allowed ${luaAllowed}`);

await servers[0].del(`${key}:naive`, `${key}:sw:client-1`);
await Promise.all(servers.map((r) => r.quit()));
