const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { sendScheduledScanReport } = require('../lib/mailer');
const { generatePDF } = require('../services/pdfGenerator');

const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_SCRAPER_TIMEOUT_MS = 25 * 60 * 1000;
let scanState = { running: false, startedAt: null, finishedAt: null };

async function runWithTimeout(scraper) {
  const timeoutMs = scraper.timeoutMs || DEFAULT_SCRAPER_TIMEOUT_MS;
  const startedAt = new Date().toISOString();
  let timer;
  let failure = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${scraper.name} exceeded ${Math.round(timeoutMs / 60000)} minute limit`)), timeoutMs);
  });
  try {
    return await Promise.race([scraper.fn(), timeout]);
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    clearTimeout(timer);
    // Scheduler-level safety net: regardless of scraper implementation, every
    // log created by this scanner reaches a terminal state before moving on.
    const { data: unfinished, error: selectError } = await supabase
      .from('scan_logs')
      .select('id, error_log')
      .gte('started_at', startedAt)
      .is('completed_at', null);
    if (selectError) {
      console.error(`[SCAN] ${scraper.name} log-finalizer query failed:`, selectError.message);
    } else {
      for (const log of unfinished || []) {
        const { error: updateError } = await supabase.from('scan_logs').update({
          completed_at: new Date().toISOString(),
          error_log: log.error_log || failure?.message || 'Scanner returned without finalizing its log',
        }).eq('id', log.id);
        if (updateError) console.error(`[SCAN] ${scraper.name} log-finalizer update failed:`, updateError.message);
      }
    }
  }
}

// POST /api/scan/runall
// Called by the scheduled GitHub Actions workflow three times per day.
// Requires header: x-scan-api-key: <SCAN_API_KEY>
router.post('/runall', async (req, res) => {
  const apiKey = req.headers['x-scan-api-key'];
  if (!apiKey || apiKey !== process.env.SCAN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (scanState.running) {
    return res.status(409).json({ error: 'A scheduled scan is already running', ...scanState });
  }

  const scanStartTime = new Date();
  scanState = { running: true, startedAt: scanStartTime.toISOString(), finishedAt: null };
  // Respond immediately so the workflow does not time out while scans run.
  res.status(202).json({ status: 'started', timestamp: scanState.startedAt });

  const results = {};
  const errors = {};
  const scrapers = [
    { name: 'uspto', fn: () => require('../scrapers/usptoScraper').runUSPTOScraper() },
    { name: 'euipo', fn: () => require('../scrapers/euipoScraper').runEUIPOScraper() },
    { name: 'ipau', fn: () => require('../scrapers/ipAustraliaScraper').runIPAustraliaScraper() },
    { name: 'iponz', fn: () => require('../scrapers/iponzScraper').runIPONZScraper() },
    { name: 'ukipo', fn: () => require('../scrapers/ukipoScraper').runUKIPOScraper() },
    { name: 'cipo', fn: () => require('../scrapers/cipoScraper').runCIPOScraper() },
    { name: 'domains', fn: () => require('../scrapers/domainScraper').runDomainScraper() },
    { name: 'marketplace', fn: () => require('../scrapers/marketplaceScraper').runMarketplaceScraper() },
    { name: 'social', fn: () => require('../scrapers/socialScraper').runSocialScraper() },
    { name: 'us_states', timeoutMs: 95 * 60 * 1000, fn: () => require('../scrapers/usStateScraper').runUSStateScraper() },
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
  scanState = { ...scanState, running: false, finishedAt: new Date().toISOString() };
});

// GitHub Actions polls this endpoint to keep free Render services awake until
// scanning and PDF/email reporting have both completed.
router.get('/status', (req, res) => {
  const apiKey = req.headers['x-scan-api-key'];
  if (!apiKey || apiKey !== process.env.SCAN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json(scanState);
});

module.exports = router;
