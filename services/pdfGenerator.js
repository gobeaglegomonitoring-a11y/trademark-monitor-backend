const supabase = require('../lib/supabase');

async function fetchMatches({ keywords, dateFrom, dateTo, status }) {
  const fetchAll = async (table, columns, kwCol) => {
    const pageSize = 1000;
    const rows = [];
    let offset = 0;

    while (true) {
      let query = supabase.from(table).select(columns);
    if (keywords && keywords.length > 0) {
      query = query.in(kwCol, keywords);
    }
    if (dateFrom) query = query.gte('created_at', dateFrom);
    if (dateTo)   query = query.lte('created_at', dateTo + 'T23:59:59');
    if (status)   query = query.eq('status', status);
      const { data, error } = await query
        .order('created_at', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
      offset += pageSize;
    }
    return rows;
  };

  const [tm, dm, mm, sm] = await Promise.all([
    fetchAll('trademark_matches', 'matched_keyword, filing_name, registry, owner_name, similarity_score, status, created_at', 'matched_keyword'),
    fetchAll('domain_matches', 'keyword_matched, domain, registrant_info, status, created_at', 'keyword_matched'),
    fetchAll('marketplace_matches', 'keyword_matched, platform, listing_title, listing_url, seller_name, status, created_at', 'keyword_matched'),
    fetchAll('social_matches', 'keyword_matched, platform, handle_or_url, status, created_at', 'keyword_matched'),
  ]);

  return {
    trademark: tm,
    domain: dm,
    marketplace: mm,
    social: sm,
  };
}

// Cheap pre-check before paying for a full fetch + Puppeteer render. A large
// unfiltered export (thousands of rows -> 100+ page PDF) has been observed
// to hang Puppeteer long enough that Render kills the whole backend process,
// taking the live site down for everyone, not just the exporting request.
async function countMatches({ keywords, dateFrom, dateTo, status }) {
  const tables = [
    { table: 'trademark_matches',   kwCol: 'matched_keyword' },
    { table: 'domain_matches',      kwCol: 'keyword_matched' },
    { table: 'marketplace_matches', kwCol: 'keyword_matched' },
    { table: 'social_matches',      kwCol: 'keyword_matched' },
  ];

  const counts = await Promise.all(tables.map(({ table, kwCol }) => {
    let query = supabase.from(table).select('id', { count: 'exact', head: true });
    if (keywords && keywords.length > 0) query = query.in(kwCol, keywords);
    if (dateFrom) query = query.gte('created_at', dateFrom);
    if (dateTo)   query = query.lte('created_at', dateTo + 'T23:59:59');
    if (status)   query = query.eq('status', status);
    return query;
  }));

  return counts.reduce((total, { count, error }) => {
    if (error) throw new Error(error.message);
    return total + (count || 0);
  }, 0);
}

async function fetchMonitoredKeywords() {
  const { data, error } = await supabase
    .from('keywords')
    .select('term, active, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

function fmt(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function h(value) {
  return String(value ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

// Bounds how many rows any single table renders, regardless of how large the
// underlying dataset grows. Puppeteer rendering thousands of rows into a
// 100+ page PDF has been observed to hang long enough that Render kills the
// whole backend process -- this keeps every report (scheduled or on-demand)
// fast and safe no matter how much data exists, instead of only protecting
// the on-demand endpoint behind a reject-if-too-big check.
const MAX_ROWS_PER_SECTION = 300;

function capRows(rows) {
  if (rows.length <= MAX_ROWS_PER_SECTION) return { shown: rows, note: '' };
  return {
    shown: rows.slice(0, MAX_ROWS_PER_SECTION),
    note: `<p class="truncate-note">Showing the most recent ${MAX_ROWS_PER_SECTION} of ${rows.length} — export with a narrower date range or keyword for full detail.</p>`,
  };
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

function attentionTable(matches, scanStartedAt) {
  const rows = [
    ...matches.trademark.map(r => ({
      keyword: r.matched_keyword, source: r.registry || 'Trademark', item: r.filing_name, owner: r.owner_name,
      status: r.status, date: r.created_at, score: r.similarity_score,
    })),
    ...matches.domain.map(r => ({
      keyword: r.keyword_matched, source: 'Domain', item: r.domain, owner: r.registrant_info,
      status: r.status, date: r.created_at,
    })),
    ...matches.marketplace.map(r => ({
      keyword: r.keyword_matched, source: r.platform || 'Marketplace', item: r.listing_title, owner: r.seller_name,
      status: r.status, date: r.created_at,
    })),
    ...matches.social.map(r => ({
      keyword: r.keyword_matched, source: r.platform || 'Social', item: r.handle_or_url, owner: null,
      status: r.status, date: r.created_at,
    })),
  ]
    .filter(r => (r.status || 'new') === 'new')
    .sort((a, b) => {
      const aLatest = scanStartedAt && new Date(a.date) >= new Date(scanStartedAt) ? 1 : 0;
      const bLatest = scanStartedAt && new Date(b.date) >= new Date(scanStartedAt) ? 1 : 0;
      return bLatest - aLatest || (Number(b.score) || 0) - (Number(a.score) || 0) || new Date(b.date) - new Date(a.date);
    });

  if (!rows.length) {
    return '<div class="clear-message">No unresolved new matches currently require attention.</div>';
  }

  const { shown, note } = capRows(rows);
  const trs = shown.map(r => {
    const isLatest = scanStartedAt && new Date(r.date) >= new Date(scanStartedAt);
    const priority = isLatest ? 'New this scan' : Number(r.score) >= 0.9 ? 'Strong match' : 'Pending review';
    return `<tr>
      <td><span class="priority">${priority}</span></td>
      <td>${h(r.keyword)}</td><td>${h(r.source)}</td>
      <td class="long">${h(r.item)}</td><td class="long">${h(r.owner)}</td><td>${fmt(r.date)}</td>
    </tr>`;
  }).join('');

  return `<table><thead><tr>
    <th>Priority</th><th>Keyword</th><th>Source</th><th>Potential Match</th><th>Owner / Seller</th><th>Found</th>
  </tr></thead><tbody>${trs}</tbody></table>${note}`;
}

function keywordTable(monitoredKeywords) {
  if (!monitoredKeywords.length) return '<div class="clear-message">No monitored keywords configured.</div>';
  const trs = monitoredKeywords.map(k => `<tr>
    <td>${h(k.term)}</td>
    <td>${k.active ? '<span class="active">Active</span>' : '<span class="inactive">Inactive</span>'}</td>
    <td>${fmt(k.created_at)}</td>
  </tr>`).join('');
  return `<table><thead><tr><th>Monitored Keyword</th><th>Monitoring Status</th><th>Added</th></tr></thead><tbody>${trs}</tbody></table>`;
}

function trademarkTable(rows) {
  if (!rows.length) return '';
  const { shown, note } = capRows(rows);
  const trs = shown.map(r => `
    <tr>
      <td>${h(r.matched_keyword)}</td>
      <td>${h(r.filing_name)}</td>
      <td>${h(r.registry)}</td>
      <td>${h(r.owner_name)}</td>
      <td>${badge(r.status)}</td>
      <td>${fmt(r.created_at)}</td>
    </tr>`).join('');
  return `<table><thead><tr>
    <th>Keyword</th><th>Filing Name</th><th>Registry</th><th>Owner / Applicant</th><th>Status</th><th>Date</th>
  </tr></thead><tbody>${trs}</tbody></table>${note}`;
}

function domainTable(rows) {
  if (!rows.length) return '';
  const { shown, note } = capRows(rows);
  const trs = shown.map(r => `
    <tr>
      <td>${h(r.keyword_matched)}</td>
      <td>${h(r.domain)}</td>
      <td>${h(r.registrant_info)}</td>
      <td>${badge(r.status)}</td>
      <td>${fmt(r.created_at)}</td>
    </tr>`).join('');
  return `<table><thead><tr>
    <th>Keyword</th><th>Domain</th><th>Registrant</th><th>Status</th><th>Date</th>
  </tr></thead><tbody>${trs}</tbody></table>${note}`;
}

function marketplaceTable(rows) {
  if (!rows.length) return '';
  const { shown, note } = capRows(rows);
  const trs = shown.map(r => `
    <tr>
      <td>${h(r.keyword_matched)}</td>
      <td>${h(r.platform)}</td>
      <td class="long">${h(r.listing_title)}</td>
      <td>${h(r.seller_name)}</td>
      <td>${badge(r.status)}</td>
      <td>${fmt(r.created_at)}</td>
    </tr>`).join('');
  return `<table><thead><tr>
    <th>Keyword</th><th>Platform</th><th>Listing</th><th>Seller</th><th>Status</th><th>Date</th>
  </tr></thead><tbody>${trs}</tbody></table>${note}`;
}

function socialTable(rows) {
  if (!rows.length) return '';
  const { shown, note } = capRows(rows);
  const trs = shown.map(r => `
    <tr>
      <td>${h(r.keyword_matched)}</td>
      <td>${h(r.platform)}</td>
      <td>${h(r.handle_or_url)}</td>
      <td>${badge(r.status)}</td>
      <td>${fmt(r.created_at)}</td>
    </tr>`).join('');
  return `<table><thead><tr>
    <th>Keyword</th><th>Platform</th><th>Handle / URL</th><th>Status</th><th>Date</th>
  </tr></thead><tbody>${trs}</tbody></table>${note}`;
}

function buildHtml({ matches, keywords, dateFrom, dateTo, monitoredKeywords, scanStartedAt }) {
  const total = matches.trademark.length + matches.domain.length + matches.marketplace.length + matches.social.length;
  const allRows = [...matches.trademark, ...matches.domain, ...matches.marketplace, ...matches.social];
  const attentionCount = allRows.filter(r => (r.status || 'new') === 'new').length;
  const reviewedCount = allRows.filter(r => r.status === 'reviewed').length;
  const dismissedCount = allRows.filter(r => r.status === 'dismissed').length;
  const kwList = keywords && keywords.length ? h(keywords.join(', ')) : 'All active keywords';
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
  .attention { border: 2px solid #E3000F; border-radius: 8px; padding: 16px; margin-bottom: 30px; background: #FFF8F8; }
  .attention h2 { color: #B22222; font-size: 17px; margin-bottom: 5px; }
  .attention p { color: #666; font-size: 11px; margin-bottom: 12px; }
  .priority { background:#FDECEA; color:#B22222; padding:2px 7px; border-radius:9px; font-weight:bold; font-size:10px; white-space:nowrap; }
  .active { color:#1E7A4A; font-weight:bold; }
  .inactive { color:#888; font-weight:bold; }
  .clear-message { padding:14px; background:#F4F6F9; color:#555; border-radius:6px; }
  .truncate-note { padding:8px 4px; color:#888; font-size:11px; font-style:italic; }

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

<div class="summary">
  <div class="summary-card" style="background:#FDECEA"><div class="num" style="color:#B22222">${attentionCount}</div><div class="lbl" style="color:#B22222">Attention Required</div></div>
  <div class="summary-card" style="background:#D4EDDA"><div class="num" style="color:#1E7A4A">${reviewedCount}</div><div class="lbl" style="color:#1E7A4A">Reviewed</div></div>
  <div class="summary-card" style="background:#F4F6F9"><div class="num" style="color:#666">${dismissedCount}</div><div class="lbl" style="color:#666">Dismissed</div></div>
  <div class="summary-card" style="background:#E8EEF7"><div class="num" style="color:#1B2A4A">${monitoredKeywords.length}</div><div class="lbl" style="color:#1B2A4A">Monitored Keywords</div></div>
</div>

<div class="attention">
  <h2>Attention Required — Potential Matches</h2>
  <p>Unresolved monitoring alerts are prioritized below. They are potential matches requiring review, not confirmed legal threats.</p>
  ${attentionTable(matches, scanStartedAt)}
</div>

${section('Monitored Keywords', '#1B2A4A', monitoredKeywords.length, keywordTable(monitoredKeywords))}

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

async function generatePDF({ keywords, dateFrom, dateTo, status, scanStartedAt } = {}) {
  const [matches, monitoredKeywords] = await Promise.all([
    fetchMatches({ keywords, dateFrom, dateTo, status }),
    fetchMonitoredKeywords(),
  ]);
  const html = buildHtml({ matches, keywords, dateFrom, dateTo, monitoredKeywords, scanStartedAt });

  const { launchBrowser } = require('../lib/browser');
  const browser = await launchBrowser();

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

module.exports = { generatePDF, countMatches };
