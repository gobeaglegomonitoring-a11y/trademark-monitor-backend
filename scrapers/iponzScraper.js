const levenshtein = require('fast-levenshtein');
const fs = require('fs/promises');
const path = require('path');
const supabase = require('../lib/supabase');

const DELAY_MS = 3000;
const IPONZ_URL = 'https://app.iponz.govt.nz/app/Extra/Default.aspx?op=EXTRA_tm_qbe&fcoOp=EXTRA__Default&directAccess=true';

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

function safeFilePart(value) {
  return String(value)
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'keyword';
}

async function captureDebugPage(page, keyword) {
  const debugDir = path.join(__dirname, '..', 'debug', 'iponz');
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

  console.log(`[IPONZ] Debug capture saved: ${path.relative(process.cwd(), htmlPath)}, ${path.relative(process.cwd(), textPath)}, ${path.relative(process.cwd(), screenshotPath)}`);
}

async function hasCaptchaChallenge(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    return /captcha|i'?m not a robot|solve and validate/i.test(text);
  });
}

async function searchIPONZ(browser, keyword) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 900 });

  try {
    await page.goto(IPONZ_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    const title = await page.title();
    console.log(`[IPONZ] Loaded: ${title}`);

    // Fill in the trademark denomination/title field
    const deno = '#MainContent_ctrlTMSearch_txtDeno';
    await page.waitForSelector(deno, { timeout: 8000 });
    await page.$eval(deno, el => { el.value = ''; });
    await page.type(deno, keyword, { delay: 60 });
    console.log(`[IPONZ] Typed "${keyword}"`);

    if (await hasCaptchaChallenge(page)) {
      await captureDebugPage(page, keyword);
      throw new Error('IPONZ requires CAPTCHA validation before search; automated search skipped.');
    }

    // Find the Search element by looking at every element's rendered text
    // Works regardless of element type (<a>, <button>, <div>, <span>, etc.)
    const searchCoords = await page.evaluate(() => {
      // Walk all text nodes — find one whose trimmed text is exactly "Search"
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (/^search$/i.test(node.textContent.trim())) {
          const el = node.parentElement;
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, tag: el.tagName, id: el.id };
          }
        }
      }

      // Fallback: check textContent on interactive elements
      const clickables = document.querySelectorAll('a, button, input, [role="button"], [onclick]');
      for (const el of clickables) {
        const text = (el.textContent || el.value || '').trim();
        if (/^search$/i.test(text)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, tag: el.tagName, id: el.id };
          }
        }
      }

      return null;
    });

    console.log(`[IPONZ] Search element: ${JSON.stringify(searchCoords)}`);

    // Use page.click() with the known ID — auto-scrolls into view before clicking
    const searchBtnId = searchCoords?.id || 'MainContent_ctrlTMSearch_lnkbtnSearch';
    try {
      await page.click(`#${searchBtnId}`);
      console.log(`[IPONZ] Clicked #${searchBtnId}`);
    } catch (e) {
      // Last resort: set __EVENTTARGET and submit the form
      console.log(`[IPONZ] page.click failed (${e.message}) — submitting form directly`);
      await page.evaluate(() => {
        const evt = document.getElementById('__EVENTTARGET');
        if (evt) evt.value = 'ctl00$MainContent$ctrlTMSearch$lnkbtnSearch';
        const form = document.querySelector('form');
        if (form) form.submit();
      });
    }

    // Wait for PostBack navigation OR UpdatePanel AJAX update
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 12000 }).catch(() => {}),
      sleep(10000)
    ]);

    if (await hasCaptchaChallenge(page)) {
      await captureDebugPage(page, keyword);
      throw new Error('IPONZ requires CAPTCHA validation before search; automated search skipped.');
    }

    // 1. Check for no-results message
    const noResults = await page.evaluate(() =>
      (document.body?.innerText || '').includes('Your search returned no results')
    );
    if (noResults) {
      console.log(`[IPONZ] "${keyword}" — no results`);
      return [];
    }

    // 2. Primary extraction: scan ALL <tr> elements globally.
    //    The results live inside Table[0] which also contains the search form,
    //    so filtering by TABLE breaks extraction. Filter by ROW instead —
    //    result rows never contain form inputs.
    //    Row layout confirmed: ["", caseNr, name, "", status, owner, class]
    let trademarks = await page.evaluate(() => {
      const UI_SKIP = /select all|items per page|show.*hide|hide :|show :|get result list/i;
      const results = [];

      document.querySelectorAll('tr').forEach(row => {
        if (row.querySelectorAll('input, select, textarea').length > 0) return;

        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 3) return;

        const texts = cells.map(c => c.textContent.trim());
        if (UI_SKIP.test(texts.join(' '))) return;

        // Pattern A: ["", caseNr, name, "", status, owner, class]  (checkbox col at 0)
        if (/^\d{5,7}$/.test(texts[1])) {
          const name = texts[2] || '';
          if (!name || name.length > 300) return;
          results.push({
            caseNumber: texts[1],
            name,
            status: texts[4] || '',
            owner: texts[5] || '',
            class: texts[6] || ''
          });
        }
        // Pattern B: [caseNr, name, "", status, owner, class]  (no checkbox col)
        else if (/^\d{5,7}$/.test(texts[0])) {
          const name = texts[1] || '';
          if (!name || name.length > 300) return;
          results.push({
            caseNumber: texts[0],
            name,
            status: texts[3] || '',
            owner: texts[4] || '',
            class: texts[5] || texts[texts.length - 1] || ''
          });
        }
      });

      return results;
    });

    // 3. Fallback: innerText line parser.
    //    Split on tabs (1+) OR multiple spaces (2+) to handle both table rendering modes.
    if (trademarks.length === 0) {
      console.log(`[IPONZ] TR scan got 0 — trying innerText line parser`);
      trademarks = await page.evaluate(() => {
        const UI_SKIP = /select all|items per page|show.*hide|hide :|show :|get result list/i;
        const results = [];
        const lines = (document.body?.innerText || '').split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || UI_SKIP.test(trimmed)) continue;
          if (!/^\d{5,7}(\s|\t|$)/.test(trimmed)) continue;

          const parts = trimmed.split(/\t+|\s{2,}/).map(p => p.trim()).filter(Boolean);
          if (parts.length < 2 || !/^\d{5,7}$/.test(parts[0])) continue;

          const caseNumber = parts[0];
          const name = parts[1] || '';
          const status = parts[2] || '';
          const lastPart = parts[parts.length - 1];
          const classNr = (parts.length > 3 && /^\d{1,3}(,\s*\d{1,3})*$/.test(lastPart)) ? lastPart : '';
          const owner = classNr ? parts.slice(3, -1).join(' ') : parts.slice(3).join(' ');

          if (!name || UI_SKIP.test(name)) continue;
          results.push({ caseNumber, name, status, owner: owner.trim(), class: classNr });
        }

        return results;
      });
    }

    if (trademarks.length === 0) {
      await captureDebugPage(page, keyword);
    }

    console.log(`[IPONZ] "${keyword}" — ${trademarks.length} result(s) extracted`);
    if (trademarks.length > 0) {
      console.log(`[IPONZ] First result: ${JSON.stringify(trademarks[0])}`);
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
    .eq('registry', 'IPONZ')
    .limit(1);
  return data && data.length > 0;
}

