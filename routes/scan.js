const express = require('express');
const router = express.Router();

// POST /api/scan/runall
// Called by GitHub Actions daily cron job at midnight UTC
// Requires header: x-scan-api-key: <SCAN_API_KEY>
router.post('/runall', async (req, res) => {
  const apiKey = req.headers['x-scan-api-key'];
  if (!apiKey || apiKey !== process.env.SCAN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = {};
  const errors = {};

  const scrapers = [
    { name: 'uspto',      fn: () => require('../scrapers/usptoScraper').runUSPTOScraper() },
    { name: 'euipo',      fn: () => require('../scrapers/euipoScraper').runEUIPOScraper() },
    { name: 'ipau',       fn: () => require('../scrapers/ipAustraliaScraper').runIPAustraliaScraper() },
    { name: 'iponz',      fn: () => require('../scrapers/iponzScraper').runIPONZScraper() },
    { name: 'ukipo',      fn: () => require('../scrapers/ukipoScraper').runUKIPOScraper() },
    { name: 'cipo',       fn: () => require('../scrapers/cipoScraper').runCIPOScraper() },
    { name: 'domains',    fn: () => require('../scrapers/domainScraper').runDomainScraper() },
    { name: 'marketplace',fn: () => require('../scrapers/marketplaceScraper').runMarketplaceScraper() },
    { name: 'social',     fn: () => require('../scrapers/socialScraper').runSocialScraper() },
  ];

  console.log(`[SCAN] Daily scan started at ${new Date().toISOString()}`);

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

  res.json({
    status: 'complete',
    timestamp: new Date().toISOString(),
    results,
    errors,
  });
});

module.exports = router;
