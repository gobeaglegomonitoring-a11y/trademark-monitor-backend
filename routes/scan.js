const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { sendScheduledScanReport } = require('../lib/mailer');
const { generatePDF } = require('../services/pdfGenerator');

const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_SCRAPER_TIMEOUT_MS = 25 * 60 * 1000;

function runWithTimeout(scraper) {
  const timeoutMs = scraper.timeoutMs || DEFAULT_SCRAPER_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${scraper.name} exceeded ${Math.round(timeoutMs / 60000)} minute limit`)), timeoutMs);
  });
  return Promise.race([scraper.fn(), timeout]).finally(() => clearTimeout(timer));
}

// POST /api/scan/runall
// Called by the scheduled GitHub Actions workflow three times per day.
// Requires header: x-scan-api-key: <SCAN_API_KEY>
router.post('/runall', async (req, res) => {
  const apiKey = req.headers['x-scan-api-key'];
  if (!apiKey || apiKey !== process.env.SCAN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Respond immediately so the workflow does not time out while scans run.
  res.status(202).json({ status: 'started', timestamp: new Date().toISOString() });

  const scanStartTime = new Date();
  const results = {};
  const errors = {};
  const scrapers = [
    { name: 'uspto', fn: () => require('../scrapers/usptoScraper').runUSPTOScraper() },
    { name: 'euipo', fn: () => require('../scrapers/euipoScraper').runEUIPOScraper() },
    { name: 'ipau', fn: () => require('../scrapers/ipAustraliaScraper').runIPAustraliaScraper() },
    { name: 'iponz', fn: () => require('../scrapers/iponzScraper').runIPONZScraper() },
    { name: 'ukipo', fn: () => require('../scrapers/ukipoScraper').runUKIPOScraper() },
    { name: 'cipo', fn: () => require('../scrapers/cipoScraper').runCIPOScraper() },
    { name: 'us_states', timeoutMs: 30 * 60 * 1000, fn: () => require('../scrapers/usStateScraper').runUSStateScraper() },
    { name: 'domains', fn: () => require('../scrapers/domainScraper').runDomainScraper() },
    { name: 'marketplace', fn: () => require('../scrapers/marketplaceScraper').runMarketplaceScraper() },
    { name: 'social', fn: () => require('../scrapers/socialScraper').runSocialScraper() },
  ];

  console.log(`[SCAN] Scheduled scan started at ${scanStartTime.toISOString()}`);
  for (const scraper of scrapers) {
    try {
      const count = await runWithTimeout(scraper);
      results[scraper.name] = count ?? 'done';
      console.log(`[SCAN] ${scraper.name}: ${count ?? 'done'}`);
    } catch (err) {
      errors[scraper.name] = err.message;
      console.error(`[SCAN] ${scraper.name} error:`, err.message);
    }
  }
  console.log(`[SCAN] Scheduled scan complete at ${new Date().toISOString()}`);

  try {
    const { data: settings, error: settingsError } = await supabase
      .from('alert_settings')
      .select('email, alert_enabled')
      .eq('id', SETTINGS_ID)
      .maybeSingle();
    if (settingsError) throw settingsError;

    if (settings?.alert_enabled && settings?.email) {
      const iso = scanStartTime.toISOString();
      const [tm, dm, mm, sm] = await Promise.all([
        supabase.from('trademark_matches').select('id', { count: 'exact', head: true }).gte('created_at', iso),
        supabase.from('domain_matches').select('id', { count: 'exact', head: true }).gte('created_at', iso),
        supabase.from('marketplace_matches').select('id', { count: 'exact', head: true }).gte('created_at', iso),
        supabase.from('social_matches').select('id', { count: 'exact', head: true }).gte('created_at', iso),
      ]);
      const breakdown = {
        'Trademark Registries': tm.count || 0,
        Domains: dm.count || 0,
        Marketplaces: mm.count || 0,
        'Social Media': sm.count || 0,
      };
      const matchCount = Object.values(breakdown).reduce((total, count) => total + count, 0);

      // Include all statuses and mark records inserted during this scan as highest priority.
      const pdf = await generatePDF({ status: null, scanStartedAt: iso });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `trademark-monitor-report-${stamp}.pdf`;
      await sendScheduledScanReport({
        to: settings.email,
        pdf,
        filename,
        matchCount,
        breakdown,
        scanErrors: errors,
        scanTime: new Date().toUTCString().replace(' GMT', ''),
      });

      await supabase
        .from('alert_settings')
        .update({ last_alerted_at: new Date().toISOString() })
        .eq('id', SETTINGS_ID);
      console.log(`[SCAN] PDF report sent to ${settings.email} - ${matchCount} new matches`);
    } else {
      console.log('[SCAN] PDF report not sent - alerts are disabled or no recipient is configured');
    }
  } catch (reportErr) {
    // Reporting must never prevent the completed scan results from being retained.
    console.error('[SCAN] PDF report error:', reportErr.message);
  }

  console.log('[SCAN] All scrapers finished. Results:', results, 'Errors:', errors);
});

module.exports = router;
