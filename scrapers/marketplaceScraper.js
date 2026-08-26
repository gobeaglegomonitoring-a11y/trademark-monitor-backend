const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');
const supabase = require('../lib/supabase');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function containsKeyword(text, keyword) {
  return cleanText(text).toLowerCase().includes(cleanText(keyword).toLowerCase());
}

function normalizeUrl(url, baseUrl) {
  if (!url) return '';
  try {
    const parsed = new URL(url, baseUrl);
    parsed.hash = '';

    if (parsed.hostname.includes('ebay.')) {
      parsed.search = '';
    }

    if (parsed.hostname.includes('etsy.')) {
      const match = parsed.pathname.match(/\/listing\/\d+/);
      if (match) parsed.pathname = match[0];
      parsed.search = '';
    }

    return parsed.toString();
  } catch {
    return url;
  }
}

function parseJsonEnv(name, fallback) {
  if (!process.env[name]) return fallback;
  try {
    return JSON.parse(process.env[name]);
  } catch (err) {
    console.warn(`[MARKETPLACE] Invalid ${name}: ${err.message}`);
    return fallback;
  }
}

function safeFilePart(value) {
  return String(value)
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'keyword';
}

async function captureDebugPage(page, platform, keyword) {
  const debugDir = path.join(__dirname, '..', 'debug', 'marketplace', platform.toLowerCase());
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `${stamp}-${safeFilePart(keyword)}`;
  const htmlPath = path.join(debugDir, `${baseName}.html`);
  const textPath = path.join(debugDir, `${baseName}.txt`);
  const screenshotPath = path.join(debugDir, `${baseName}.png`);

  await fs.mkdir(debugDir, { recursive: true });

  const [html, text] = await Promise.all([
    page.content(),
    page.evaluate(() => document.body?.innerText || ''),
  ]);

  await Promise.all([
    fs.writeFile(htmlPath, html, 'utf8'),
    fs.writeFile(textPath, text, 'utf8'),
    page.screenshot({ path: screenshotPath, fullPage: true }),
  ]);

  console.log(`[MARKETPLACE] [${platform}] Debug capture saved: ${path.relative(process.cwd(), htmlPath)}, ${path.relative(process.cwd(), textPath)}, ${path.relative(process.cwd(), screenshotPath)}`);
}

