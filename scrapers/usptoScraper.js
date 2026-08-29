const levenshtein = require('fast-levenshtein');
const supabase = require('../lib/supabase');

const DELAY_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSimilarity(a, b) {
  const s1 = a.toLowerCase().trim();
  const s2 = b.toLowerCase().trim();
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein.get(s1, s2) / maxLen;
}

// USPTO response: { index, type, id, score, source: { ... } }
// ownerName/applicantName come back as arrays (e.g. ["Starbucks Corporation
// (CORPORATION; WASHINGTON, USA)"]), not plain strings -- unwrap before use.
function firstOrValue(value) {
  return Array.isArray(value) ? (value[0] || '') : (value || '');
}

// ownerFullText is a HISTORY of owner entries, e.g. one "(REGISTRANT) ..."
// entry (who originally filed) and a later "(LAST LISTED OWNER) ..." entry
// (who holds it now, after any assignment) -- prefer the current owner over
// the original filer since that's who to actually pursue.
function currentOwnerFullText(value) {
  if (!Array.isArray(value) || !value.length) return firstOrValue(value);
  return value.find(s => /LAST LISTED OWNER/i.test(s)) || value[value.length - 1];
}

function normalizeHit(hit) {
  const src = hit.source || hit._source || hit;
  return {
    filingName: src.wordmark || src.wordMark || src.markLiteralElements || src.markName || src.markText ||
                (Array.isArray(src.markDescription) && src.markDescription[0]) || src.mark || src.name || '',
    filingDate: src.filedDate || src.filingDate || src.applicationDate || src.registrationDate || null,
    // ownerFullText includes the registered mailing address (e.g. "Starbucks
    // Corporation (CORPORATION; WASHINGTON, USA) DBA Starbucks Coffee
    // Company; 2203 Airport Way South, ... Seattle, WASHINGTON 981241067,
    // UNITED STATES") -- prefer it over the bare name so the report has an
    // address to act on, not just who to search for.
    owner: currentOwnerFullText(src.ownerFullText) || firstOrValue(src.ownerName) || firstOrValue(src.applicantName) ||
           (src.owners && src.owners[0] && src.owners[0].name) || '',
    raw: hit
  };
}

async function searchUSPTO(browser, keyword) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

  let capturedResults = [];
  let elasticBaseUrl = null;

  page.on('response', async (response) => {
    const url = response.url();
    try {
      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('application/json')) return;

      const json = await response.json();

      // Grab the Elasticsearch API base URL from config
      if (url.includes('configuration.json') && json.serviceUrlSearchElastic) {
        elasticBaseUrl = json.serviceUrlSearchElastic;
        console.log(`[USPTO] Search API: ${elasticBaseUrl}`);
      }

      // Try all known response structures (ES hits.hits, flat array, Solr, etc.)
      const hits =
        (json && json.hits && json.hits.hits) ||
        (json && json.hits) ||
        (json && json.response && json.response.docs) ||
        (json && json.trademarks) ||
        (json && json.results) ||
        (json && json.data) ||
        [];

      if (Array.isArray(hits) && hits.length > 0) {
        console.log(`[USPTO] ${hits.length} result(s) from: ${url.split('?')[0]}`);
        capturedResults = hits;
      }
    } catch (_) {}
  });

  try {
    // Load homepage first so React app + WAF cookies initialize properly
    await page.goto('https://tmsearch.uspto.gov/', { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    // Try multiple selectors to find the search input
    const inputSelectors = [
      'input[type="search"]',
      'input[aria-label*="search" i]',
      'input[placeholder*="mark" i]',
      'input[placeholder*="word" i]',
      'input[placeholder*="search" i]',
      'form input[type="text"]',
      'input[name*="search" i]'
    ];

    let inputFound = false;
    for (const sel of inputSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 3000 });
        await page.click(sel);
        // Clear existing value first
        await page.evaluate((s) => { document.querySelector(s).value = ''; }, sel);
        await page.type(sel, keyword, { delay: 80 });
        await page.keyboard.press('Enter');
        console.log(`[USPTO] Typed "${keyword}" via selector: ${sel}`);
        inputFound = true;
        break;
      } catch (_) {}
    }

    if (!inputFound) {
      // Log available inputs for future debugging
      const inputs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input')).map(i => ({
          type: i.type, placeholder: i.placeholder, id: i.id, name: i.name,
          class: i.className.slice(0, 60)
        }))
      );
      console.log('[USPTO] Input elements on page:', JSON.stringify(inputs));

      // Try clicking a visible button labeled "Search"
      const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const searchBtn = btns.find(b => b.textContent.trim().toLowerCase() === 'search');
        if (searchBtn) { searchBtn.click(); return true; }
        return false;
      });
      console.log(`[USPTO] Search button click: ${clicked}`);
    }

    // Wait for search API to respond
    await sleep(10000);

    // Fallback: if no results yet, call the elastic API directly from browser context
    // (page already has WAF cookies so the request won't be blocked)
    if (capturedResults.length === 0 && elasticBaseUrl) {
      console.log(`[USPTO] Trying direct elastic API call...`);
      try {
        const searchUrl = `${elasticBaseUrl}?searchInput=${encodeURIComponent(keyword)}&searchType=basicSearch`;
        const apiResult = await page.evaluate(async (url) => {
          const resp = await fetch(url, { credentials: 'include' });
          const text = await resp.text();
          console.log('Direct API status:', resp.status);
          try { return JSON.parse(text); } catch { return { _error: text.slice(0, 300) }; }
        }, searchUrl);

        console.log(`[USPTO] Direct API response keys: ${Object.keys(apiResult || {}).join(', ')}`);
        if (apiResult && apiResult._error) {
          console.log(`[USPTO] Direct API error body: ${apiResult._error}`);
        }

        const hits =
          (apiResult && apiResult.hits && apiResult.hits.hits) ||
          (apiResult && apiResult.hits) ||
          (apiResult && apiResult.results) ||
          [];
        if (Array.isArray(hits) && hits.length > 0) {
          capturedResults = hits;
          console.log(`[USPTO] Direct API got ${hits.length} result(s)`);
        }
      } catch (err) {
        console.log(`[USPTO] Direct API call failed: ${err.message}`);
      }
    }

    console.log(`[USPTO] "${keyword}" — ${capturedResults.length} result(s) intercepted`);
    return capturedResults;

  } finally {
    await page.close();
  }
}

