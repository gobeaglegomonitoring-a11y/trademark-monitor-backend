const supabase = require('../lib/supabase');

async function fetchMatches({ keywords, dateFrom, dateTo, status }) {
  const applyFilters = (query, kwCol) => {
    if (keywords && keywords.length > 0) {
      query = query.in(kwCol, keywords);
    }
    if (dateFrom) query = query.gte('created_at', dateFrom);
    if (dateTo)   query = query.lte('created_at', dateTo + 'T23:59:59');
    if (status)   query = query.eq('status', status);
    return query.order('created_at', { ascending: false }).limit(500);
  };

  const [tm, dm, mm, sm] = await Promise.all([
    applyFilters(supabase.from('trademark_matches').select('matched_keyword, filing_name, registry, status, created_at'), 'matched_keyword'),
    applyFilters(supabase.from('domain_matches').select('keyword_matched, domain, status, created_at'), 'keyword_matched'),
    applyFilters(supabase.from('marketplace_matches').select('keyword_matched, platform, listing_title, listing_url, seller_name, status, created_at'), 'keyword_matched'),
    applyFilters(supabase.from('social_matches').select('keyword_matched, platform, handle_or_url, status, created_at'), 'keyword_matched'),
  ]);

  return {
    trademark:   tm.data   || [],
    domain:      dm.data   || [],
    marketplace: mm.data   || [],
    social:      sm.data   || [],
  };
}

