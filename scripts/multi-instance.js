// Multi-instance test: does the limit hold when the app runs on several servers?
//
// In production you rarely run one copy of an API. A load balancer spreads
// requests across many copies ("instances"). This script:
//   1. Starts 3 copies of our server on different ports.
//   2. Sends 30 requests from one client, round-robin across them
//      (that's what a load balancer does).
//   3. Counts how many got through.
// It does this twice: once with in-memory limiters, once with Redis.
//
// Expected: the limit is 10. In-memory lets ~30 through (10 per instance,
// because each copy only knows about its own traffic). Redis lets exactly 10.
//
// Usage: npm run multi   (needs Redis running)

import { spawn } from 'node:child_process';

const INSTANCES = 3;
const REQUESTS = 30;
const BASE_PORT = 4100;
const ENDPOINTS = ['/api/token-bucket', '/api/sliding-window'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntilUp(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(50);
  }
  throw new Error(`server on port ${port} did not start`);
}

async function startCluster(backend) {
  // A fresh prefix each run, so counters from earlier runs don't interfere.
  const prefix = `multi:${Date.now()}`;
  const ports = Array.from({ length: INSTANCES }, (_, i) => BASE_PORT + i);

  const procs = ports.map((port) =>
    spawn(process.execPath, ['src/server.js'], {
      env: { ...process.env, PORT: String(port), LIMITER_BACKEND: backend, RATE_LIMIT_PREFIX: prefix },
      stdio: 'ignore', // hide the request logs
    }),
  );
  await Promise.all(ports.map(waitUntilUp));

  return { ports, stop: () => procs.forEach((p) => p.kill()) };
}

// Fire all requests at once, spread round-robin across the instances.
async function loadBalancedBurst(ports, path) {
  const responses = await Promise.all(
    Array.from({ length: REQUESTS }, (_, i) => fetch(`http://localhost:${ports[i % ports.length]}${path}`)),
  );
  return responses.filter((r) => r.status === 200).length;
}

console.log(`${REQUESTS} requests from 1 client, round-robin across ${INSTANCES} instances, limit 10:\n`);

for (const backend of ['memory', 'redis']) {
  const cluster = await startCluster(backend);
  try {
    for (const path of ENDPOINTS) {
      const allowed = await loadBalancedBurst(cluster.ports, path);
      const flag = allowed > 10 ? '  <- limit broken!' : '';
      console.log(`  ${backend.padEnd(7)} ${path.padEnd(22)} allowed ${String(allowed).padStart(2)} / ${REQUESTS}${flag}`);
    }
  } finally {
    cluster.stop();
  }
}