async function isDuplicate(filingName, keyword) {
  const { data } = await supabase
    .from('trademark_matches')
    .select('id')
    .eq('filing_name', filingName)
    .eq('matched_keyword', keyword)
    .eq('registry', 'USPTO')
    .limit(1);
  return data && data.length > 0;
}

async function runUSPTOScraper() {
  const { shouldStop, clearStop } = require('../lib/scanControl');
  clearStop('uspto');
  console.log('[USPTO] Starting scraper...');

  const { data: logEntry } = await supabase
    .from('scan_logs')
    .insert([{ scan_type: 'trademark', started_at: new Date().toISOString() }])
    .select()
    .single();

  const logId = logEntry?.id;
  let totalFound = 0;
  let errorLog = null;

  try {
    const { data: keywords, error: kwError } = await supabase
      .from('keywords')
      .select('*')
      .eq('active', true);

    if (kwError) throw kwError;
    if (!keywords || keywords.length === 0) {
      console.log('[USPTO] No active keywords found.');
      return 0;
    }

    console.log(`[USPTO] Scanning ${keywords.length} keyword(s)...`);

    const { launchBrowser } = require('../lib/browser');
    const browser = await launchBrowser();

    for (const kw of keywords) {
      if (shouldStop('uspto')) {
        console.log('[USPTO] Stop requested — ending scan early.');
        errorLog = 'Stopped by user';
        break;
      }
      try {
        console.log(`[USPTO] Searching: "${kw.term}"`);
        const hits = await searchUSPTO(browser, kw.term);

        // Log first hit structure once so we can see the real field names
        if (hits.length > 0) {
          const sample = hits[0]._source || hits[0];
          console.log(`[USPTO] Sample hit keys: ${Object.keys(sample).join(', ')}`);
          console.log(`[USPTO] Sample hit (first 1000 chars): ${JSON.stringify(sample).slice(0, 1000)}`);
        }

        for (const hit of hits) {
          const { filingName, filingDate, owner, raw } = normalizeHit(hit);
          if (!filingName) continue;

          const score = getSimilarity(kw.term, filingName);
          if (score < 0.8) continue;

          const duplicate = await isDuplicate(filingName, kw.term);
          if (duplicate) continue;

          await supabase.from('trademark_matches').insert([{
            registry: 'USPTO',
            filing_name: filingName,
            filing_date: filingDate,
            owner_name: owner || null,
            matched_keyword: kw.term,
            similarity_score: score,
            raw_data: raw,
            status: 'new'
          }]);

          totalFound++;
          console.log(`[USPTO] Match: "${filingName}" (score: ${score.toFixed(2)})`);
        }
      } catch (kwErr) {
        console.error(`[USPTO] Error scanning "${kw.term}":`, kwErr.message);
        errorLog = kwErr.message;
      }

      await sleep(DELAY_MS);
    }

    await browser.close();
  } catch (err) {
    console.error('[USPTO] Fatal error:', err.message);
    errorLog = err.message;
  }

  if (logId) {
    await supabase
      .from('scan_logs')
      .update({
        completed_at: new Date().toISOString(),
        total_found: totalFound,
        error_log: errorLog
      })
      .eq('id', logId);
  }

  console.log(`[USPTO] Done. ${totalFound} new match(es) found.`);
  return totalFound;
}

module.exports = { runUSPTOScraper, normalizeHit };
