const dns = require('dns').promises;
const supabase = require('../lib/supabase');

const TLDS = ['.com', '.net', '.co', '.io'];

function generateTypos(keyword) {
  const kw = keyword.toLowerCase().replace(/\s+/g, '');
  const domains = new Set();

  // Original across all TLDs
  TLDS.forEach(tld => domains.add(kw + tld));

  // Missing one letter
  for (let i = 0; i < kw.length; i++) {
    const typo = kw.slice(0, i) + kw.slice(i + 1);
    if (typo.length >= 2) TLDS.forEach(tld => domains.add(typo + tld));
  }

  // Extra letter (double each char)
  for (let i = 0; i < kw.length; i++) {
    const typo = kw.slice(0, i) + kw[i] + kw[i] + kw.slice(i + 1);
    TLDS.forEach(tld => domains.add(typo + tld));
  }

  // Adjacent character swap
  for (let i = 0; i < kw.length - 1; i++) {
    const arr = kw.split('');
    [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
    const typo = arr.join('');
    if (typo !== kw) TLDS.forEach(tld => domains.add(typo + tld));
  }

  return [...domains];
}

async function isDomainRegistered(domain) {
  try {
    await dns.lookup(domain);
    return true;
  } catch {
    return false;
  }
}

async function insertIfNew(keyword, domain) {
  const { data: ex } = await supabase
    .from('domain_matches')
    .select('id')
    .eq('keyword_matched', keyword)
    .eq('domain', domain)
    .limit(1);
  if (ex && ex.length > 0) return false;

  await supabase.from('domain_matches').insert({
    keyword_matched: keyword,
    domain,
    status: 'new',
    created_at: new Date().toISOString(),
  });
  return true;
}

async function runDomainScraper() {
  console.log('[DOMAINS] Starting domain typo scan (DNS mode)...');

  const { data: keywords } = await supabase
    .from('keywords').select('term').eq('active', true);
  if (!keywords?.length) { console.log('[DOMAINS] No active keywords.'); return 0; }

  const { data: logEntry } = await supabase
    .from('scan_logs')
    .insert([{ scan_type: 'domain', started_at: new Date().toISOString() }])
    .select().single();
  const logId = logEntry?.id;

  let totalFound = 0;
  let errorLog = null;

  for (const kw of keywords) {
    const typos = generateTypos(kw.term);
    console.log(`[DOMAINS] "${kw.term}" → ${typos.length} domain variants to check`);

    for (const domain of typos) {
      try {
        const registered = await isDomainRegistered(domain);
        if (registered) {
          const inserted = await insertIfNew(kw.term, domain);
          if (inserted) {
            totalFound++;
            console.log(`[DOMAINS] REGISTERED: ${domain} (keyword: ${kw.term})`);
          }
        }
      } catch (err) {
        errorLog = err.message;
      }

      await new Promise(r => setTimeout(r, 100));
    }
  }

  if (logId) {
    await supabase.from('scan_logs').update({
      completed_at: new Date().toISOString(),
      total_found: totalFound,
      error_log: errorLog,
    }).eq('id', logId);
  }

  console.log(`[DOMAINS] Done. ${totalFound} registered typo domain(s) found.`);
  return totalFound;
}

module.exports = { runDomainScraper, generateTypos };
