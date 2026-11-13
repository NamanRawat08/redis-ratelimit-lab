// Burst simulation: how do the two algorithms shape traffic over time?
//
// Replays traffic patterns against both limiters with a fake clock, so a
// 40-second scenario runs instantly and gives the same result every time.
// It uses the in-memory limiters, which implement the same algorithms as the
// Lua scripts (stage 3's burst demo gave identical numbers for both).
//
// Both limiters average 10 requests per 10 seconds:
//   token bucket   : capacity 10, refill 1 token/sec
//   sliding window : 10 requests per 10-second window
//
// Writes one SVG chart per scenario to docs/, plus the raw numbers as JSON.
//
// Usage: npm run bench:burst

import { writeFileSync, mkdirSync } from 'node:fs';
import { InMemoryTokenBucket } from '../src/limiters/tokenBucket.js';
import { InMemorySlidingWindow } from '../src/limiters/slidingWindow.js';

const DURATION_SEC = 40;

// Each scenario is a list of request times, in ms.
const scenarios = {
  'steady-overload': {
    title: 'Steady overload: client sends 3 requests/sec',
    chart: stepChartSvg,
    requests: Array.from({ length: DURATION_SEC * 3 }, (_, i) => Math.round((i * 1000) / 3)),
  },
  bursty: {
    title: 'Bursty client: bursts of 20, 8 and 5 requests',
    chart: burstBarsSvg,
    requests: [
      ...burst(1_000, 20), // big burst after being idle
      ...burst(6_000, 8), // medium burst 5s later
      ...burst(14_000, 5),
      ...burst(16_000, 5),
      ...burst(18_000, 5), // several small bursts close together
      ...burst(30_000, 20), // big burst after a long idle period
    ],
  },
};

// n requests spread over 100ms starting at `at`.
function burst(at, n) {
  return Array.from({ length: n }, (_, i) => at + Math.floor((i * 100) / n));
}

async function simulate(requests) {
  let now = 0;
  const clock = () => now;
  const limiters = {
    tokenBucket: new InMemoryTokenBucket({ capacity: 10, refillPerSec: 1, now: clock }),
    slidingWindow: new InMemorySlidingWindow({ limit: 10, windowMs: 10_000, now: clock }),
  };

  const perSecond = (fill) => Array.from({ length: DURATION_SEC }, () => fill);
  const offered = perSecond(0);
  const allowed = { tokenBucket: perSecond(0), slidingWindow: perSecond(0) };
  const allowedTimes = { tokenBucket: [], slidingWindow: [] };

  for (const t of requests) {
    now = t;
    const sec = Math.floor(t / 1000);
    offered[sec]++;
    for (const [name, limiter] of Object.entries(limiters)) {
      if ((await limiter.consume('client')).allowed) {
        allowed[name][sec]++;
        allowedTimes[name].push(t);
      }
    }
  }
  return { offered, allowed, allowedTimes };
}

// Most requests allowed in any 10-second span: is "10 per 10s" really held?
function maxInAnyWindow(times, windowMs = 10_000) {
  let max = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i] - times[j] >= windowMs) j++;
    max = Math.max(max, i - j + 1);
  }
  return max;
}

// ---------- SVG charts ----------
// Colors are CSS custom properties with a dark-mode override, so the charts
// read correctly in both GitHub themes.

const W = 760, H = 330;
const m = { top: 78, right: 24, bottom: 44, left: 48 };
const iw = W - m.left - m.right, ih = H - m.top - m.bottom;

