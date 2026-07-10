const express  = require('express');
const router   = express.Router();
const supabase = require('../lib/supabase');
const { sendNewMatchesAlert } = require('../lib/mailer');

const SETTINGS_ID = "00000000-0000-0000-0000-000000000001";

// POST /api/scan/runall
// Called by GitHub Actions daily cron job at midnight UTC
// Requires header: x-scan-api-key: <SCAN_API_KEY>
router.post('/runall', async (req, res) => {
  const apiKey = req.headers['x-scan-api-key'];
  if (!apiKey || apiKey !== process.env.SCAN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const scanStartTime = new Date();
  const results = {};
  const errors  = {};

  const scrapers = [
    { name: 'uspto',       fn: () => require('../scrapers/usptoScraper').runUSPTOScraper() },
    { name: 'euipo',       fn: () => require('../scrapers/euipoScraper').runEUIPOScraper() },
    { name: 'ipau',        fn: () => require('../scrapers/ipAustraliaScraper').runIPAustraliaScraper() },
    { name: 'iponz',       fn: () => require('../scrapers/iponzScraper').runIPONZScraper() },
    { name: 'ukipo',       fn: () => require('../scrapers/ukipoScraper').runUKIPOScraper() },
    { name: 'cipo',        fn: () => require('../scrapers/cipoScraper').runCIPOScraper() },
    { name: 'us_states',   fn: () => require('../scrapers/usStateScraper').runUSStateScraper() },
    { name: 'domains',     fn: () => require('../scrapers/domainScraper').runDomainScraper() },
    { name: 'marketplace', fn: () => require('../scrapers/marketplaceScraper').runMarketplaceScraper() },
    { name: 'social',      fn: () => require('../scrapers/socialScraper').runSocialScraper() },
  ];

  console.log(`[SCAN] Daily scan started at ${scanStartTime.toISOString()}`);

  for (const scraper of scrapers) {
    try {
      const count = await scraper.fn();
      results[scraper.name] = count ?? 'done';
      console.log(`[SCAN] ${scraper.name}: ${count ?? 'done'}`);
    } catch (err) {
      errors[scraper.name] = err.message;
      console.error(`[SCAN] ${scraper.name} error:`, err.message);
    }
  }

  console.log(`[SCAN] Daily scan complete at ${new Date().toISOString()}`);

  // ── Send email alert if new matches were found ────────────────────────────
  try {
    const { data: settings } = await supabase
      .from('alert_settings')
      .select('email, alert_enabled')
      .eq('id', SETTINGS_ID)
      .maybeSingle();

    if (settings?.alert_enabled && settings?.email) {
      const iso = scanStartTime.toISOString();

      // Count new matches inserted during this scan across all match tables
      const [tm, dm, mm, sm] = await Promise.all([
        supabase.from('trademark_matches').select('id', { count: 'exact', head: true }).gte('created_at', iso),
        supabase.from('domain_matches').select('id',    { count: 'exact', head: true }).gte('created_at', iso),
        supabase.from('marketplace_matches').select('id', { count: 'exact', head: true }).gte('created_at', iso),
        supabase.from('social_matches').select('id',    { count: 'exact', head: true }).gte('created_at', iso),
      ]);

      const breakdown = {
        'Trademark Registries': tm.count || 0,
        'Domains':              dm.count || 0,
        'Marketplaces':         mm.count || 0,
        'Social Media':         sm.count || 0,
      };

      const matchCount = Object.values(breakdown).reduce((a, b) => a + b, 0);

      if (matchCount > 0) {
        await sendNewMatchesAlert({
          to:         settings.email,
          matchCount,
          breakdown,
          scanTime:   new Date().toUTCString().replace(' GMT', ''),
        });

        await supabase
          .from('alert_settings')
          .update({ last_alerted_at: new Date().toISOString() })
          .eq('id', SETTINGS_ID);

        console.log(`[SCAN] Alert sent to ${settings.email} — ${matchCount} new matches`);
      } else {
        console.log('[SCAN] No new matches this scan — no alert sent');
      }
    }
  } catch (alertErr) {
    console.error('[SCAN] Alert error:', alertErr.message);
  }

  res.json({
    status: 'complete',
    timestamp: new Date().toISOString(),
    results,
    errors,
  });
});

module.exports = router;
