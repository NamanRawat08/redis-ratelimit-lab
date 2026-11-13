// Benchmark 2: what does rate limiting cost a real HTTP request?
//
// Starts the server (Redis backend) and load-tests three routes with
// autocannon, a standard Node.js HTTP load tester:
//   /api/data            no limiter (baseline)
//   /api/token-bucket    Redis token bucket
//   /api/sliding-window  Redis sliding window
// The difference from the baseline is the limiter's overhead per request.
//
// Note: all traffic comes from one IP, so after the first 10 requests the
// limited routes return 429. That's fine here: the Lua script runs on every
// request either way, and that's the cost we're measuring.
//
// Usage: npm run bench:http   (needs Redis running)

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import autocannon from 'autocannon';

const PORT = 4200;
const DURATION_SEC = 10;
const CONNECTIONS = 50;
const ROUTES = ['/api/data', '/api/token-bucket', '/api/sliding-window'];

const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT), LIMITER_BACKEND: 'redis', RATE_LIMIT_PREFIX: `bench-http:${Date.now()}` },
  stdio: 'ignore',
});

async function waitUntilUp() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not start');
}

try {
  await waitUntilUp();
  console.log(`HTTP load test: ${CONNECTIONS} connections, ${DURATION_SEC}s per route\n`);
  console.log(`${'route'.padEnd(22)}${'req/sec'.padStart(10)}${'p50 ms'.padStart(9)}${'p99 ms'.padStart(9)}`);

  const results = [];
  for (const route of ROUTES) {
    const r = await autocannon({
      url: `http://localhost:${PORT}${route}`,
      connections: CONNECTIONS,
      duration: DURATION_SEC,
    });
    const row = {
      route,
      reqPerSec: Math.round(r.requests.average),
      p50: r.latency.p50,
      p99: r.latency.p99,
      errors: r.errors,
    };
    results.push(row);
    console.log(
      `${route.padEnd(22)}${row.reqPerSec.toLocaleString().padStart(10)}${String(row.p50).padStart(9)}${String(row.p99).padStart(9)}`,
    );
  }

  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/bench-http.json', JSON.stringify({ connections: CONNECTIONS, durationSec: DURATION_SEC, results }, null, 2));
  console.log('\nSaved docs/bench-http.json');
} finally {
  server.kill();
}
