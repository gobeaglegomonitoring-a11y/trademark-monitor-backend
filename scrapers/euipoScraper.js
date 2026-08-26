const axios = require("axios");
const levenshtein = require("fast-levenshtein");
const supabase = require("../lib/supabase");

const DELAY_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSimilarity(a, b) {
  const s1 = a.toLowerCase().trim();
  const s2 = b.toLowerCase().trim();
  if (s1 === s2) return 1;
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein.get(s1, s2) / maxLen;
}

function isContainedMatch(keyword, filingName) {
  const k = keyword.toLowerCase().trim();
  const f = filingName.toLowerCase().trim();
  return f.includes(k) || k.includes(f);
}

async function logScan(startedAt, totalFound, errorMsg = null) {
  await supabase.from("scan_logs").insert([{
    scan_type: "trademark_euipo",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    total_found: totalFound,
    error_log: errorMsg,
  }]);
}

// ── Normalize EUIPO hit — handles field name variations across API versions ──
function normalizeEUIPOHit(tm) {
  // COPLA uses lowercase "wordmark"; old eSearch used "wordMarkSpecification"
  const name =
    tm.wordmark ||
    tm.wordMarkSpecification ||
    tm.trademarkName ||
    tm.wordMark ||
    tm.markText ||
    tm.name ||
    (tm.markSpecification &&
      tm.markSpecification.markVerbalElementBag &&
      tm.markSpecification.markVerbalElementBag[0] &&
      tm.markSpecification.markVerbalElementBag[0].markVerbalElementText) ||
    "";

  // COPLA dates are Unix timestamps in milliseconds — convert to ISO string
  let filingDate =
    tm.filingDate || tm.filingdate || tm.applicationDate || tm.registrationDate ||
    tm.publisheddate || null;

  if (filingDate && /^\d{10,13}$/.test(String(filingDate))) {
    filingDate = new Date(Number(filingDate)).toISOString().split("T")[0];
  }

  const owner =
    (tm.trademarkOwnerBag &&
      tm.trademarkOwnerBag[0] &&
      tm.trademarkOwnerBag[0].trademarkOwnerName) ||
    (tm.applicantBag &&
      tm.applicantBag[0] &&
      tm.applicantBag[0].applicantName) ||
    tm.applicantName ||
    "";

  return { name, filingDate, owner, raw: tm };
}
// ── Method 1: EUIPO public REST API (no credentials needed) ─────────────────
// Docs: https://euipo.europa.eu/eSearch/#advanced/trademarks
// API:  GET https://euipo.europa.eu/eSearch/rest/trademarks
async function searchEUIPOviaAPI(keyword) {
  const criteria = JSON.stringify([
    { field: "wordMarkSpecification", value: keyword, type: "CONTAINS" }
  ]);

  const response = await axios.get(
    "https://euipo.europa.eu/eSearch/rest/trademarks",
    {
      params: { criteria, start: 0, rows: 100, language: "en" },
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://euipo.europa.eu/eSearch/",
        "Origin": "https://euipo.europa.eu",
      },
      timeout: 20000,
    }
  );

  const data = response.data;

  // Debug: see the real response shape
  console.log(`[EUIPO] Response keys: ${Object.keys(data || {}).join(", ")}`);
  console.log(`[EUIPO] Response preview: ${JSON.stringify(data).slice(0, 500)}`);

  const hits =
    (data && Array.isArray(data.trademarks) && data.trademarks) ||
    (data && Array.isArray(data.results) && data.results) ||
    (data && Array.isArray(data.data) && data.data) ||
    (Array.isArray(data) && data) ||
    [];

  console.log(`[EUIPO] REST API — "${keyword}" — ${hits.length} result(s)`);
  if (hits.length > 0) {
    console.log(`[EUIPO] Sample keys: ${Object.keys(hits[0]).join(", ")}`);
  }
  return hits;
}