async function runIPONZScraper() {
  console.log('[IPONZ] Starting scraper...');

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
      console.log('[IPONZ] No active keywords found.');
      return 0;
    }

    console.log(`[IPONZ] Scanning ${keywords.length} keyword(s)...`);

    const { default: puppeteer } = await import('puppeteer');
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    for (const kw of keywords) {
      try {
        console.log(`[IPONZ] Searching: "${kw.term}"`);
        const hits = await searchIPONZ(browser, kw.term);

        for (const hit of hits) {
          const filingName = hit.name || '';
          if (!filingName) continue;

          const score = getSimilarity(kw.term, filingName);
          if (score < 0.8) continue;

          const duplicate = await isDuplicate(filingName, kw.term);
          if (duplicate) continue;

          await supabase.from('trademark_matches').insert([{
            registry: 'IPONZ',
            filing_name: filingName,
            filing_date: hit.filingDate || null,
            matched_keyword: kw.term,
            similarity_score: score,
            raw_data: hit,
            status: 'new'
          }]);

          totalFound++;
          console.log(`[IPONZ] Match: "${filingName}" (score: ${score.toFixed(2)})`);
        }
      } catch (kwErr) {
        console.error(`[IPONZ] Error scanning "${kw.term}":`, kwErr.message);
        errorLog = kwErr.message;
      }

      await sleep(DELAY_MS);
    }

    await browser.close();
  } catch (err) {
    console.error('[IPONZ] Fatal error:', err.message);
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

  console.log(`[IPONZ] Done. ${totalFound} new match(es) found.`);
  return totalFound;
}

module.exports = { runIPONZScraper };
