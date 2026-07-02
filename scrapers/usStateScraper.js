const axios = require('axios');
const cheerio = require('cheerio');
const levenshtein = require('fast-levenshtein');
const supabase = require('../lib/supabase');
const https = require('https');
const fs = require('fs');
const path = require('path');

const states = require('../config/usStates.json');

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

  try {
    const page = await browser.newPage();
    await page.setUserAgent(BASE_HEADERS['User-Agent']);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Some sites check navigator.webdriver
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.goto(state.url, { waitUntil: 'networkidle2', timeout: 35000 });

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
        await page.waitForSelector(sel, { timeout: 5000 });
        await page.$eval(sel, el => { el.value = ''; el.focus(); });
        await page.type(sel, keyword, { delay: 50 });
        typed = true;
        break;
      } catch (_) {}
    }
    if (!typed) return [];

    // Submit
    if (state.searchSubmit) {
      try { await page.click(state.searchSubmit); }
      catch (_) { await page.keyboard.press('Enter'); }
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));

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
async function runUSStateScraper() {
  console.log('[US-STATES] Starting US state registry scan...');

  const blocked = states.filter(s => !s.accessible);
  const active  = states.filter(s => s.accessible);

  if (blocked.length) {
    console.log(`[US-STATES] Truly blocked (${blocked.length}): ${
      blocked.map(s => `${s.code} (${s.notes})`).join(' | ')
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
    .insert([{ scan_type: 'trademark', started_at: new Date().toISOString() }])
    .select().single();
  const logId = logEntry?.id;

  const { data: keywords } = await supabase
    .from('keywords').select('term').eq('active', true);
  if (!keywords?.length) { console.log('[US-STATES] No active keywords.'); return 0; }

  const gaps = [];
  let totalFound = 0;
  let errorLog   = null;
  const report   = [];

  for (const state of active) {
    for (const kw of keywords) {
      try {
        let names = [];
        if (state.method === 'api')     names = await scrapeWithAPI(state, kw.term);
        if (state.method === 'axios')   names = await scrapeWithAxios(state, kw.term);
        if (state.method === 'aspnet')  names = await scrapeWithASPNET(state, kw.term);
        if (state.method === 'browser') names = await scrapeWithBrowser(state, kw.term);

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
        gaps.push(`${state.code.padEnd(3)} ${state.state.padEnd(20)} | ${state.method} error: ${msg}`);
        report.push({ code: state.code, keyword: kw.term, results: 0, matches: 0, status: 'error' });
      }

      await new Promise(r => setTimeout(r, 600));
    }
  }

  blocked.forEach(s => gaps.push(`${s.code.padEnd(3)} ${s.state.padEnd(20)} | BLOCKED: ${s.notes}`));

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
      error_log: errorLog,
    }).eq('id', logId);
  }

  return totalFound;
}

module.exports = { runUSStateScraper };
