const axios = require('axios');
const cheerio = require('cheerio');
const levenshtein = require('fast-levenshtein');
const supabase = require('../lib/supabase');
const https = require('https');
const fs = require('fs');
const path = require('path');

const states = require('../config/usStates.json');

// Render cannot reliably launch several Chromium processes at once. Sequential
// browser work avoids ETXTBSY and WebSocket-endpoint startup failures.
const STATE_CONCURRENCY = 1;
const STATE_KEYWORD_TIMEOUT_MS = Math.max(10 * 60 * 1000, Number(process.env.US_STATE_KEYWORD_TIMEOUT_MS) || 0);
const STATE_RUN_TIMEOUT_MS = Math.max(90 * 60 * 1000, Number(process.env.US_STATE_RUN_TIMEOUT_MS) || 0);

// Best-effort container memory check (cgroup v2, falling back to v1). Render's
// free tier OS-kills the whole process with no catchable error once memory
// crosses its limit — by that point nothing (including the report step that
// runs after this scraper) can recover. Returns null if unreadable (e.g. not
// running in a cgroup, like local Windows dev), so callers must treat null as
// "unknown, don't act on it" rather than "safe".
function getContainerMemoryRatio() {
  try {
    const usage = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
    const limitRaw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (limitRaw === 'max') return null;
    const limit = Number(limitRaw);
    if (!usage || !limit) return null;
    return usage / limit;
  } catch (_) {
    try {
      const usage = Number(fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim());
      const limit = Number(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim());
      if (!usage || !limit) return null;
      return usage / limit;
    } catch (_) {
      return null;
    }
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function mapWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
}

function getSupportedStates(code) {
  const active = states.filter(s => s.accessible);
  if (!code) return active;

  const normalized = String(code).trim().toUpperCase();
  return active.filter(s => s.code === normalized);
}

function getUnsupportedStates() {
  return states
    .filter(s => !s.accessible)
    .map(s => ({ code: s.code, state: s.state, reason: s.notes }));
}

function formatStateSummary(totalStates, workingStates, partialStates, failedStates, warnings = []) {
  const working = [...workingStates].sort();
  const partial = [...partialStates].sort();
  const failed = [...failedStates].sort();
  const checked = new Set([...working, ...failed]).size;
  const parts = [
    `State scan summary: ${checked}/${totalStates} checked`,
    `Working (${working.length}): ${working.join(', ') || 'none'}`,
    `Partial (${partial.length}): ${partial.join(', ') || 'none'}`,
    `Failed (${failed.length}): ${failed.join(', ') || 'none'}`,
  ];
  if (warnings.length) parts.push(`Details: ${warnings.slice(0, 10).join(' | ')}`);
  return parts.join(' | ');
}

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

// Allow self-signed certs (OK, MO SSL issues)
const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

function isRetryableError(err) {
  const msg = String(err?.message || '');
  return /timeout|ECONNRESET|ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED|503|403/i.test(msg);
}

async function withRetry(label, fn, retries = 0) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isRetryableError(err)) break;
      console.warn(`[US-STATES] ${label} retry ${attempt + 1}/${retries}: ${err.message}`);
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ── STRICT MATCHING ───────────────────────────────────────────────────────────
// Strip common legal entity suffixes so "GUCCI LLC" base becomes "GUCCI"
const SUFFIX_RE = /[\s,.]*(LLC|L\.L\.C\.?|INC\.?|CORP\.?|LTD\.?|L\.P\.?|LLP|L\.L\.P\.?|P\.C\.?|CO\.?|COMPANY|COMPANIES|HOLDINGS?|GROUP|ENTERPRISES?|INDUSTRIES|INTERNATIONAL|WORLDWIDE|GLOBAL|FOUNDATION|TRUST|ASSOCIATES?|PARTNERS?|SERVICES?|SYSTEMS?|DISSOLVED[^,)]*|CANCELLED[^,)]*)/gi;