function fmt(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function badge(status) {
  const colors = {
    new:      'background:#D6E4F0;color:#1B2A4A',
    reviewed: 'background:#D4EDDA;color:#1E7A4A',
    dismissed:'background:#F4F6F9;color:#888',
  };
  const s = (status || 'new').toLowerCase();
  return `<span style="padding:2px 8px;border-radius:10px;font-size:11px;font-weight:bold;${colors[s] || colors.new}">${s}</span>`;
}

function section(title, color, count, html) {
  if (count === 0) return '';
  return `
    <div class="section">
      <div class="section-title" style="border-left:4px solid ${color}">${title}
        <span class="count">${count}</span>
      </div>
      ${html}
    </div>`;
}

function trademarkTable(rows) {
  if (!rows.length) return '';
  const trs = rows.map(r => `
    <tr>
      <td>${r.matched_keyword || '—'}</td>
      <td>${r.filing_name     || '—'}</td>
      <td>${r.registry        || '—'}</td>
      <td>${badge(r.status)}</td>
      <td>${fmt(r.created_at)}</td>
    </tr>`).join('');
  return `<table><thead><tr>
    <th>Keyword</th><th>Filing Name</th><th>Registry</th><th>Status</th><th>Date</th>
  </tr></thead><tbody>${trs}</tbody></table>`;
}

function domainTable(rows) {
  if (!rows.length) return '';
  const trs = rows.map(r => `
    <tr>
      <td>${r.keyword_matched || '—'}</td>
      <td>${r.domain          || '—'}</td>
      <td>${badge(r.status)}</td>
      <td>${fmt(r.created_at)}</td>
    </tr>`).join('');
  return `<table><thead><tr>
    <th>Keyword</th><th>Domain</th><th>Status</th><th>Date</th>
  </tr></thead><tbody>${trs}</tbody></table>`;
}

function marketplaceTable(rows) {
  if (!rows.length) return '';
  const trs = rows.map(r => `
    <tr>
      <td>${r.keyword_matched || '—'}</td>
      <td>${r.platform        || '—'}</td>
      <td class="long">${r.listing_title || '—'}</td>
      <td>${r.seller_name     || '—'}</td>
      <td>${badge(r.status)}</td>
      <td>${fmt(r.created_at)}</td>
    </tr>`).join('');
  return `<table><thead><tr>
    <th>Keyword</th><th>Platform</th><th>Listing</th><th>Seller</th><th>Status</th><th>Date</th>
  </tr></thead><tbody>${trs}</tbody></table>`;
}

function socialTable(rows) {
  if (!rows.length) return '';
  const trs = rows.map(r => `
    <tr>
      <td>${r.keyword_matched || '—'}</td>
      <td>${r.platform        || '—'}</td>
      <td>${r.handle_or_url   || '—'}</td>
      <td>${badge(r.status)}</td>
      <td>${fmt(r.created_at)}</td>
    </tr>`).join('');
  return `<table><thead><tr>
    <th>Keyword</th><th>Platform</th><th>Handle / URL</th><th>Status</th><th>Date</th>
  </tr></thead><tbody>${trs}</tbody></table>`;
}

function buildHtml({ matches, keywords, dateFrom, dateTo }) {
  const total = matches.trademark.length + matches.domain.length + matches.marketplace.length + matches.social.length;
  const kwList = keywords && keywords.length ? keywords.join(', ') : 'All active keywords';
  const dateRange = (dateFrom || dateTo)
    ? `${dateFrom || '—'} to ${dateTo || '—'}`
    : 'All time';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; color: #111; font-size: 13px; padding: 40px; }

  .header { margin-bottom: 32px; border-bottom: 2px solid #1B2A4A; padding-bottom: 20px; }
  .header h1 { font-size: 22px; color: #1B2A4A; margin-bottom: 6px; }
  .header .meta { display: flex; gap: 32px; margin-top: 12px; }
  .header .meta-item { font-size: 12px; color: #555; }
  .header .meta-item strong { color: #1B2A4A; display: block; margin-bottom: 2px; }

  .summary { display: flex; gap: 16px; margin-bottom: 32px; }
  .summary-card { flex: 1; padding: 14px 18px; border-radius: 6px; }
  .summary-card .num { font-size: 24px; font-weight: bold; }
  .summary-card .lbl { font-size: 11px; font-weight: bold; letter-spacing: 0.5px; text-transform: uppercase; margin-top: 4px; }

  .section { margin-bottom: 32px; }
  .section-title { font-size: 13px; font-weight: bold; letter-spacing: 0.5px; text-transform: uppercase;
    color: #1B2A4A; padding: 8px 12px; background: #F4F6F9; margin-bottom: 12px;
    display: flex; align-items: center; gap: 10px; }
  .count { background: #1B2A4A; color: #fff; border-radius: 10px; padding: 1px 8px; font-size: 11px; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 8px; }
  th { background: #1B2A4A; color: #fff; padding: 8px 10px; text-align: left; font-size: 11px;
       font-weight: bold; letter-spacing: 0.4px; white-space: nowrap; }
  td { padding: 8px 10px; border-bottom: 1px solid #EEEEEE; vertical-align: top; }
  tr:nth-child(even) td { background: #F9FAFB; }
  td.long { max-width: 220px; word-break: break-word; }

  .footer { margin-top: 40px; border-top: 1px solid #DDD; padding-top: 12px;
    font-size: 11px; color: #888; display: flex; justify-content: space-between; }
</style>
</head>
<body>

<div class="header">
  <h1>Trademark & Brand Monitor — Match Report</h1>
  <div class="meta">
    <div class="meta-item"><strong>Generated</strong>${new Date().toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })}</div>
    <div class="meta-item"><strong>Keywords</strong>${kwList}</div>
    <div class="meta-item"><strong>Date Range</strong>${dateRange}</div>
    <div class="meta-item"><strong>Total Matches</strong>${total}</div>
  </div>
</div>

<div class="summary">
  <div class="summary-card" style="background:#D6E4F0">
    <div class="num" style="color:#1B2A4A">${matches.trademark.length}</div>
    <div class="lbl" style="color:#1B2A4A">Trademark</div>
  </div>
  <div class="summary-card" style="background:#FFF3D0">
    <div class="num" style="color:#8B6000">${matches.domain.length}</div>
    <div class="lbl" style="color:#8B6000">Domain</div>
  </div>
  <div class="summary-card" style="background:#D4EDDA">
    <div class="num" style="color:#1E7A4A">${matches.marketplace.length}</div>
    <div class="lbl" style="color:#1E7A4A">Marketplace</div>
  </div>
  <div class="summary-card" style="background:#F0E6FF">
    <div class="num" style="color:#5B2D8E">${matches.social.length}</div>
    <div class="lbl" style="color:#5B2D8E">Social</div>
  </div>
</div>

${section('Trademark Registry Matches', '#2E5FA3', matches.trademark.length,   trademarkTable(matches.trademark))}
${section('Domain Typo Matches',         '#D4A017', matches.domain.length,      domainTable(matches.domain))}
${section('Marketplace Matches',          '#1E7A4A', matches.marketplace.length, marketplaceTable(matches.marketplace))}
${section('Social Media Matches',         '#5B2D8E', matches.social.length,      socialTable(matches.social))}

<div class="footer">
  <span>Cyber Nexus — Trademark & Brand Monitor</span>
  <span>Generated ${new Date().toISOString()}</span>
</div>

</body>
</html>`;
}

async function generatePDF({ keywords, dateFrom, dateTo, status }) {
  const matches = await fetchMatches({ keywords, dateFrom, dateTo, status });
  const html = buildHtml({ matches, keywords, dateFrom, dateTo });

  let browser;
  const isProduction = !!process.env.RENDER;

    if (isProduction) {
    const chromium      = require('@sparticuz/chromium');
    const puppeteerCore = require('puppeteer-core');
    browser = await puppeteerCore.launch({
      args:            chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath:  chromium.executablePath,
      headless:        chromium.headless,
    });
  } else {
    const { default: puppeteerExtra } = await import('puppeteer-extra');
    const { default: StealthPlugin }  = await import('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
    browser = await puppeteerExtra.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' },
    });
    return pdf;
  } finally {
    await browser.close();
  }
}

module.exports = { generatePDF };
