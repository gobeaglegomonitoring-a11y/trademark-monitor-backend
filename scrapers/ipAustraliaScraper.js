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

async function searchIPAustralia(browser, keyword) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

  try {
    // Navigate to search page and type keyword
    await page.goto('https://search.ipaustralia.gov.au/trademarks/search/quick', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await sleep(1500);

    // Type in search box and submit
    await page.waitForSelector('input[placeholder*="trade" i], input[type="search"], input[name="sq_1"]', { timeout: 8000 });
    const inputSel = 'input[placeholder*="trade" i], input[type="search"], input[name="sq_1"]';
    await page.click(inputSel);
    await page.evaluate((s) => { document.querySelector(s).value = ''; }, inputSel);
    await page.type(inputSel, keyword, { delay: 60 });
    console.log(`[IP-AU] Typed "${keyword}"`);

    // The IP Australia search is an Angular SPA. Depending on the deployment,
    // pressing Enter either performs a real navigation or updates the current
    // page in place. A navigation timeout must therefore not fail the scan.
    const navigation = page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 })
      .catch(() => null);
    await page.keyboard.press('Enter');
    await navigation;

    // Wait for Angular to render results before extracting
    const resultReady = await Promise.race([
      page.waitForSelector(
        'tbody tr, [class*="result"], [class*="search-result"], .no-results, [class*="noResult"]',
        { timeout: 12000 }
      ).then(() => true).catch(() => false),
      sleep(12000).then(() => false),
    ]);
    if (!resultReady) {
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }).catch(() => {});
    }
    await sleep(2000);

    // Extract trademark names from the HTML results table
    const trademarks = await page.evaluate(() => {
      const results = [];

      // IP Australia results page: trademark name is usually in a specific cell
      // Try: cells with data-label attribute (responsive tables)
      document.querySelectorAll('[data-label="Trade mark"], [data-label="Trade Mark Words"], td.word-mark, td.trademark').forEach(el => {
        const text = el.textContent.trim();
        if (text) results.push({ name: text, filingDate: null, owner: '' });
      });

      if (results.length === 0) {
        // Try: links that point to trademark detail pages
        document.querySelectorAll('a[href*="/trademarks/search/view"]').forEach(link => {
          const text = link.textContent.trim();
          const row = link.closest('tr');
          let filingDate = null;
          let owner = '';
          if (row) {
            const cells = row.querySelectorAll('td');
            // Typical columns: App No | Status | Trade mark | Class | Owner | Date
            if (cells[5]) filingDate = cells[5].textContent.trim();
            if (cells[4]) owner = cells[4].textContent.trim();
          }
          if (text && text.length < 200) results.push({ name: text, filingDate, owner });
        });
      }

      if (results.length === 0) {
        // Broad fallback: all table rows
        document.querySelectorAll('table tbody tr').forEach(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 3) {
            const name = cells[2].textContent.trim();
            const filingDate = cells[5] ? cells[5].textContent.trim() : null;
            const owner = cells[4] ? cells[4].textContent.trim() : '';
            if (name) results.push({ name, filingDate, owner });
          }
        });
      }

      return results;
    });

    console.log(`[IP-AU] "${keyword}" — ${trademarks.length} result(s) extracted from HTML`);

    // Debug: log first result to confirm field extraction
    if (trademarks.length > 0) {
      console.log(`[IP-AU] Sample: ${JSON.stringify(trademarks[0])}`);
    } else {
      const pageText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 800));
      const isNoResults = /no results|no trade marks|0 results|no matching/i.test(pageText);
      if (isNoResults) {
        console.log(`[IP-AU] "${keyword}" — confirmed no results on IP Australia`);
      } else {
        console.log(`[IP-AU] Page text dump (first 800): ${pageText}`);
      }
    }

    return trademarks;

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
    .eq('registry', 'IP Australia')
    .limit(1);
  return data && data.length > 0;
}

async function runIPAustraliaScraper() {
  const { shouldStop, clearStop } = require('../lib/scanControl');
  clearStop('ipau');
  console.log('[IP-AU] Starting scraper...');

  const { data: logEntry } = await supabase
    .from('scan_logs')
    .insert([{ scan_type: 'trademark_ipau', started_at: new Date().toISOString() }])
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
      console.log('[IP-AU] No active keywords found.');
      return 0;
    }

    console.log(`[IP-AU] Scanning ${keywords.length} keyword(s)...`);

    const { launchBrowser } = require('../lib/browser');
    const browser = await launchBrowser();

    for (const kw of keywords) {
      if (shouldStop('ipau')) {
        console.log('[IP-AU] Stop requested — ending scan early.');
        errorLog = 'Stopped by user';
        break;
      }
      try {
        console.log(`[IP-AU] Searching: "${kw.term}"`);
        const hits = await searchIPAustralia(browser, kw.term);

        for (const hit of hits) {
          const filingName = hit.name || '';
          if (!filingName) continue;

          const score = getSimilarity(kw.term, filingName);
          if (score < 0.8) continue;

          const duplicate = await isDuplicate(filingName, kw.term);
          if (duplicate) continue;

          await supabase.from('trademark_matches').insert([{
            registry: 'IP Australia',
            filing_name: filingName,
            filing_date: hit.filingDate || null,
            matched_keyword: kw.term,
            similarity_score: score,
            raw_data: hit,
            status: 'new'
          }]);

          totalFound++;
          console.log(`[IP-AU] Match: "${filingName}" (score: ${score.toFixed(2)})`);
        }
      } catch (kwErr) {
        console.error(`[IP-AU] Error scanning "${kw.term}":`, kwErr.message);
        errorLog = kwErr.message;
      }

      await sleep(DELAY_MS);
    }

    await browser.close();
  } catch (err) {
    console.error('[IP-AU] Fatal error:', err.message);
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

  console.log(`[IP-AU] Done. ${totalFound} new match(es) found.`);
  return totalFound;
}

module.exports = { runIPAustraliaScraper };
