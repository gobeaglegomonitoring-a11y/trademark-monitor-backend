const axios = require("axios");
const levenshtein = require("fast-levenshtein");
const supabase = require("../lib/supabase");

// ── Helper: similarity score between 0 and 1 ────────────────────────────────
function getSimilarity(a, b) {
  const s1 = a.toLowerCase().trim();
  const s2 = b.toLowerCase().trim();
  if (s1 === s2) return 1;
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1;
  const distance = levenshtein.get(s1, s2);
  return 1 - distance / maxLen;
}

// ── Helper: check if keyword is contained inside filing name ─────────────────
function isContainedMatch(keyword, filingName) {
  const k = keyword.toLowerCase().trim();
  const f = filingName.toLowerCase().trim();
  return f.includes(k) || k.includes(f);
}

// ── Helper: 2 second delay ───────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Helper: log scan to scan_logs ────────────────────────────────────────────
async function logScan(startedAt, totalFound, errorMsg = null) {
  await supabase.from("scan_logs").insert([
    {
      scan_type: "trademark_cipo",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      total_found: totalFound,
      error_log: errorMsg,
    },
  ]);
}

// ── Search CIPO Canada ───────────────────────────────────────────────────────
// STATUS: PERMANENTLY BLOCKED — opic.ic.gc.ca is geo-blocked from Pakistan.
// Returns connection refused / timeout for all non-Canadian IPs.
// FLAGGED TO KABIR — needs a Canadian proxy/VPN on the Render server to resolve.
// Live URL (accessible from Canada only): https://opic.ic.gc.ca/app/opic-cipo/trdmrks/srch/home
async function searchCIPO(keyword) {
  const axios = require("axios");
  
  const response = await axios.post(
    "https://www.tmdn.org/tmview/api/search/results?translate=true",
    {
      page: "1",
      pageSize: "100",
      criteria: "C",
      basicSearch: keyword,
      newPage: true,
      offices: ["CA"],
      fields: ["ST13","tmName","tmOffice","applicationNumber","applicationDate","tradeMarkStatus","niceClass","applicantName"],
    },
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

  const hits = (response.data && Array.isArray(response.data.tradeMarks) && response.data.tradeMarks) || [];
  const caHits = hits.filter(h => h.tmOffice === "CA");
  
  console.log(`[CIPO] "${keyword}" — ${caHits.length} CA results of ${hits.length} total`);
  if (hits.length > 0 && caHits.length === 0) {
    console.log(`[CIPO] Offices in response: ${[...new Set(hits.map(h => h.tmOffice))].join(", ")}`);
  }

  return caHits.map(tm => ({
    name: tm.tmName || "",
    filingDate: tm.applicationDate ? tm.applicationDate.split("T")[0] : null,
    owner: Array.isArray(tm.applicantName) ? (tm.applicantName[0] || "") : (tm.applicantName || ""),
  }));
}

// ── Dedup check ──────────────────────────────────────────────────────────────
async function isDuplicate(filingName, matchedKeyword) {
  const { data } = await supabase
    .from("trademark_matches")
    .select("id")
    .eq("registry", "CIPO")
    .eq("filing_name", filingName)
    .eq("matched_keyword", matchedKeyword)
    .limit(1);
  return data && data.length > 0;
}

// ── Insert match ─────────────────────────────────────────────────────────────
async function insertMatch(filing, keyword, score) {
  await supabase.from("trademark_matches").insert([
    {
      registry:         "CIPO",
      filing_name:      filing.name,
      filing_date:      filing.filingDate || null,
      matched_keyword:  keyword,
      similarity_score: score,
      raw_data:         filing,
      status:           "new",
    },
  ]);
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function runCIPOScraper() {
  const startedAt = new Date().toISOString();
  let totalInserted = 0;
  let errorMsg = null;

  console.log("[CIPO] Scraper started at", startedAt);

  try {
    const { data: keywords, error: kwError } = await supabase
      .from("keywords")
      .select("*")
      .eq("active", true);

    if (kwError) throw new Error("Failed to fetch keywords: " + kwError.message);
    if (!keywords || keywords.length === 0) {
      console.log("[CIPO] No active keywords found. Exiting.");
      await logScan(startedAt, 0, "No active keywords");
      return 0;
    }

    console.log(`[CIPO] Found ${keywords.length} active keyword(s) to scan.`);

    for (const kw of keywords) {
      console.log(`[CIPO] Searching for: "${kw.term}"`);

      try {
        const results = await searchCIPO(kw.term);
        console.log(`[CIPO] Got ${results.length} result(s) for "${kw.term}"`);

        for (const filing of results) {
          const filingName = filing.name || "";
          if (!filingName) continue;

          const score = getSimilarity(kw.term, filingName);
          const contained = isContainedMatch(kw.term, filingName);

          if (score >= 0.8 || contained) {
            const finalScore = score >= 0.8 ? score : 0.75;
            console.log(`[CIPO] Match found: "${filingName}" (score: ${finalScore.toFixed(2)})`);

            const duplicate = await isDuplicate(filingName, kw.term);
            if (duplicate) {
              console.log(`[CIPO] Skipping duplicate: "${filingName}"`);
              continue;
            }

            await insertMatch(filing, kw.term, finalScore);
            totalInserted++;
            console.log(`[CIPO] Inserted: "${filingName}"`);
          }
        }
      } catch (kwErr) {
        console.error(`[CIPO] Error scanning keyword "${kw.term}":`, kwErr.message);
        errorMsg = kwErr.message;
      }

      await sleep(2000);
    }
  } catch (err) {
    console.error("[CIPO] Scraper failed:", err.message);
    errorMsg = err.message;
  }

  await logScan(startedAt, totalInserted, errorMsg);
  console.log(`[CIPO] Scraper finished. Inserted ${totalInserted} new match(es).`);
  return totalInserted;
}

module.exports = { runCIPOScraper };