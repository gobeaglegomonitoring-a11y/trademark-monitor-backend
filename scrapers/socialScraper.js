const axios = require("axios");
const cheerio = require("cheerio");
const UserAgent = require("user-agents");
const supabase = require("../lib/supabase");

// ── Helper: random delay between min/max ms ──────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function randomDelay(minMs, maxMs) {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

// ── Helper: get a random realistic desktop user agent ────────────────────────
function getRandomUserAgent() {
  const ua = new UserAgent({ deviceCategory: "desktop" });
  return ua.toString();
}

// ── Helper: build realistic browser-like headers ─────────────────────────────
function getBrowserHeaders(referer) {
  return {
    "User-Agent": getRandomUserAgent(),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": referer ? "same-origin" : "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
    ...(referer ? { Referer: referer } : {}),
  };
}

// ── Helper: log scan to scan_logs ────────────────────────────────────────────
async function logScan(scanType, startedAt, totalFound, errorMsg = null) {
  await supabase.from("scan_logs").insert([
    {
      scan_type: scanType,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      total_found: totalFound,
      error_log: errorMsg,
    },
  ]);
}

// ── Helper: single attempt with given headers, returns result or throws ──────
async function attemptRequest(url, headers, attemptLabel) {
  const response = await axios.get(url, {
    headers,
    timeout: 10000,
    validateStatus: () => true,
    maxRedirects: 5,
  });
  console.log(`  [attempt ${attemptLabel}] HTTP ${response.status}, ${typeof response.data === "string" ? response.data.length : 0} bytes`);
  return response;
}

// ── Helper: pull a usable snippet out of whatever HTML we got back ───────────
// Best-effort only — Instagram/TikTok pages are heavily JS-rendered, so this
// grabs whatever static meta content is present rather than trying to
// reverse-engineer their client-side app state.
function extractSnippet(html) {
  try {
    const $ = cheerio.load(html);
    const ogTitle = $('meta[property="og:title"]').attr("content");
    const ogDesc = $('meta[property="og:description"]').attr("content");
    const title = $("title").first().text();
    return (ogDesc || ogTitle || title || "").trim().slice(0, 300) || null;
  } catch {
    return null;
  }
}

// ── Instagram: bounded attempts with rotation, warm-up request, short delays ─
// Capped at 2 attempts (~20s worst case) — this is a daily cron job, not a
// standalone 2-hour task. The "2 hour" budget in the SOP was a dev-time cap
// on building this feature, not a runtime loop to ship in production.
async function searchInstagramWithRetries(keyword, maxAttempts = 2) {
  const baseUrl = `https://www.instagram.com/explore/tags/${encodeURIComponent(keyword)}/`;

  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const headers = getBrowserHeaders();

      if (i > 1) {
        try {
          await attemptRequest("https://www.instagram.com/", headers, `${i}-warmup`);
          await randomDelay(800, 1500);
        } catch (warmupErr) {
          console.log(`  [attempt ${i}-warmup] failed: ${warmupErr.message}`);
        }
      }

      const response = await attemptRequest(baseUrl, getBrowserHeaders("https://www.instagram.com/"), i);

      const bodyStr = typeof response.data === "string" ? response.data : "";
      const isLoginWall = bodyStr.includes("Login") || bodyStr.includes("loginForm") || bodyStr.includes("login_and_signup");

      if (response.status === 200 && !isLoginWall && bodyStr.length > 0) {
        console.log(`  [Instagram] Attempt ${i} succeeded — got real content.`);
        return { blocked: false, url: baseUrl, snippet: extractSnippet(bodyStr), rawLength: bodyStr.length };
      }

      console.log(`  [Instagram] Attempt ${i} blocked (status ${response.status}, loginWall: ${isLoginWall}).`);
    } catch (err) {
      console.log(`  [Instagram] Attempt ${i} threw: ${err.code || err.message}`);
    }

    if (i < maxAttempts) await randomDelay(1500, 3000);
  }

  return { blocked: true };
}

