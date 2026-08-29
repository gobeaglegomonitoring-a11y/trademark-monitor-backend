const dns = require('dns').promises;
const axios = require('axios');
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

// RDAP (WHOIS's modern, HTTP-based replacement -- ICANN-mandated since 2019)
// via the public rdap.org bootstrap, which redirects to the right registry
// for any TLD. Most registrants are privacy-redacted since GDPR, but the
// registrar's abuse contact (who to send a takedown complaint to) is
// required by ICANN to stay public, so that's the actionable fallback when
// the registrant itself is hidden.
function vcardField(vcard, name) {
  if (!Array.isArray(vcard)) return null;
  const field = vcard.find(f => f[0] === name);
  return field ? field[3] : null;
}

function vcardAddress(vcard) {
  const adr = vcardField(vcard, 'adr');
  if (!Array.isArray(adr)) return null;
  // RDAP adr array: [pobox, ext, street, city, region, postcode, country]
  return adr.filter(Boolean).join(', ') || null;
}

function describeEntity(entity, label) {
  if (!entity) return null;
  const vcard = entity.vcardArray?.[1];
  const name = vcardField(vcard, 'fn') || vcardField(vcard, 'org');
  const address = vcardAddress(vcard);
  const phone = (vcardField(vcard, 'tel') || '').replace(/^tel:/, '');
  const email = vcardField(vcard, 'email');
  const abuse = (entity.entities || []).find(e => (e.roles || []).includes('abuse'));
  const abuseVcard = abuse?.vcardArray?.[1];
  const abusePhone = (vcardField(abuseVcard, 'tel') || '').replace(/^tel:/, '');
  const abuseEmail = vcardField(abuseVcard, 'email');

  const parts = [];
  if (name) parts.push(name);
  if (address) parts.push(address);
  if (phone) parts.push(`Tel: ${phone}`);
  if (email) parts.push(`Email: ${email}`);
  if (abusePhone || abuseEmail) {
    parts.push(`Abuse contact: ${[abusePhone, abuseEmail].filter(Boolean).join(', ')}`);
  }
  return parts.length ? `${label}: ${parts.join(' | ')}` : null;
}

async function lookupRegistrant(domain) {
  try {
    const { data } = await axios.get(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      timeout: 8000,
      headers: { Accept: 'application/rdap+json' },
    });

    const entities = Array.isArray(data.entities) ? data.entities : [];
    const findByRole = (role) => entities.find(e => Array.isArray(e.roles) && e.roles.includes(role));

    const registrantDesc = describeEntity(findByRole('registrant'), 'Registrant');
    const registrarDesc = describeEntity(findByRole('registrar'), 'Registrar');

    if (registrantDesc) return registrarDesc ? `${registrantDesc} || ${registrarDesc}` : registrantDesc;
    if (registrarDesc) return `Registrant private -- ${registrarDesc}`;
    return 'Registrant information not available';
  } catch (err) {
    console.warn(`[DOMAINS] RDAP lookup failed for ${domain}: ${err.message}`);
    return null;
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

  const registrantInfo = await lookupRegistrant(domain);

  await supabase.from('domain_matches').insert({
    keyword_matched: keyword,
    domain,
    registrant_info: registrantInfo,
    status: 'new',
    created_at: new Date().toISOString(),
  });
  return true;
}

async function runDomainScraper() {
  const { shouldStop, clearStop } = require('../lib/scanControl');
  clearStop('domains');
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
    if (shouldStop('domains')) {
      console.log('[DOMAINS] Stop requested — ending scan early.');
      errorLog = 'Stopped by user';
      break;
    }
    const typos = generateTypos(kw.term);
    console.log(`[DOMAINS] "${kw.term}" → ${typos.length} domain variants to check`);

    for (const domain of typos) {
      if (shouldStop('domains')) {
        console.log('[DOMAINS] Stop requested — ending scan early.');
        errorLog = 'Stopped by user';
        break;
      }
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

module.exports = { runDomainScraper, generateTypos, lookupRegistrant };
