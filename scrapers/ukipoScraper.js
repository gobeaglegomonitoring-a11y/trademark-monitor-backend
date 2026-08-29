// ukipoScraper.js
// STRATEGY: Direct POST to TMview API — request format captured from browser interception.
// Filters to UK office only. No Puppeteer required.

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
    scan_type: "trademark_ukipo",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    total_found: totalFound,
    error_log: errorMsg,
  }]);
}

function normalizeUKHit(tm) {
  const name = tm.tmName || tm.wordMark || tm.name || "";

  let filingDate = tm.applicationDate || tm.filingDate || null;
  if (filingDate && typeof filingDate === "string" && filingDate.includes("T")) {
    filingDate = filingDate.split("T")[0]; // "2015-02-06T12:00:00.000Z" → "2015-02-06"
  }

  const owner = Array.isArray(tm.applicantName)
    ? (tm.applicantName[0] || "")
    : (tm.applicantName || "");

  return { name, filingDate, owner, raw: tm };
}

async function searchUKIPO(keyword) {
  const body = {
    page: "1",
    pageSize: "100",          // was 30 — get more results
    criteria: "C",            // C = Contains
    basicSearch: keyword,
    newPage: true,
    offices: ["GB"],          // ← UK office filter
    fields: [
      "ST13", "markImageURI", "tmName", "tmOffice",
      "applicationNumber", "applicationDate",
      "tradeMarkStatus", "niceClass", "applicantName",
    ],
  };

  const response = await axios.post(
    "https://www.tmdn.org/tmview/api/search/results?translate=true",
    body,
    {
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://www.tmdn.org/tmview/",
        "Origin": "https://www.tmdn.org",
      },
      timeout: 20000,
    }
  );

  const data = response.data;
  const hits = (data && Array.isArray(data.tradeMarks) && data.tradeMarks) || [];

  // Log response shape on first run so we can verify
  console.log(`[UKIPO] "${keyword}" — ${hits.length} result(s) from API`);
  if (hits.length > 0) {
    const offices = [...new Set(hits.map(h => h.tmOffice))];
    console.log(`[UKIPO] Offices in response: ${offices.join(", ")}`);
  } else {
    console.log(`[UKIPO] Response preview: ${JSON.stringify(data).slice(0, 300)}`);
  }

  // Enforce UK filter (in case API ignores the offices param)
  return hits.filter(h => !h.tmOffice || h.tmOffice === "GB");
}

async function isDuplicate(filingName, matchedKeyword) {
  const { data } = await supabase
    .from("trademark_matches")
    .select("id")
    .eq("registry", "UKIPO")
    .eq("filing_name", filingName)
    .eq("matched_keyword", matchedKeyword)
    .limit(1);
  return data && data.length > 0;
}

async function runUKIPOScraper() {
  const { shouldStop, clearStop } = require('../lib/scanControl');
  clearStop('ukipo');
  const startedAt = new Date().toISOString();
  let totalInserted = 0;
  let errorMsg = null;

  console.log("[UKIPO] Scraper started at", startedAt);
  console.log("[UKIPO] Route: TMview direct API — no Puppeteer");

  try {
    const { data: keywords, error: kwError } = await supabase
      .from("keywords")
      .select("*")
      .eq("active", true);

    if (kwError) throw new Error("Failed to fetch keywords: " + kwError.message);
    if (!keywords || keywords.length === 0) {
      console.log("[UKIPO] No active keywords found. Exiting.");
      await logScan(startedAt, 0, "No active keywords");
      return 0;
    }

    console.log(`[UKIPO] Found ${keywords.length} active keyword(s) to scan.`);

    for (const kw of keywords) {
      if (shouldStop('ukipo')) {
        console.log('[UKIPO] Stop requested — ending scan early.');
        errorMsg = 'Stopped by user';
        break;
      }
      try {
        console.log(`[UKIPO] Searching for: "${kw.term}"`);
        const hits = await searchUKIPO(kw.term);

        for (const hit of hits) {
          const { name, filingDate, owner, raw } = normalizeUKHit(hit);
          if (!name) continue;

          const score = getSimilarity(kw.term, name);
          const contained = isContainedMatch(kw.term, name);

          if (score >= 0.8 || contained) {
            const finalScore = score >= 0.8 ? score : 0.75;

            const duplicate = await isDuplicate(name, kw.term);
            if (duplicate) {
              console.log(`[UKIPO] Skipping duplicate: "${name}"`);
              continue;
            }

            await supabase.from("trademark_matches").insert([{
              registry: "UKIPO",
              filing_name: name,
              filing_date: filingDate || null,
              owner_name: owner || null,
              matched_keyword: kw.term,
              similarity_score: finalScore,
              raw_data: raw,
              status: "new",
            }]);

            totalInserted++;
            console.log(`[UKIPO] Inserted: "${name}" (score: ${finalScore.toFixed(2)})`);
          }
        }
      } catch (kwErr) {
        console.error(`[UKIPO] Error scanning keyword "${kw.term}":`, kwErr.message);
        errorMsg = kwErr.message;
      }

      await sleep(DELAY_MS);
    }
  } catch (err) {
    console.error("[UKIPO] Scraper failed:", err.message);
    errorMsg = err.message;
  }

  await logScan(startedAt, totalInserted, errorMsg);
  console.log(`[UKIPO] Scraper finished. Inserted ${totalInserted} new match(es).`);
  return totalInserted;
}

module.exports = { runUKIPOScraper, normalizeUKHit };