// Burst demo: fires bursts of simultaneous requests at both limited endpoints
// and prints how many each one let through.
//
// Usage: start the server (npm start), then in another terminal: npm run burst
//
// Both limiters average 10 requests per 10 seconds, but they treat bursts differently.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ENDPOINTS = ['/api/token-bucket', '/api/sliding-window'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function burst(path, count) {
  const responses = await Promise.all(
    Array.from({ length: count }, () => fetch(BASE_URL + path)),
  );
  return responses.filter((r) => r.status === 200).length;
}

async function phase(label, count) {
  console.log(`\n${label}: ${count} requests at once`);
  for (const path of ENDPOINTS) {
    const allowed = await burst(path, count);
    console.log(`  ${path.padEnd(22)} allowed ${String(allowed).padStart(2)} / ${count}`);
  }
}

const start = Date.now();
const at = () => `t=${Math.round((Date.now() - start) / 1000)}s`;

await phase(`${at()}  first burst`, 15);
await sleep(3000);
await phase(`${at()}  small burst`, 5);
await sleep(8000);
await phase(`${at()}  big burst`, 15);