// ── Method 2: Puppeteer fallback — intercept ALL JSON responses ──────────────
// Used only if the REST API call fails (e.g. blocked on this IP).
async function searchEUIPOviaBrowser(browser, keyword) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1280, height: 900 });

  let capturedResults = [];

  // Intercept every JSON response — do NOT filter by URL, the API path can vary
 page.on("response", async (response) => {
  const url = response.url();
  const ct = response.headers()["content-type"] || "";

  // Only look at trademark search results from COPLA
  if (!url.includes("ctmsearch") && !url.includes("tmsearch")) return;
  if (!ct.includes("application/json") && !ct.includes("text/plain")) return;

  try {
    const text = await response.text();
    if (text.length < 10) return;

    let json;
    try { json = JSON.parse(text); } catch { return; }

    const hits =
      (json && Array.isArray(json.items) && json.items) ||      // COPLA uses "items"
      (json && Array.isArray(json.trademarks) && json.trademarks) ||
      (json && Array.isArray(json.results) && json.results) ||
      (json && Array.isArray(json.data) && json.data) ||
      (Array.isArray(json) && json) ||
      [];

    if (hits.length > 0) {
      console.log(`[EUIPO][browser] ✓ ${hits.length} hits from: ${url.split("?")[0]}`);
      console.log(`[EUIPO][browser] Item keys: ${Object.keys(hits[0]).join(", ")}`);
      capturedResults = hits;
    }
  } catch (_) {}
});

  try {
    await page.goto("https://euipo.europa.eu/eSearch/#basic/trademarks", {
  waitUntil: "domcontentloaded", // SPA never reaches networkidle2
  timeout: 45000,
});
await sleep(5000); // give React time to initialize before typing

    const inputSelectors = [
      'input[placeholder*="word" i]',
      'input[placeholder*="mark" i]',
      'input[placeholder*="search" i]',
      'input[type="search"]',
      'input[type="text"]',
      "#wordMarkSpecification",
    ];

    let typed = false;
    for (const sel of inputSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 4000 });
        await page.click(sel);
        await page.evaluate((s) => { document.querySelector(s).value = ""; }, sel);
        await page.type(sel, keyword, { delay: 80 });
        console.log(`[EUIPO][browser] Typed "${keyword}" via: ${sel}`);
        typed = true;
        break;
      } catch (_) {}
    }

    if (!typed) {
      const inputs = await page.evaluate(() =>
        Array.from(document.querySelectorAll("input")).map((i) => ({
          type: i.type, id: i.id, placeholder: i.placeholder,
        }))
      );
      console.log("[EUIPO][browser] Available inputs:", JSON.stringify(inputs));
    }

    await page.keyboard.press("Enter");
    await sleep(10000); // wait for SPA to make API call and render

    // If still nothing, try clicking a visible Search button
    if (capturedResults.length === 0) {
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button, [role='button']"))
          .find((b) => /^search$/i.test(b.textContent.trim()));
        if (btn) btn.click();
      });
      await sleep(6000);
    }

    console.log(`[EUIPO][browser] "${keyword}" — ${capturedResults.length} result(s) intercepted`);
    return capturedResults;
  } finally {
    await page.close();
  }
}

// ── Dedup check ──────────────────────────────────────────────────────────────
async function isDuplicate(filingName, matchedKeyword) {
  const { data } = await supabase
    .from("trademark_matches")
    .select("id")
    .eq("registry", "EUIPO")
    .eq("filing_name", filingName)
    .eq("matched_keyword", matchedKeyword)
    .limit(1);
  return data && data.length > 0;
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function runEUIPOScraper() {
  const { shouldStop, clearStop } = require('../lib/scanControl');
  clearStop('euipo');
  const startedAt = new Date().toISOString();
  let totalInserted = 0;
  let errorMsg = null;
  let browser = null;
  let useBrowser = true; // REST API URL is wrong — go straight to Puppeteer

  console.log("[EUIPO] Scraper started at", startedAt);

  try {
    const { data: keywords, error: kwError } = await supabase
      .from("keywords")
      .select("*")
      .eq("active", true);

    if (kwError) throw new Error("Failed to fetch keywords: " + kwError.message);
    if (!keywords || keywords.length === 0) {
      console.log("[EUIPO] No active keywords found. Exiting.");
      await logScan(startedAt, 0, "No active keywords");
      return 0;
    }

    console.log(`[EUIPO] Found ${keywords.length} active keyword(s) to scan.`);

    for (const kw of keywords) {
      if (shouldStop('euipo')) {
        console.log('[EUIPO] Stop requested — ending scan early.');
        errorMsg = 'Stopped by user';
        break;
      }
      try {
        console.log(`[EUIPO] Searching for: "${kw.term}"`);

        let hits = [];

        if (!useBrowser) {
          try {
            hits = await searchEUIPOviaAPI(kw.term);
          } catch (apiErr) {
            console.warn(`[EUIPO] REST API failed (${apiErr.message}) — switching to Puppeteer`);
            useBrowser = true;
          }
        }

        if (useBrowser) {
          if (!browser) {
            const { launchBrowser } = require('../lib/browser');
            browser = await launchBrowser();
          }
          hits = await searchEUIPOviaBrowser(browser, kw.term);
        }

        for (const hit of hits) {
          const { name, filingDate, owner, raw } = normalizeEUIPOHit(hit);
          if (!name) continue;

          const score = getSimilarity(kw.term, name);
          const contained = isContainedMatch(kw.term, name);

          if (score >= 0.8 || contained) {
            const finalScore = score >= 0.8 ? score : 0.75;

            const duplicate = await isDuplicate(name, kw.term);
            if (duplicate) {
              console.log(`[EUIPO] Skipping duplicate: "${name}"`);
              continue;
            }

            await supabase.from("trademark_matches").insert([{
              registry: "EUIPO",
              filing_name: name,
              filing_date: filingDate || null,
              matched_keyword: kw.term,
              similarity_score: finalScore,
              raw_data: raw,
              status: "new",
            }]);

            totalInserted++;
            console.log(`[EUIPO] Inserted: "${name}" (score: ${finalScore.toFixed(2)})`);
          }
        }
      } catch (kwErr) {
        console.error(`[EUIPO] Error scanning keyword "${kw.term}":`, kwErr.message);
        errorMsg = kwErr.message;
      }

      await sleep(DELAY_MS);
    }
  } catch (err) {
    console.error("[EUIPO] Scraper failed:", err.message);
    errorMsg = err.message;
  } finally {
    if (browser) await browser.close();
  }

  await logScan(startedAt, totalInserted, errorMsg);
  console.log(`[EUIPO] Scraper finished. Inserted ${totalInserted} new match(es).`);
  return totalInserted;
}

module.exports = { runEUIPOScraper };