const axios = require("axios");
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
    timeout: 15000,
    validateStatus: () => true,
    maxRedirects: 5,
  });
  console.log(`  [attempt ${attemptLabel}] HTTP ${response.status}, ${typeof response.data === "string" ? response.data.length : 0} bytes`);
  return response;
}

// ── Instagram: multiple attempts with rotation, warm-up request, delays ──────
async function searchInstagramWithRetries(keyword, maxAttempts = 4) {
  const baseUrl = `https://www.instagram.com/explore/tags/${encodeURIComponent(keyword)}/`;

  for (let i = 1; i <= maxAttempts; i++) {
    try {
      // Warm-up: hit the homepage first to look more like a real browsing session,
      // then follow with the actual hashtag page using the same "session" headers.
      const headers = getBrowserHeaders();

      if (i > 1) {
        try {
          await attemptRequest("https://www.instagram.com/", headers, `${i}-warmup`);
          await randomDelay(1500, 3500);
        } catch (warmupErr) {
          console.log(`  [attempt ${i}-warmup] failed: ${warmupErr.message}`);
        }
      }

      const response = await attemptRequest(baseUrl, getBrowserHeaders("https://www.instagram.com/"), i);

      const bodyStr = typeof response.data === "string" ? response.data : "";
      const isLoginWall = bodyStr.includes("Login") || bodyStr.includes("loginForm") || bodyStr.includes("login_and_signup");

      if (response.status === 200 && !isLoginWall && bodyStr.length > 0) {
        console.log(`  [Instagram] Attempt ${i} succeeded — got real content.`);
        return { blocked: false, results: [], rawLength: bodyStr.length };
      }

      console.log(`  [Instagram] Attempt ${i} blocked (status ${response.status}, loginWall: ${isLoginWall}).`);
    } catch (err) {
      console.log(`  [Instagram] Attempt ${i} threw: ${err.code || err.message}`);
    }

    if (i < maxAttempts) await randomDelay(4000, 9000);
  }

  return { blocked: true, results: [] };
}

// ── TikTok: multiple attempts with rotation, warm-up request, delays ─────────
async function searchTikTokWithRetries(keyword, maxAttempts = 4) {
  const baseUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`;

  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const headers = getBrowserHeaders();

      if (i > 1) {
        try {
          await attemptRequest("https://www.tiktok.com/", headers, `${i}-warmup`);
          await randomDelay(1500, 3500);
        } catch (warmupErr) {
          console.log(`  [attempt ${i}-warmup] failed: ${warmupErr.message}`);
        }
      }

      const response = await attemptRequest(baseUrl, getBrowserHeaders("https://www.tiktok.com/"), i);

      const bodyStr = typeof response.data === "string" ? response.data : "";
      const isVerifyWall = bodyStr.toLowerCase().includes("verify") || bodyStr.toLowerCase().includes("captcha");
      const looksEmpty = bodyStr.length < 5000; // TikTok's real SSR pages are large; a tiny shell means we got nothing

      if (response.status === 200 && !isVerifyWall && !looksEmpty) {
        console.log(`  [TikTok] Attempt ${i} succeeded — got real content.`);
        return { blocked: false, results: [], rawLength: bodyStr.length };
      }

      console.log(`  [TikTok] Attempt ${i} blocked (status ${response.status}, verifyWall: ${isVerifyWall}, tooSmall: ${looksEmpty}).`);
    } catch (err) {
      console.log(`  [TikTok] Attempt ${i} threw: ${err.code || err.message}`);
    }

    if (i < maxAttempts) await randomDelay(4000, 9000);
  }

  return { blocked: true, results: [] };
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
async function insertMatch(platform, handleOrUrl, keyword, snippet, raw) {
  await supabase.from("social_matches").insert([
    {
      platform:         platform,
      handle_or_url:    handleOrUrl,
      keyword_matched:  keyword,
      content_snippet:  snippet || null,
      raw_data:         raw || null,
      status:           "new",
    },
  ]);
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
// Genuine 2-hour best-effort attempt: rotates user agents, uses realistic
// browser headers, does warm-up requests, and retries with backoff.
// If still blocked after the full attempt budget, logs honestly and moves on.
async function runSocialScraper() {
  const startedAt = new Date().toISOString();
  const HARD_DEADLINE = Date.now() + 2 * 60 * 60 * 1000; // 2 hours
  let totalInserted = 0;
  let errorMsg = null;
  let igEverSucceeded = false;
  let ttEverSucceeded = false;

  console.log("[Social] Scraper started at", startedAt);
  console.log("[Social] Hard deadline:", new Date(HARD_DEADLINE).toISOString());

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
      if (Date.now() > HARD_DEADLINE) {
        console.log("[Social] 2-hour cap reached. Stopping early.");
        errorMsg = "Stopped early — 2 hour cap reached";
        break;
      }

      console.log(`\n[Social] === Searching for: "${kw.term}" ===`);

      // ── Instagram ──────────────────────────────────────────────────────────
      console.log(`[Instagram] "${kw.term}" — starting retry sequence...`);
      const ig = await searchInstagramWithRetries(kw.term);

      if (ig.blocked) {
        await logScan("social_instagram", startedAt, 0, "Blocked by platform (after multi-attempt retry with UA rotation)");
        console.log(`[Instagram] "${kw.term}" — blocked after all attempts, logged to scan_logs.`);
      } else {
        igEverSucceeded = true;
        console.log(`[Instagram] "${kw.term}" — got through! Raw length: ${ig.rawLength}. (Parsing not yet implemented — flag for follow-up.)`);
        await logScan("social_instagram", startedAt, 0, `Got 200 + real content (${ig.rawLength} bytes) — needs parser`);
      }

      if (Date.now() > HARD_DEADLINE) break;
      await randomDelay(3000, 6000);

      // ── TikTok ─────────────────────────────────────────────────────────────
      console.log(`[TikTok] "${kw.term}" — starting retry sequence...`);
      const tt = await searchTikTokWithRetries(kw.term);

      if (tt.blocked) {
        await logScan("social_tiktok", startedAt, 0, "Blocked by platform (after multi-attempt retry with UA rotation)");
        console.log(`[TikTok] "${kw.term}" — blocked after all attempts, logged to scan_logs.`);
      } else {
        ttEverSucceeded = true;
        console.log(`[TikTok] "${kw.term}" — got through! Raw length: ${tt.rawLength}. (Parsing not yet implemented — flag for follow-up.)`);
        await logScan("social_tiktok", startedAt, 0, `Got 200 + real content (${tt.rawLength} bytes) — needs parser`);
      }

      if (Date.now() > HARD_DEADLINE) break;
      await randomDelay(3000, 6000);
    }
  } catch (err) {
    console.error("[Social] Scraper failed:", err.message);
    errorMsg = err.message;
  }

  const summary = `IG ever succeeded: ${igEverSucceeded}, TT ever succeeded: ${ttEverSucceeded}`;
  console.log(`\n[Social] FINAL SUMMARY: ${summary}`);
  await logScan("social_media", startedAt, totalInserted, errorMsg || summary);
  console.log(`[Social] Scraper finished. Inserted ${totalInserted} new match(es).`);
  return totalInserted;
}

module.exports = { runSocialScraper };