// ── TikTok: bounded attempts with rotation, warm-up request, short delays ────
async function searchTikTokWithRetries(keyword, maxAttempts = 2) {
  const baseUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`;

  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const headers = getBrowserHeaders();

      if (i > 1) {
        try {
          await attemptRequest("https://www.tiktok.com/", headers, `${i}-warmup`);
          await randomDelay(800, 1500);
        } catch (warmupErr) {
          console.log(`  [attempt ${i}-warmup] failed: ${warmupErr.message}`);
        }
      }

      const response = await attemptRequest(baseUrl, getBrowserHeaders("https://www.tiktok.com/"), i);

      const bodyStr = typeof response.data === "string" ? response.data : "";
      const isVerifyWall = bodyStr.toLowerCase().includes("verify") || bodyStr.toLowerCase().includes("captcha");
      const looksEmpty = bodyStr.length < 5000;

      if (response.status === 200 && !isVerifyWall && !looksEmpty) {
        console.log(`  [TikTok] Attempt ${i} succeeded — got real content.`);
        return { blocked: false, url: baseUrl, snippet: extractSnippet(bodyStr), rawLength: bodyStr.length };
      }

      console.log(`  [TikTok] Attempt ${i} blocked (status ${response.status}, verifyWall: ${isVerifyWall}, tooSmall: ${looksEmpty}).`);
    } catch (err) {
      console.log(`  [TikTok] Attempt ${i} threw: ${err.code || err.message}`);
    }

    if (i < maxAttempts) await randomDelay(1500, 3000);
  }

  return { blocked: true };
}

// ── Dedup check ──────────────────────────────────────────────────────────────
async function isDuplicate(platform, handleOrUrl, keyword) {
  const { data } = await supabase
    .from("social_matches")
    .select("id")
    .eq("platform", platform)
    .eq("handle_or_url", handleOrUrl)
    .eq("keyword_matched", keyword)
    .limit(1);
  return data && data.length > 0;
}

// ── Insert match ─────────────────────────────────────────────────────────────
async function insertMatch(platform, handleOrUrl, keyword, snippet) {
  await supabase.from("social_matches").insert([
    {
      platform:         platform,
      handle_or_url:    handleOrUrl,
      keyword_matched:  keyword,
      content_snippet:  snippet || null,
      status:           "new",
    },
  ]);
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
// Best-effort, bounded scraper. Each keyword gets a small, fixed number of
// attempts per platform (~20-30s worst case) instead of an open-ended 2-hour
// budget, so this stays safe to run inside the daily cron job.
async function runSocialScraper() {
  const startedAt = new Date().toISOString();
  let totalInserted = 0;
  let errorMsg = null;

  console.log("[Social] Scraper started at", startedAt);

  try {
    const { data: keywords, error: kwError } = await supabase
      .from("keywords")
      .select("*")
      .eq("active", true);

    if (kwError) throw new Error("Failed to fetch keywords: " + kwError.message);
    if (!keywords || keywords.length === 0) {
      console.log("[Social] No active keywords found. Exiting.");
      await logScan("social_media", startedAt, 0, "No active keywords");
      return 0;
    }

    console.log(`[Social] Found ${keywords.length} active keyword(s) to scan.`);

    for (const kw of keywords) {
      console.log(`\n[Social] === Searching for: "${kw.term}" ===`);

      // ── Instagram ──────────────────────────────────────────────────────────
      const ig = await searchInstagramWithRetries(kw.term);

      if (ig.blocked) {
        await logScan("social_instagram", startedAt, 0, "Blocked by platform (after multi-attempt retry with UA rotation)");
        console.log(`[Instagram] "${kw.term}" — blocked after all attempts, logged to scan_logs.`);
      } else {
        const dupe = await isDuplicate("Instagram", ig.url, kw.term);
        if (!dupe) {
          await insertMatch("Instagram", ig.url, kw.term, ig.snippet);
          totalInserted++;
          console.log(`[Instagram] "${kw.term}" — inserted new match.`);
        } else {
          console.log(`[Instagram] "${kw.term}" — got through, but already logged (dedup skip).`);
        }
        await logScan("social_instagram", startedAt, dupe ? 0 : 1, null);
      }

      await randomDelay(1000, 2000);

      // ── TikTok ─────────────────────────────────────────────────────────────
      const tt = await searchTikTokWithRetries(kw.term);

      if (tt.blocked) {
        await logScan("social_tiktok", startedAt, 0, "Blocked by platform (after multi-attempt retry with UA rotation)");
        console.log(`[TikTok] "${kw.term}" — blocked after all attempts, logged to scan_logs.`);
      } else {
        const dupe = await isDuplicate("TikTok", tt.url, kw.term);
        if (!dupe) {
          await insertMatch("TikTok", tt.url, kw.term, tt.snippet);
          totalInserted++;
          console.log(`[TikTok] "${kw.term}" — inserted new match.`);
        } else {
          console.log(`[TikTok] "${kw.term}" — got through, but already logged (dedup skip).`);
        }
        await logScan("social_tiktok", startedAt, dupe ? 0 : 1, null);
      }

      await randomDelay(1000, 2000);
    }
  } catch (err) {
    console.error("[Social] Scraper failed:", err.message);
    errorMsg = err.message;
  }

  await logScan("social_media", startedAt, totalInserted, errorMsg);
  console.log(`[Social] Scraper finished. Inserted ${totalInserted} new match(es).`);
  return totalInserted;
}

module.exports = { runSocialScraper };