async function withBrowserPage(platform, fn) {
  let browser;

  if (process.env.RENDER) {
    const { launchBrowser } = require('../lib/browser');
    browser = await launchBrowser(['--ignore-certificate-errors']);
  } else {
    const { default: puppeteerExtra } = await import('puppeteer-extra');
    const { default: StealthPlugin }  = await import('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
    browser = await puppeteerExtra.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
    });
  }

  try {
    const page = await browser.newPage();
    const userAgent = randomUA();
    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    console.log(`[MARKETPLACE] [${platform}] User-Agent: ${userAgent}`);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

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

async function scrapeEbayApi(keyword) {
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
    .filter(item => containsKeyword(item.title, keyword))
    .map(item => ({
      title: cleanText(item.title),
      url: normalizeUrl(item.itemWebUrl, 'https://www.ebay.com'),
      seller: cleanText(item.seller?.username) || 'Unknown',
    }));

  console.log(`[MARKETPLACE] [eBay] "${keyword}" - API relevant: ${listings.length}`);
  return { listings, skipped: false };
}

function buildApifyInput(platform, keyword) {
  const envName = `APIFY_${platform.toUpperCase()}_INPUT_TEMPLATE`;
  const template = parseJsonEnv(envName, {});

  const base = platform.toLowerCase() === 'ebay'
    ? {
        searchQueries: [keyword],
        maxProductsPerSearch: 50,
        listingType: 'all',
        sort: 'best_match',
        maxSearchPages: 1,
        maxRequestRetries: 3,
      }
    : {
        searchQuery: keyword,
        query: keyword,
        search: keyword,
        keyword,
        maxItems: 50,
        proxyConfiguration: { useApifyProxy: true },
      };

  return { ...base, ...template };
}

function normalizeApifyItem(item, keyword, baseUrl) {
  const title = cleanText(
    item.title ||
    item.name ||
    item.listingTitle ||
    item.productTitle ||
    item.itemTitle
  );
  const url = normalizeUrl(
    item.url ||
    item.listingUrl ||
    item.productUrl ||
    item.itemUrl ||
    item.link,
    baseUrl
  );

  const sellerRaw =
    item.sellerName ||
    item.shopName ||
    item.shop ||
    item.storeName ||
    item.seller_name ||
    item.shop_name ||
    (typeof item.seller === 'string' ? item.seller : null) ||
    (typeof item.seller === 'object' ? item.seller?.username || item.seller?.name || item.seller?.feedbackScore : null) ||
    (typeof item.sellerInfo === 'object' ? item.sellerInfo?.username || item.sellerInfo?.name : null) ||
    null;

  const seller = cleanText(sellerRaw) || 'Unknown';

  if (!title || !url || !containsKeyword(title, keyword)) return null;
  return { title, url, seller };
}

async function scrapeWithApify(platform, keyword, baseUrl) {
  const token = process.env.APIFY_TOKEN;
  const actorId = process.env[`APIFY_${platform.toUpperCase()}_ACTOR_ID`];

  if (!token || !actorId) {
    console.log(`[MARKETPLACE] [${platform}] Apify not configured - using local scraper`);
    return null;
  }

  const encodedActorId = encodeURIComponent(actorId);
  const url = `https://api.apify.com/v2/actors/${encodedActorId}/run-sync-get-dataset-items`;
  const input = buildApifyInput(platform, keyword);

  const { data } = await axios.post(url, input, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    params: {
      timeout: 180,
      memory: 1024,
    },
    timeout: 190000,
  });

  const items = Array.isArray(data) ? data : [];
  const seen = new Set();
  const listings = items
    .map(item => normalizeApifyItem(item, keyword, baseUrl))
    .filter(Boolean)
    .filter(item => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .slice(0, 50);

  console.log(`[MARKETPLACE] [${platform}] "${keyword}" - Apify items: ${items.length}, relevant: ${listings.length}`);
  return { listings, skipped: false };
}

async function scrapeEbayWeb(keyword) {
  const listings = await withBrowserPage('eBay', async page => {
    await page.goto(
      `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(keyword)}&_ipg=60`,
      { waitUntil: 'networkidle2', timeout: 45000 }
    );
    await sleep(5000);

    const title = await page.title();
    console.log(`[MARKETPLACE] [eBay] Page: ${title}`);

    if (/access denied|captcha|robot|blocked|error page/i.test(title) || await page.$('iframe[src*="captcha"], #captcha')) {
      await captureDebugPage(page, 'eBay', keyword);
      throw new Error('eBay blocked automated search');
    }

    await page.waitForSelector('.s-item, a[href*="/itm/"]', { timeout: 10000 }).catch(() => {});

    const rows = await page.evaluate(() => {
      const seen = new Set();
      const items = [];

      function addItem(title, href, seller) {
        const cleanTitle = (title || '').replace(/\s+/g, ' ').trim().replace(/^Shop on eBay$/i, '');
        if (!cleanTitle || !href || cleanTitle.length < 3) return;
        const key = href.split('?')[0];
        if (seen.has(key)) return;
        seen.add(key);
        items.push({ title: cleanTitle, url: href, seller: seller || 'Unknown' });
      }

      document.querySelectorAll('.s-item').forEach(el => {
        const titleText = el.querySelector('.s-item__title')?.textContent;
        const href = el.querySelector('a.s-item__link')?.href;
        const sellerText =
          el.querySelector('.s-item__seller-info-text')?.textContent?.trim() ||
          el.querySelector('.s-item__seller-info')?.textContent?.trim() ||
          'Unknown';
        addItem(titleText, href, sellerText.replace(/^Seller:\s*/i, ''));
      });

      document.querySelectorAll('a[href*="/itm/"]').forEach(link => {
        const card = link.closest('li, div, article');
        const sellerText =
          card?.querySelector('.s-item__seller-info-text, .s-item__seller-info, [class*="seller"]')?.textContent?.trim() ||
          'Unknown';
        addItem(link.getAttribute('aria-label') || link.textContent, link.href, sellerText.replace(/^Seller:\s*/i, ''));
      });

      return items;
    });

    if (rows.length === 0) {
      await captureDebugPage(page, 'eBay', keyword);
    }

    return rows;
  });

  const relevant = listings
    .map(item => ({
      title: cleanText(item.title),
      url: normalizeUrl(item.url, 'https://www.ebay.com'),
      seller: cleanText(item.seller) || 'Unknown',
    }))
    .filter(item => containsKeyword(item.title, keyword))
    .slice(0, 50);

  console.log(`[MARKETPLACE] [eBay] "${keyword}" - scraped: ${listings.length}, relevant: ${relevant.length}`);
  return { listings: relevant, skipped: false };
}

async function scrapeEbay(keyword) {
  if (process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET) {
    try {
      return await scrapeEbayApi(keyword);
    } catch (err) {
      console.warn(`[MARKETPLACE] [eBay] API failed (${err.message}) - using web scraper`);
    }
  } else {
    console.log('[MARKETPLACE] [eBay] API keys missing - using web scraper');
  }

  const apifyResult = await scrapeWithApify('eBay', keyword, 'https://www.ebay.com');
  if (apifyResult) return apifyResult;

  return scrapeEbayWeb(keyword);
}

async function scrapeEtsy(keyword) {
  const apifyResult = await scrapeWithApify('Etsy', keyword, 'https://www.etsy.com');
  if (apifyResult) return apifyResult;

  const listings = await withBrowserPage('Etsy', async page => {
    await page.goto(
      `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    await sleep(3000);

    const title = await page.title();
    console.log(`[MARKETPLACE] [Etsy] Page: ${title}`);

    if (/access denied|captcha|robot|blocked/i.test(title) || await page.$('iframe[src*="captcha"], #captcha')) {
      await captureDebugPage(page, 'Etsy', keyword);
      throw new Error('Etsy blocked automated search');
    }

    await page.waitForSelector('a[href*="/listing/"]', { timeout: 10000 }).catch(() => {});

    const rows = await page.$$eval('a[href*="/listing/"]', links => {
      const seen = new Set();
      return links.flatMap(link => {
        const titleText =
          link.getAttribute('title') ||
          link.querySelector('h3')?.textContent?.trim() ||
          link.textContent?.trim() ||
          '';
        const href = link.href || '';
        const card = link.closest('li, div');
        const seller =
          card?.querySelector('[data-shop-name]')?.getAttribute('data-shop-name') ||
          card?.querySelector('p.wt-text-caption, .v2-listing-card__shop, [class*="shop"]')?.textContent?.trim() ||
          'Unknown';

        const listingMatch = href.match(/\/listing\/\d+/);
        const key = listingMatch ? listingMatch[0] : href;
        if (!titleText || !href || titleText.length < 3 || seen.has(key)) return [];
        seen.add(key);
        return [{ title: titleText, url: href, seller }];
      });
    });

    if (rows.length === 0) {
      await captureDebugPage(page, 'Etsy', keyword);
    }

    return rows;
  });

  const relevant = listings
    .map(item => ({
      title: cleanText(item.title),
      url: normalizeUrl(item.url, 'https://www.etsy.com'),
      seller: cleanText(item.seller) || 'Unknown',
    }))
    .filter(item => containsKeyword(item.title, keyword))
    .slice(0, 50);

  console.log(`[MARKETPLACE] [Etsy] "${keyword}" - scraped: ${listings.length}, relevant: ${relevant.length}`);
  return { listings: relevant, skipped: false };
}

async function scrapeAmazon(keyword) {
  return withBrowserPage('Amazon', async page => {
    await page.goto(
      `https://www.amazon.com/s?k=${encodeURIComponent(keyword)}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    await sleep(3000);

    const title = await page.title();
    console.log(`[MARKETPLACE] [Amazon] Page: ${title}`);

    if (/robot|captcha/i.test(title) || await page.$('form[action*="validateCaptcha"], input[name="field-keywords"] + .a-alert')) {
      console.error('[MARKETPLACE] [Amazon] BLOCKED - CAPTCHA detected');
      return { listings: [], skipped: false };
    }

    await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: 8000 }).catch(() => {});

    const all = await page.$$eval(
      '[data-component-type="s-search-result"], div[data-asin]:not([data-asin=""])',
      els => els.flatMap(el => {
        const titleText = el.querySelector('h2 span, .a-size-medium, .a-size-base-plus')?.textContent?.trim() || '';
        const href = el.querySelector('h2 a')?.href || '';
        const byEl = el.querySelector('.a-row .a-size-base.a-color-secondary');
        let seller = 'Amazon';
        if (byEl) {
          const t = byEl.textContent?.trim() || '';
          if (t && !/^\([\d.,KkMm]+\)$/.test(t)) seller = t;
        }
        if (!titleText) return [];
        return [{ title: titleText, url: href, seller }];
      })
    ).catch(() => []);

    const listings = all
      .map(item => ({
        title: cleanText(item.title),
        url: normalizeUrl(item.url, 'https://www.amazon.com'),
        seller: cleanText(item.seller) || 'Amazon',
      }))
      .filter(item => item.title.length >= 3 && containsKeyword(item.title, keyword))
      .slice(0, 50);

    console.log(`[MARKETPLACE] [Amazon] "${keyword}" - scraped: ${all.length}, relevant: ${listings.length}`);
    return { listings, skipped: false };
  });
}

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
      listing_title: listing.title,
      listing_url: listing.url || null,
      seller_name: listing.seller || 'Unknown',
      status: 'new',
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error(`[MARKETPLACE] Insert error: ${error.message}`);
      return 'error';
    }

    return 'inserted';
  } catch (err) {
    console.error(`[MARKETPLACE] Insert exception: ${err.message}`);
    return 'error';
  }
}

