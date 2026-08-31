// Runs ONE state's scrape for ONE keyword, then exits. Spawned as a child
// process (see usStateScraper.js) so that whatever memory the browser-based
// scrape used -- Chromium included -- is fully reclaimed by the OS the
// moment this process exits, instead of accumulating across all 46 states
// in one long-lived process (the root cause of Render's free-tier OOM
// crashes during a full US-states run).
//
// Usage: node stateScrapeWorker.js <STATE_CODE> <KEYWORD>
// Prints exactly one JSON line to stdout:
//   {"results":[{"name":"...","extra":"..."}, ...]} or {"error":"..."}
// "extra" is whatever else that state's site returned alongside the name
// (address, status, registered agent -- varies per state), so a match can
// be traced back to a real business, not just a bare name.

require('dotenv').config();
const states = require('../config/usStates.json');
const {
  scrapeWithAPI,
  scrapeWithAxios,
  scrapeWithASPNET,
  scrapeWithBrowser,
  withRetry,
  withTimeout,
} = require('./usStateScraper');

// Kept in sync with usStateScraper.js's own STATE_KEYWORD_TIMEOUT_MS.
const STATE_KEYWORD_TIMEOUT_MS = Math.max(3 * 60 * 1000, Number(process.env.US_STATE_KEYWORD_TIMEOUT_MS) || 0);

async function main() {
  const [stateCode, keyword] = process.argv.slice(2);
  if (!stateCode || !keyword) {
    throw new Error('Usage: node stateScrapeWorker.js <STATE_CODE> <KEYWORD>');
  }

  const state = states.find(s => s.code === stateCode);
  if (!state) throw new Error(`Unknown state code: ${stateCode}`);

  const search = withRetry(`[${state.code}] "${keyword}"`, async () => {
    if (state.method === 'api') return scrapeWithAPI(state, keyword);
    if (state.method === 'axios') return scrapeWithAxios(state, keyword);
    if (state.method === 'aspnet') return scrapeWithASPNET(state, keyword);
    if (state.method === 'browser') return scrapeWithBrowser(state, keyword);
    return [];
  }, state.retries || 0);

  const raw = await withTimeout(
    search,
    STATE_KEYWORD_TIMEOUT_MS,
    `[US-STATES] ${state.code} "${keyword}"`,
  );

  // Dedupe by name+extra together (objects aren't primitive-comparable, so
  // a plain Set on the array wouldn't dedupe them).
  const seen = new Set();
  const results = [];
  for (const item of raw) {
    const key = `${item.name}|${item.extra || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push(item);
    }
  }

  process.stdout.write(JSON.stringify({ results }) + '\n');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    process.stdout.write(JSON.stringify({ error: err.message }) + '\n');
    process.exit(0); // exit 0 -- the parent reads the JSON to decide success/failure
  });