const STYLE = `<style>
  svg { --surface:#fcfcfb; --text:#0b0b0b; --muted:#52514e; --grid:#e6e5e1; --axis:#b9b8b2; --offered:#d9d8d3; --s1:#2a78d6; --s2:#eb6834; }
  @media (prefers-color-scheme: dark) {
    svg { --surface:#1a1a19; --text:#f0efec; --muted:#c3c2b7; --grid:#2f2f2d; --axis:#5c5b57; --offered:#4a4a46; --s1:#3987e5; --s2:#d95926; }
  }
  .bg { fill: var(--surface); }
  .title { fill: var(--text); font-size: 15px; font-weight: 600; }
  .sub, .tick, .legend, .axis-label { fill: var(--muted); font-size: 12px; }
  .value { fill: var(--text); font-size: 11px; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .axis { stroke: var(--axis); stroke-width: 1; }
  .offered { fill: var(--offered); }
  .s1 { stroke: var(--s1); fill: none; }
  .s2 { stroke: var(--s2); fill: none; }
  .s1-fill { fill: var(--s1); }
  .s2-fill { fill: var(--s2); }
</style>`;

function frame({ title, subtitle, legend, yMax, body }) {
  const y = (v) => m.top + ih - (v / yMax) * ih;
  const yTicks = Array.from({ length: 6 }, (_, i) => (yMax / 5) * i);

  let lx = m.left;
  const legendSvg = legend
    .map((item) => {
      const mark =
        item.kind === 'box'
          ? `<rect x="${lx}" y="50" width="14" height="10" rx="2" class="${item.cls}"/>`
          : `<line x1="${lx}" y1="55" x2="${lx + 14}" y2="55" class="${item.cls}" stroke-width="2.5" stroke-linecap="round"${item.dashed ? ' stroke-dasharray="5 3"' : ''}/>`;
      const text = `<text x="${lx + 20}" y="59" class="legend">${item.label}</text>`;
      lx += 20 + item.label.length * 6.6 + 22;
      return mark + text;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" role="img" aria-label="${title}">
${STYLE}
<rect class="bg" width="${W}" height="${H}" rx="8"/>
<text x="${m.left}" y="26" class="title">${title}</text>
<text x="${m.left}" y="43" class="sub">${subtitle}</text>
${legendSvg}
${yTicks.map((v) => `<line class="grid" x1="${m.left}" x2="${W - m.right}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${m.left - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('\n')}
${body(y)}
<line class="axis" x1="${m.left}" x2="${W - m.right}" y1="${y(0)}" y2="${y(0)}"/>
</svg>
`;
}

// Change over time: step lines (allowed/sec per algorithm) over an area (sent/sec).
function stepChartSvg({ title, offered, allowed }) {
  const yMax = Math.max(5, Math.ceil(Math.max(...offered) / 5) * 5);
  const x = (s) => m.left + (s / DURATION_SEC) * iw;
  const xTicks = Array.from({ length: DURATION_SEC / 5 + 1 }, (_, i) => i * 5);

  return frame({
    title,
    subtitle: 'Requests per second. Both limiters average 10 requests per 10 seconds.',
    yMax,
    legend: [
      { label: 'Requests sent', cls: 'offered', kind: 'box' },
      { label: 'Token bucket allowed', cls: 's1', kind: 'line', dashed: true },
      { label: 'Sliding window allowed', cls: 's2', kind: 'line' },
    ],
    body: (y) => {
      // Flat across each 1-second bin.
      const step = (values) =>
        values.map((v, s) => `${s === 0 ? 'M' : 'L'}${x(s).toFixed(1)},${y(v).toFixed(1)} H${x(s + 1).toFixed(1)}`).join(' ');
      return `<path class="offered" d="${step(offered)} V${y(0)} H${x(0)} Z"/>
<path class="s2" stroke-width="2" stroke-linejoin="round" d="${step(allowed.slidingWindow)}"/>
<path class="s1" stroke-width="2" stroke-linejoin="round" stroke-dasharray="6 3" d="${step(allowed.tokenBucket)}"/>
${xTicks.map((s) => `<text class="tick" x="${x(s)}" y="${y(0) + 18}" text-anchor="middle">${s}s</text>`).join('\n')}
<text class="axis-label" x="${m.left + iw / 2}" y="${H - 6}" text-anchor="middle">Time</text>`;
    },
  });
}

// Discrete bursts: one group of bars per burst (sent, token bucket, sliding window).
function burstBarsSvg({ title, offered, allowed }) {
  const bursts = offered
    .map((sent, sec) => ({ sec, sent, tb: allowed.tokenBucket[sec], sw: allowed.slidingWindow[sec] }))
    .filter((b) => b.sent > 0);
  const yMax = Math.max(5, Math.ceil(Math.max(...offered) / 5) * 5);
  const groupW = iw / bursts.length;
  const barW = Math.min(36, (groupW - 28) / 3);
  const gap = 2; // surface gap between adjacent bars

  // Bar with a rounded top and a square base on the axis.
  const bar = (bx, v, y, cls) => {
    if (v === 0) return `<line class="${cls.replace('-fill', '')}" x1="${bx}" x2="${bx + barW}" y1="${y(0) - 1}" y2="${y(0) - 1}" stroke-width="2"/>`;
    const top = y(v), r = Math.min(4, (y(0) - top) / 2);
    return `<path class="${cls}" d="M${bx},${y(0)} V${top + r} Q${bx},${top} ${bx + r},${top} H${bx + barW - r} Q${bx + barW},${top} ${bx + barW},${top + r} V${y(0)} Z"/>`;
  };

  return frame({
    title,
    subtitle: 'Requests per burst. Both limiters average 10 requests per 10 seconds.',
    yMax,
    legend: [
      { label: 'Requests sent', cls: 'offered', kind: 'box' },
      { label: 'Token bucket allowed', cls: 's1-fill', kind: 'box' },
      { label: 'Sliding window allowed', cls: 's2-fill', kind: 'box' },
    ],
    body: (y) =>
      bursts
        .map((b, i) => {
          const gx = m.left + i * groupW + (groupW - (3 * barW + 2 * gap)) / 2;
          const cols = [
            { v: b.sent, cls: 'offered' },
            { v: b.tb, cls: 's1-fill' },
            { v: b.sw, cls: 's2-fill' },
          ];
          return `${cols
            .map((c, j) => {
              const bx = gx + j * (barW + gap);
              return `${bar(bx, c.v, y, c.cls)}<text class="value" x="${bx + barW / 2}" y="${y(c.v) - 5}" text-anchor="middle">${c.v}</text>`;
            })
            .join('')}
<text class="tick" x="${gx + (3 * barW + 2 * gap) / 2}" y="${y(0) + 18}" text-anchor="middle">t=${b.sec}s</text>`;
        })
        .join('\n') + `\n<text class="axis-label" x="${m.left + iw / 2}" y="${H - 6}" text-anchor="middle">Burst start time</text>`,
  });
}

// ---------- Run ----------
mkdirSync('docs', { recursive: true });
const summary = {};

for (const [name, scenario] of Object.entries(scenarios)) {
  const result = await simulate(scenario.requests);

  writeFileSync(`docs/burst-${name}.svg`, scenario.chart({ title: scenario.title, ...result }));

  summary[name] = {
    title: scenario.title,
    sent: scenario.requests.length,
    offeredPerSecond: result.offered,
    allowedPerSecond: result.allowed,
  };
  console.log(`\n${scenario.title}  (${scenario.requests.length} sent)`);
  for (const algo of ['tokenBucket', 'slidingWindow']) {
    const times = result.allowedTimes[algo];
    summary[name][algo] = {
      allowed: times.length,
      maxInOneSecond: Math.max(...result.allowed[algo]),
      maxInAny10s: maxInAnyWindow(times),
    };
    const s = summary[name][algo];
    console.log(
      `  ${algo.padEnd(14)} allowed ${String(s.allowed).padStart(3)}   max in 1s: ${String(s.maxInOneSecond).padStart(2)}   max in any 10s: ${s.maxInAny10s}`,
    );
  }
  console.log(`  -> docs/burst-${name}.svg`);
}

writeFileSync('docs/burst-results.json', JSON.stringify(summary, null, 2));