let marketplaceScanRunning = false;

function withPlatformTimeout(promise, platform, keyword) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${platform} scan for "${keyword}" timed out after 8 minutes`)),
      8 * 60 * 1000,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runMarketplaceScraper() {
  const { shouldStop, clearStop } = require('../lib/scanControl');
  clearStop('marketplace');
  if (marketplaceScanRunning) {
    console.log('[MARKETPLACE] Scan already running - skipping duplicate request.');
    return 0;
  }

  marketplaceScanRunning = true;
  console.log('[MARKETPLACE] Starting marketplace scan...');
  let logId = null;
  let totalInserted = 0;
  let errorLog = null;

  try {
    const { data: keywords } = await supabase
      .from('keywords')
      .select('term')
      .eq('active', true);

    if (!keywords?.length) {
      console.log('[MARKETPLACE] No active keywords.');
      return 0;
    }

    const { data: logEntry } = await supabase
      .from('scan_logs')
      .insert([{ scan_type: 'marketplace', started_at: new Date().toISOString() }])
      .select()
      .single();
    logId = logEntry?.id;

    const platformFns = [
      { name: 'Amazon', fn: scrapeAmazon },
      { name: 'eBay', fn: scrapeEbay },
      { name: 'Etsy', fn: scrapeEtsy },
    ];

    const summary = {};

    for (const { name } of platformFns) {
      summary[name] = { found: 0, inserted: 0, duplicates: 0, errors: 0 };
    }

    outer:
    for (const kw of keywords) {
      for (const { name, fn } of platformFns) {
        if (shouldStop('marketplace')) {
          console.log('[MARKETPLACE] Stop requested — ending scan early.');
          errorLog = 'Stopped by user';
          break outer;
        }
        try {
          const { listings, skipped } = await withPlatformTimeout(fn(kw.term), name, kw.term);
          if (skipped) continue;

          summary[name].found += listings.length;

          for (const listing of listings) {
            const result = await insertListing(name, kw.term, listing);
            if (result === 'inserted') {
              summary[name].inserted++;
              totalInserted++;
              console.log(`[MARKETPLACE] [${name}] NEW: "${listing.title}" | Seller: ${listing.seller}`);
            }
            if (result === 'duplicate') summary[name].duplicates++;
            if (result === 'error') summary[name].errors++;
          }
        } catch (err) {
          console.error(`[MARKETPLACE] [${name}] Error: ${err.message}`);
          errorLog = err.message;
          summary[name].errors++;
        }

        await sleep(1000);
      }
    }

    console.log('\n[MARKETPLACE] FINAL SUMMARY');
    for (const [name, s] of Object.entries(summary)) {
      console.log(`[MARKETPLACE] ${name.padEnd(8)}: found ${s.found}, inserted ${s.inserted}, duplicates ${s.duplicates}, errors ${s.errors}`);
    }
    console.log(`[MARKETPLACE] Total new listings inserted: ${totalInserted}`);

    return totalInserted;
  } catch (err) {
    errorLog = err.message;
    throw err;
  } finally {
    if (logId) {
      const { error: finalizeError } = await supabase.from('scan_logs').update({
        completed_at: new Date().toISOString(),
        total_found: totalInserted,
        error_log: errorLog,
      }).eq('id', logId);
      if (finalizeError) console.error('[MARKETPLACE] Scan-log finalization failed:', finalizeError.message);
    }
    marketplaceScanRunning = false;
  }
}

module.exports = { runMarketplaceScraper };
