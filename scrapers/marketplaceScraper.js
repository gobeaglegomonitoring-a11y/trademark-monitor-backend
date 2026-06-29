const axios   = require('axios');
const supabase = require('../lib/supabase');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function containsKeyword(text, keyword) {
  return text.toLowerCase().includes(keyword.toLowerCase());
}

// ── eBay Browse API ───────────────────────────────────────────────────────────
async function getEbayToken() {
  const creds = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');

  const { data } = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
    {
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10000,
    }
  );
  return data.access_token;
}

async function scrapeEbay(keyword) {
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) {
    console.log('[MARKETPLACE] [eBay] API key missing — skipping');
    return { listings: [], skipped: true };
  }

  const token = await getEbayToken();
  const { data } = await axios.get(
    'https://api.ebay.com/buy/browse/v1/item_summary/search',
    {
      params: { q: keyword, limit: 50 },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 12000,
    }
  );

  const listings = (data.itemSummaries || [])
    .filter(item => containsKeyword(item.title || '', keyword))
    .map(item => ({
      title:  item.title || '',
      url:    item.itemWebUrl || '',
      seller: item.seller?.username || 'Unknown',
    }));

  return { listings, skipped: false };
}

// ── Etsy Open API v3 ──────────────────────────────────────────────────────────
async function scrapeEtsy(keyword) {
  if (!process.env.ETSY_API_KEY) {
    console.log('[MARKETPLACE] [Etsy] API key missing — skipping');
    return { listings: [], skipped: true };
  }

  const { data } = await axios.get(
    'https://openapi.etsy.com/v3/application/listings/active',
    {
      params: { keywords: keyword, limit: 25 },
      headers: { 'x-api-key': process.env.ETSY_API_KEY },
      timeout: 12000,
    }
  );

  const listings = (data.results || [])
    .filter(item => containsKeyword(item.title || '', keyword))
    .map(item => ({
      title:  item.title || '',
      url:    `https://www.etsy.com/listing/${item.listing_id}`,
      seller: item.shop?.shop_name || 'Unknown',
    }));

  return { listings, skipped: false };
}

// ── Amazon (Puppeteer) ────────────────────────────────────────────────────────
async function scrapeAmazon(keyword) {
  const { default: puppeteerExtra } = await import('puppeteer-extra');
  const { default: StealthPlugin }  = await import('puppeteer-extra-plugin-stealth');
  puppeteerExtra.use(StealthPlugin());

  const browser = await puppeteerExtra.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(randomUA());
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    await page.goto(
      `https://www.amazon.com/s?k=${encodeURIComponent(keyword)}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    await new Promise(r => setTimeout(r, 3000));

    const title = await page.title();
    console.log(`[MARKETPLACE] [Amazon] Page: ${title}`);

    if (title.toLowerCase().includes('robot') || title.toLowerCase().includes('captcha')) {
      console.error('[MARKETPLACE] [Amazon] BLOCKED — CAPTCHA detected');
      return { listings: [], skipped: false };
    }

    await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: 8000 }).catch(() => {});

    const all = await page.$$eval(
      '[data-component-type="s-search-result"], div[data-asin]:not([data-asin=""])',
      els => els.flatMap(el => {
        const titleText = el.querySelector('h2 span, .a-size-medium, .a-size-base-plus')?.textContent?.trim() || '';
        const href      = el.querySelector('h2 a')?.href || '';
        const byEl      = el.querySelector('.a-row .a-size-base.a-color-secondary');
        let seller = 'Unknown';
        if (byEl) {
          const t = byEl.textContent?.trim() || '';
          if (t && !/^\([\d.,KkMm]+\)$/.test(t)) seller = t;
        }
        if (!titleText) return [];
        return [{ title: titleText, url: href, seller }];
      })
    ).catch(() => []);

    const invalid  = all.filter(l => !l.title || l.title.length < 3).length;
    const listings = all.filter(l => l.title && l.title.length >= 3 && containsKeyword(l.title, keyword));

    console.log(`[MARKETPLACE] [Amazon] "${keyword}" — scraped: ${all.length}, relevant: ${listings.length}, skipped invalid: ${invalid}`);

    return { listings, skipped: false };
  } finally {
    await browser.close();
  }
}

// ── Insert with stats ─────────────────────────────────────────────────────────
async function insertListing(platform, keyword, listing) {
  try {
    const { data: ex } = await supabase
      .from('marketplace_matches')
      .select('id')
      .eq('platform', platform)
      .eq('keyword_matched', keyword)
      .eq('listing_title', listing.title)
      .limit(1);

    if (ex && ex.length > 0) return 'duplicate';

    const { error } = await supabase.from('marketplace_matches').insert({
      platform,
      keyword_matched: keyword,
      listing_title:   listing.title,
      listing_url:     listing.url    || null,
      seller_name:     listing.seller || 'Unknown',
      status:          'new',
      created_at:      new Date().toISOString(),
    });

    if (error) { console.error(`[MARKETPLACE] Insert error: ${error.message}`); return 'error'; }
    return 'inserted';
  } catch (err) {
    console.error(`[MARKETPLACE] Insert exception: ${err.message}`);
    return 'error';
  }
}

// ── Main runner ───────────────────────────────────────────────────────────────
async function runMarketplaceScraper() {
  console.log('[MARKETPLACE] Starting marketplace scan...');

  const { data: keywords } = await supabase
    .from('keywords').select('term').eq('active', true);
  if (!keywords?.length) { console.log('[MARKETPLACE] No active keywords.'); return 0; }

  const { data: logEntry } = await supabase
    .from('scan_logs')
    .insert([{ scan_type: 'marketplace', started_at: new Date().toISOString() }])
    .select().single();
  const logId = logEntry?.id;

  const platformFns = [
    { name: 'Amazon', fn: scrapeAmazon },
    { name: 'eBay',   fn: scrapeEbay   },
    { name: 'Etsy',   fn: scrapeEtsy   },
  ];

  let totalInserted = 0;
  let errorLog      = null;
  const summary     = {};

  for (const { name, fn } of platformFns) {
    summary[name] = { found: 0, inserted: 0, duplicates: 0, errors: 0 };
  }

  for (const kw of keywords) {
    for (const { name, fn } of platformFns) {
      try {
        const { listings, skipped } = await fn(kw.term);
        if (skipped) continue;

        summary[name].found += listings.length;

        for (const listing of listings) {
          const result = await insertListing(name, kw.term, listing);
          if (result === 'inserted')  { summary[name].inserted++;   totalInserted++; console.log(`[MARKETPLACE] [${name}] NEW: "${listing.title}" | Seller: ${listing.seller}`); }
          if (result === 'duplicate') { summary[name].duplicates++; }
          if (result === 'error')     { summary[name].errors++;     }
        }
      } catch (err) {
        console.error(`[MARKETPLACE] [${name}] Error: ${err.message}`);
        errorLog = err.message;
        summary[name].errors++;
      }

      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  console.log('\n[MARKETPLACE] ── FINAL SUMMARY ──────────────────────────────');
  for (const [name, s] of Object.entries(summary)) {
    console.log(`[MARKETPLACE] ${name.padEnd(8)}: found ${s.found}, inserted ${s.inserted}, duplicates ${s.duplicates}, errors ${s.errors}`);
  }
  console.log(`[MARKETPLACE] Total new listings inserted: ${totalInserted}`);

  if (logId) {
    await supabase.from('scan_logs').update({
      completed_at: new Date().toISOString(),
      total_found:  totalInserted,
      error_log:    errorLog,
    }).eq('id', logId);
  }

  return totalInserted;
}

module.exports = { runMarketplaceScraper };
