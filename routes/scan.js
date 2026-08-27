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

// Generates the PDF report from current DB state and emails it. `sinceIso`
// controls the "new since" window used for the match-count breakdown --
// pass a scan's own start time when called right after that scan, or fall
// back to last_alerted_at (or 24h ago) for a standalone, decoupled send.
async function sendReportEmail(sinceIso, scanErrors = {}) {
  const { data: settings, error: settingsError } = await supabase
    .from('alert_settings')
    .select('email, alert_enabled, last_alerted_at')
    .eq('id', SETTINGS_ID)
    .maybeSingle();
  if (settingsError) throw settingsError;

  if (!settings?.alert_enabled || !settings?.email) {
    console.log('[REPORT] Not sent - alerts are disabled or no recipient is configured');
    return;
  }

  const iso = sinceIso || settings.last_alerted_at || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
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

  const preMem = process.memoryUsage();
  console.log(`[REPORT] Starting PDF generation. Memory before: rss=${(preMem.rss / 1048576).toFixed(0)}MB heapUsed=${(preMem.heapUsed / 1048576).toFixed(0)}MB.`);

  const pdf = await generatePDF({ status: null, scanStartedAt: iso });
  console.log(`[REPORT] PDF generated successfully (${pdf.length} bytes).`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `trademark-monitor-report-${stamp}.pdf`;
  console.log(`[REPORT] Starting email send to ${settings.email}...`);
  await sendScheduledScanReport({
    to: settings.email,
    pdf,
    filename,
    matchCount,
    breakdown,
    scanErrors,
    scanTime: new Date().toUTCString().replace(' GMT', ''),
  });
  console.log('[REPORT] Email sent successfully.');

  await supabase
    .from('alert_settings')
    .update({ last_alerted_at: new Date().toISOString() })
    .eq('id', SETTINGS_ID);
  console.log(`[REPORT] Sent to ${settings.email} - ${matchCount} new matches`);
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
    await sendReportEmail(scanStartTime.toISOString(), errors);
  } catch (reportErr) {
    // Reporting must never prevent the completed scan results from being retained.
    console.error('[SCAN] PDF report error:', reportErr.message);
    console.error('[SCAN] PDF report error stack:', reportErr.stack);
  }

  console.log('[SCAN] All scrapers finished. Results:', results, 'Errors:', errors);
  scanState = { ...scanState, running: false, finishedAt: new Date().toISOString() };
});

// POST /api/scan/send-report
// Sends the report email right now, using whatever is currently in the
// database -- does NOT run any scrapers. Used to guarantee the client's
// report arrives at an exact clock time, decoupled from however long the
// scan (started earlier, as a head start) actually took to finish.
// Requires header: x-scan-api-key: <SCAN_API_KEY>
router.post('/send-report', async (req, res) => {
  const apiKey = req.headers['x-scan-api-key'];
  if (!apiKey || apiKey !== process.env.SCAN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.status(202).json({ status: 'sending' });
  try {
    await sendReportEmail(null, {});
  } catch (err) {
    console.error('[REPORT] send-report error:', err.message);
    console.error('[REPORT] send-report error stack:', err.stack);
  }
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

// POST /api/scan/stop/:key
// Asks a running scraper (matched by its Scan Control card key, e.g. "euipo",
// "marketplace", "us-states-v1") to stop at its next safe checkpoint. Not a
// hard kill -- the scraper finishes its current item/state and returns
// whatever it found so far.
const { requestStop } = require('../lib/scanControl');
router.post('/stop/:key', (req, res) => {
  requestStop(req.params.key);
  res.json({ message: `Stop requested for "${req.params.key}"` });
});

module.exports = router;