function stripSuffixes(name) {
  return name
    .replace(SUFFIX_RE, ' ')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// VALID match: after stripping suffixes, base name equals keyword OR starts with keyword + space
// Examples that PASS:   "GUCCI LLC" → "GUCCI" == "GUCCI"
//                       "GUCCI AMERICA INC" → "GUCCI AMERICA" starts with "GUCCI "
// Examples that FAIL:   "GucciBear Distribution" → "GucciBear Distribution" ≠ "GUCCI" and not starts with "GUCCI "
//                       "GUCCINI FARMS LLC" → "GUCCINI FARMS" ≠ "GUCCI" and not starts with "GUCCI "
//                       "JOHN GUCCI DESIGNS" → "JOHN GUCCI DESIGNS" does not start with "GUCCI "
function isValidMatch(name, keyword) {
  const base = stripSuffixes(name).toLowerCase();
  const kw   = stripSuffixes(keyword).toLowerCase();
  return base === kw || base.startsWith(kw + ' ');
}

function similarity(a, b) {
  const s1 = a.toLowerCase().trim();
  const s2 = b.toLowerCase().trim();
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein.get(s1, s2) / maxLen;
}

// Generic cheerio td extractor — deduplicated, length-filtered
function extractTd($) {
  const seen = new Set();
  const out  = [];
  $('td').each((_, el) => {
    const t = $(el).text().trim();
    if (t && t.length > 1 && t.length < 250 && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  });
  return out;
}

// ── API BRANCH (Socrata $where — searches by name field only) ────────────────
async function scrapeWithAPI(state, keyword) {
  const kwSafe = keyword.replace(/'/g, "''");
  const { data } = await axios.get(state.url, {
    params: {
      '$where': `upper(${state.nameField}) like upper('%${kwSafe}%')`,
      '$limit': 100,
    },
    timeout: 12000,
    headers: { 'Accept': 'application/json' },
  });
  if (!Array.isArray(data)) return [];
  return data.map(r => (r[state.nameField] || '').trim()).filter(Boolean);
}

// ── AXIOS BRANCH (plain HTML GET) ────────────────────────────────────────────
async function scrapeWithAxios(state, keyword) {
  const extra = state.extraParams || {};
  const resp  = await axios.get(state.url, {
    params: { [state.searchParam]: keyword, ...extra },
    timeout: 12000,
    headers: BASE_HEADERS,
    httpsAgent: HTTPS_AGENT,
  });
  return extractTd(cheerio.load(resp.data));
}

// ── ASP.NET BRANCH — extracts ALL hidden inputs to avoid 500 errors ──────────
async function scrapeWithASPNET(state, keyword) {
  const cfg = { timeout: 12000, headers: BASE_HEADERS, httpsAgent: HTTPS_AGENT };

  // Step 1: GET — extract every <input type="hidden"> on the page
  const getResp = await axios.get(state.url, cfg);
  const $1 = cheerio.load(getResp.data);

  const hidden = {};
  $1('input[type="hidden"]').each((_, el) => {
    const n = $1(el).attr('name');
    const v = $1(el).attr('value') || '';
    if (n) hidden[n] = v;
  });

  const cookies = (getResp.headers['set-cookie'] || [])
    .map(c => c.split(';')[0]).join('; ');

  // Step 2: POST — all hidden fields + search term + submit button
  const postBody = new URLSearchParams({
    ...hidden,
    [state.searchParam]: keyword,
    [state.postButton || 'btnSearch']: 'Search',
  });

  const postResp = await axios.post(state.url, postBody.toString(), {
    ...cfg,
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookies,
      'Referer': state.url,
      'Origin': new URL(state.url).origin,
    },
    maxRedirects: 5,
  });

  return extractTd(cheerio.load(postResp.data));
}

// ── BROWSER BRANCH (Puppeteer — SPAs, 403 sites, JS-rendered) ───────────────
async function scrapeWithBrowser(state, keyword) {
  const { launchBrowser } = require('../lib/browser');
  const browser = await launchBrowser(['--ignore-certificate-errors', '--disable-blink-features=AutomationControlled', '--disable-web-security']);
  const navigationTimeout = state.navigationTimeout || 120000;
  const selectorTimeout   = state.selectorTimeout   || 30000;
  const actionTimeout     = state.actionTimeout     || 90000;
  const settleDelay       = state.settleDelay       || 2500;
  // SPAs commonly keep analytics/API connections open, so networkidle2 can
  // time out even after the usable page has loaded.
  const waitUntil         = state.waitUntil         || 'domcontentloaded';

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(actionTimeout);
    page.setDefaultNavigationTimeout(navigationTimeout);
    await page.setUserAgent(BASE_HEADERS['User-Agent']);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Some sites check navigator.webdriver
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.goto(state.url, { waitUntil, timeout: navigationTimeout });

    // Click any pre-search elements (e.g. radio buttons to select search type)
    if (Array.isArray(state.clickBefore)) {
      for (const sel of state.clickBefore) {
        try { await page.click(sel); await new Promise(r => setTimeout(r, 300)); } catch (_) {}
      }
    }

    // Find input: state-specific selector → fallback chain
    const inputCandidates = [
      state.searchInput,
      state.searchParam ? `[name="${state.searchParam}"]` : null,
      'input[type="search"]',
      'input[placeholder*="name" i]',
      'input[placeholder*="search" i]',
      'input[placeholder*="entity" i]',
      'input[placeholder*="business" i]',
      'input[type="text"]:not([type="hidden"])',
    ].filter(Boolean);

    let typed = false;
    for (const sel of inputCandidates) {
      try {
        await page.waitForSelector(sel, { timeout: selectorTimeout });
        await page.$eval(sel, el => { el.value = ''; el.focus(); });
        await page.type(sel, keyword, { delay: 50 });
        typed = true;
        break;
      } catch (_) {}
    }
    if (!typed) return [];

    // Submit — every path guarded: a page that closes/crashes on submit
    // (seen on MD) must not throw past this point, or a working search
    // gets wasted on an uncaught "Target closed" error.
    if (state.searchSubmit) {
      try { await page.click(state.searchSubmit); }
      catch (_) { await page.keyboard.press('Enter').catch(() => {}); }
    } else {
      await page.keyboard.press('Enter').catch(() => {});
    }

    await page.waitForNavigation({ waitUntil, timeout: actionTimeout }).catch(() => {});
    await new Promise(r => setTimeout(r, settleDelay));

    // Extract names
    const resSel = state.resultsSelector || 'td';
    const names = await page.$$eval(resSel,
      els => els.map(el => el.textContent.trim()).filter(t => t.length > 1 && t.length < 250)
    ).catch(() => []);

    return [...new Set(names)];
  } finally {
    await browser.close();
  }
}

// ── INSERT IF NEW ────────────────────────────────────────────────────────────
async function insertIfNew(registry, filingName, keyword, score) {
  const { data: ex } = await supabase
    .from('trademark_matches')
    .select('id')
    .eq('registry', registry)
    .eq('filing_name', filingName)
    .eq('matched_keyword', keyword)
    .limit(1);
  if (ex && ex.length > 0) return false;

  await supabase.from('trademark_matches').insert({
    registry,
    filing_name: filingName,
    matched_keyword: keyword,
    similarity_score: score,
    status: 'new',
    created_at: new Date().toISOString(),
  });
  return true;
}

// ── MAIN RUNNER ──────────────────────────────────────────────────────────────
async function runUSStateScraper(code = null) {
  const selectedCode = code ? String(code).trim().toUpperCase() : null;
  console.log(selectedCode
    ? `[US-STATES] Starting ${selectedCode} state registry scan...`
    : '[US-STATES] Starting supported US state registry scan...');

  const active = getSupportedStates(selectedCode);
  if (selectedCode && active.length === 0) {
    const knownState = states.find(s => s.code === selectedCode);
    const reason = knownState
      ? getUnsupportedStates().find(s => s.code === selectedCode)?.reason || knownState.notes
      : 'Unknown state code.';
    throw new Error(`US-${selectedCode} is not enabled for scraping: ${reason}`);
  }

  const unsupported = getUnsupportedStates();
  if (!selectedCode && unsupported.length) {
    console.log(`[US-STATES] Not enabled (${unsupported.length}): ${
      unsupported.map(s => `${s.code} (${s.reason})`).join(' | ')
    }`);
  }
  console.log(`[US-STATES] Scanning ${active.length} states (${
    active.filter(s => s.method === 'browser').length
  } via browser, ${
    active.filter(s => s.method === 'aspnet').length
  } ASP.NET, ${
    active.filter(s => s.method === 'api').length
  } API, ${
    active.filter(s => s.method === 'axios').length
  } HTML GET)...`);

  const { data: logEntry } = await supabase
    .from('scan_logs')
    .insert([{ scan_type: selectedCode ? `trademark_us_${selectedCode.toLowerCase()}` : 'trademark_us_states', started_at: new Date().toISOString() }])
    .select().single();
  const logId = logEntry?.id;

  const { data: keywords } = await supabase
    .from('keywords').select('term').eq('active', true);
  if (!keywords?.length) { console.log('[US-STATES] No active keywords.'); return 0; }

  const gaps = [];
  let totalFound = 0;
  let errorLog   = null;
  const warningMessages = [];
  const report   = [];

  for (const state of active) {
    for (const kw of keywords) {
      try {
        let names = await withRetry(`[${state.code}] "${kw.term}"`, async () => {
          if (state.method === 'api')     return scrapeWithAPI(state, kw.term);
          if (state.method === 'axios')   return scrapeWithAxios(state, kw.term);
          if (state.method === 'aspnet')  return scrapeWithASPNET(state, kw.term);
          if (state.method === 'browser') return scrapeWithBrowser(state, kw.term);
          return [];
        }, state.retries || 0);

        names = [...new Set(names)];

        let matches = 0;
        for (const name of names) {
          if (!isValidMatch(name, kw.term)) continue;

          // Score on normalized base names
          const score = similarity(
            stripSuffixes(name).toLowerCase(),
            kw.term.toLowerCase()
          );

          const inserted = await insertIfNew(`US-${state.code}`, name, kw.term, score);
          if (inserted) { totalFound++; matches++; console.log(`[US-STATES] [${state.code}] MATCH: "${name}"`); }
        }

        report.push({ code: state.code, keyword: kw.term, results: names.length, matches, status: 'ok' });
        console.log(`[US-STATES] [${state.code}] "${kw.term}" → ${names.length} results, ${matches} match(es)`);

      } catch (err) {
        const msg = err.message;
        console.error(`[US-STATES] [${state.code}] Error (${state.method}): ${msg}`);
        errorLog = msg;
        warningMessages.push(`${state.code}: ${msg}`);
        gaps.push(`${state.code.padEnd(3)} ${state.state.padEnd(20)} | ${state.method} error: ${msg}`);
        report.push({ code: state.code, keyword: kw.term, results: 0, matches: 0, status: 'error' });
      }

      await new Promise(r => setTimeout(r, 600));
    }
  }

  if (!selectedCode) {
    unsupported.forEach(s => gaps.push(`${s.code.padEnd(3)} ${s.state.padEnd(20)} | NOT ENABLED: ${s.reason}`));
  }

  fs.writeFileSync(path.join(__dirname, '../data/state-gaps.txt'), gaps.join('\n'), 'utf8');

  console.log('\n[US-STATES] ── FINAL REPORT ─────────────────────────────────────');
  console.log('[US-STATES] State | Keyword     | Results | Matches | Status');
  report.forEach(r =>
    console.log(`[US-STATES] ${r.code.padEnd(5)} | ${r.keyword.padEnd(11)} | ${String(r.results).padEnd(7)} | ${String(r.matches).padEnd(7)} | ${r.status}`)
  );
  console.log(`[US-STATES] ── Total new matches: ${totalFound} ─────────────────────`);

  if (logId) {
    await supabase.from('scan_logs').update({
      completed_at: new Date().toISOString(),
      total_found: totalFound,
      error_log: totalFound === 0 ? errorLog : null,
    }).eq('id', logId);
  }

  if (warningMessages.length) {
    console.warn(`[US-STATES] Completed with non-fatal state warnings: ${warningMessages.join(' | ')}`);
  }

  return totalFound;
}

async function runUSStateScraperReliable(code = null) {
  const selectedCode = code ? String(code).trim().toUpperCase() : null;
  const active = getSupportedStates(selectedCode);
  if (selectedCode && active.length === 0) {
    const knownState = states.find(s => s.code === selectedCode);
    throw new Error(`US-${selectedCode} is not enabled for scraping: ${knownState?.notes || 'Unknown state code'}`);
  }

  const scanType = selectedCode ? `trademark_us_${selectedCode.toLowerCase()}` : 'trademark_us_states';
  if (!selectedCode) {
    const staleBefore = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: staleRows } = await supabase.from('scan_logs')
      .select('id, error_log')
      .eq('scan_type', scanType)
      .is('completed_at', null)
      .lt('started_at', staleBefore);
    for (const row of staleRows || []) {
      await supabase.from('scan_logs').update({
        completed_at: new Date().toISOString(),
        error_log: row.error_log
          ? `${row.error_log} | Abandoned: backend stopped before scan completion`
          : 'Abandoned: backend stopped before scan completion',
      }).eq('id', row.id);
    }
  }

  const { data: logEntry, error: logInsertError } = await supabase
    .from('scan_logs')
    .insert([{ scan_type: scanType, started_at: new Date().toISOString() }])
    .select().single();
  if (logInsertError) throw logInsertError;

  const logId = logEntry?.id;
  const gaps = [];
  const warnings = [];
  const workingStates = new Set();
  const partialStates = new Set();
  const failedStates = new Set();
  let totalFound = 0;
  let fatalError = null;
  let cancelRequested = false;
  // Declared here (not inside try) so the catch block below can still
  // reference and drain it -- Promise.race doesn't cancel the losing
  // promise, so when the run timeout fires, this keeps executing in the
  // background unless we explicitly wait for it to notice cancelRequested.
  let scanAllStates;

  try {
    const { data: keywords, error: keywordError } = await supabase
      .from('keywords').select('term').eq('active', true);
    if (keywordError) throw keywordError;
    if (!keywords?.length) {
      console.log('[US-STATES] No active keywords.');
      return 0;
    }

    console.log(`[US-STATES] Scanning ${active.length} states for ${keywords.length} keyword(s), concurrency=${STATE_CONCURRENCY}, taskTimeout=${STATE_KEYWORD_TIMEOUT_MS}ms`);
    scanAllStates = mapWithConcurrency(active, STATE_CONCURRENCY, async (state) => {
      let successfulChecks = 0;
      let failedChecks = 0;
      for (const kw of keywords) {
        if (cancelRequested) return;
        try {
          const search = withRetry(`[${state.code}] "${kw.term}"`, async () => {
            if (state.method === 'api') return scrapeWithAPI(state, kw.term);
            if (state.method === 'axios') return scrapeWithAxios(state, kw.term);
            if (state.method === 'aspnet') return scrapeWithASPNET(state, kw.term);
            if (state.method === 'browser') return scrapeWithBrowser(state, kw.term);
            return [];
          }, state.retries || 0);
          const names = [...new Set(await withTimeout(
            search,
            STATE_KEYWORD_TIMEOUT_MS,
            `[US-STATES] ${state.code} "${kw.term}"`,
          ))];

          let matches = 0;
          for (const name of names) {
            if (!isValidMatch(name, kw.term)) continue;
            const score = similarity(stripSuffixes(name).toLowerCase(), kw.term.toLowerCase());
            if (await insertIfNew(`US-${state.code}`, name, kw.term, score)) {
              totalFound++;
              matches++;
            }
          }
          successfulChecks++;
          console.log(`[US-STATES] [${state.code}] "${kw.term}" -> ${names.length} results, ${matches} match(es)`);
        } catch (err) {
          failedChecks++;
          const message = `${state.code}/${kw.term}: ${err.message}`;
          warnings.push(message);
          gaps.push(`${state.code.padEnd(3)} ${state.state.padEnd(20)} | ${state.method} error: ${err.message}`);
          console.error(`[US-STATES] ${message}`);
        }
        // Give Render time to actually reclaim the just-closed Chromium
        // process's memory before the next state launches a fresh one —
        // launching back-to-back with reclamation still in flight is what
        // pushes total usage past the free-tier ceiling and gets the whole
        // process OS-killed (not a catchable error, so no log/cleanup runs).
        if (global.gc) global.gc();
        await new Promise(resolve => setTimeout(resolve, state.method === 'browser' ? 1500 : 250));

        // Bail out of remaining states before memory pressure gets the whole
        // process OS-killed. A partial state summary that reaches the report
        // step beats a complete one that never does.
        const memRatio = getContainerMemoryRatio();
        if (memRatio !== null && memRatio > 0.85 && !cancelRequested) {
          cancelRequested = true;
          const msg = `Stopping remaining states early: container memory at ${Math.round(memRatio * 100)}% — finishing up to protect the scan from an uncatchable OOM kill.`;
          warnings.push(msg);
          console.warn(`[US-STATES] ${msg}`);
        }
      }
      if (successfulChecks > 0) workingStates.add(state.code);
      if (successfulChecks > 0 && failedChecks > 0) partialStates.add(state.code);
      if (successfulChecks === 0) failedStates.add(state.code);

      if (logId) {
        const { error: progressError } = await supabase.from('scan_logs').update({
          total_found: totalFound,
          error_log: formatStateSummary(active.length, workingStates, partialStates, failedStates, warnings),
        }).eq('id', logId);
        if (progressError) console.error('[US-STATES] State-summary update failed:', progressError.message);
      }
    });
    await withTimeout(scanAllStates, STATE_RUN_TIMEOUT_MS, '[US-STATES] complete scan');

    if (!selectedCode) {
      getUnsupportedStates().forEach(s => gaps.push(`${s.code.padEnd(3)} ${s.state.padEnd(20)} | NOT ENABLED: ${s.reason}`));
    }
    try {
      fs.writeFileSync(path.join(__dirname, '../data/state-gaps.txt'), gaps.join('\n'), 'utf8');
    } catch (err) {
      warnings.push(`Gap report write failed: ${err.message}`);
    }
    return totalFound;
  } catch (err) {
    cancelRequested = true;
    fatalError = err;

    // Promise.race([scanAllStates, timeout]) rejecting does NOT stop
    // scanAllStates -- it keeps running in the background. The state loop
    // only checks cancelRequested at the top of its next keyword iteration,
    // so whatever state/browser was in flight when the timeout fired can
    // still be alive for up to STATE_KEYWORD_TIMEOUT_MS after we return here.
    // If PDF generation launches its own browser while that's still alive,
    // the combined memory is a plausible cause of the crash seen right after
    // "Scheduled scan complete" in production. Wait (bounded) for it to
    // actually finish before handing control back.
    if (scanAllStates) {
      const before = process.memoryUsage();
      console.warn(`[US-STATES] Run timeout fired with a state task still in flight. rss=${(before.rss / 1048576).toFixed(0)}MB heapUsed=${(before.heapUsed / 1048576).toFixed(0)}MB. Waiting up to 90s for it to settle and close its browser.`);
      try {
        await withTimeout(scanAllStates, 90 * 1000, '[US-STATES] post-timeout drain');
        console.log('[US-STATES] In-flight state task settled cleanly after the run timeout.');
      } catch (drainErr) {
        console.warn(`[US-STATES] In-flight state task did NOT settle within the 90s grace period (${drainErr.message}) -- a Chromium process may still be alive when the caller proceeds.`);
      }
      if (global.gc) global.gc();
      const after = process.memoryUsage();
      console.warn(`[US-STATES] Post-drain memory: rss=${(after.rss / 1048576).toFixed(0)}MB heapUsed=${(after.heapUsed / 1048576).toFixed(0)}MB (delta rss=${((after.rss - before.rss) / 1048576).toFixed(0)}MB).`);
    }

    throw err;
  } finally {
    if (logId) {
      const stateSummary = formatStateSummary(active.length, workingStates, partialStates, failedStates, warnings);
      const errorSummary = fatalError ? `${stateSummary} | Fatal: ${fatalError.message}` : stateSummary;
      const { error: updateError } = await supabase.from('scan_logs').update({
        completed_at: new Date().toISOString(),
        total_found: totalFound,
        error_log: errorSummary,
      }).eq('id', logId);
      if (updateError) console.error('[US-STATES] Scan-log finalization failed:', updateError.message);
    }
    console.log(`[US-STATES] Finished with ${totalFound} new match(es) and ${warnings.length} warning(s).`);
  }
}

module.exports = { runUSStateScraper: runUSStateScraperReliable, getUnsupportedStates };
