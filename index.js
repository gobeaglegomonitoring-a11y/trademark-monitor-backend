require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

// CORS and JSON must come FIRST before any routes
app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://trademark-monitor-frontend.vercel.app",
    "https://trade-mark-frontend.vercel.app",
    "https://gobeaglego.com",
    "https://www.gobeaglego.com",
    process.env.FRONTEND_URL,
  ].filter(Boolean),
}));
app.use(express.json());

// Root
app.get('/', (req, res) => {
  res.json({
    name: 'Trademark Monitor API',
    status: 'ok',
    version: '1.0.0',
    endpoints: ['/health', '/api/keywords', '/api/matches'],
  });
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/keywords', require('./routes/keywords'));
app.use('/api/matches', require('./routes/matches'));
app.use('/api/scan-logs', require('./routes/scanLogs'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/scan',    require('./routes/scan'));
// Test endpoints
const { runEUIPOScraper } = require("./scrapers/euipoScraper");
app.get("/api/test-euipo", async (req, res) => {
  await runEUIPOScraper();
  res.json({ message: "EUIPO scan complete. Check trademark_matches in Supabase." });
});

const { runUSPTOScraper } = require("./scrapers/usptoScraper");
app.get("/api/test-uspto", async (req, res) => {
  const total = await runUSPTOScraper();
  res.json({ message: `USPTO scan complete. ${total} new match(es) found.` });
});

const { runIPAustraliaScraper } = require("./scrapers/ipAustraliaScraper");
app.get("/api/test-ipau", async (req, res) => {
  const total = await runIPAustraliaScraper();
  res.json({ message: `IP Australia scan complete. ${total} new match(es) found.` });
});

const { runIPONZScraper } = require("./scrapers/iponzScraper");
app.get("/api/test-iponz", async (req, res) => {
  const total = await runIPONZScraper();
  res.json({ message: `IPONZ scan complete. ${total} new match(es) found.` });
});

const { runUKIPOScraper } = require("./scrapers/ukipoScraper");
app.get("/api/test-ukipo", async (req, res) => {
  const total = await runUKIPOScraper();
  res.json({ message: `UKIPO scan complete. ${total} new match(es) found.` });
});

const { runCIPOScraper } = require("./scrapers/cipoScraper");
app.get("/api/test-cipo", async (req, res) => {
  const total = await runCIPOScraper();
  res.json({ message: `CIPO scan complete. ${total} new match(es) found.` });
});

const { runUSStateScraper, getUnsupportedStates } = require("./scrapers/usStateScraper");
app.get("/api/test-us-states", async (req, res) => {
  const total = await runUSStateScraper();
  res.json({ message: `US States scan complete. ${total} new match(es) found.` });
});

const { runUSStateScraper: runUSStatesScraperV1 } = require("./scrapers/usStateScraper");
app.get("/api/test-us-states-v1", async (req, res) => {
  const total = await runUSStatesScraperV1();
  res.json({ message: `US States (v1) scan complete. ${total} new match(es) found.` });
});

app.get("/api/test-us-states-v1/:code", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  try {
    const total = await runUSStatesScraperV1(code);
    res.json({ message: `US-${code} scan complete. ${total} new match(es) found.` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/us-state-gaps", (req, res) => {
  res.json(getUnsupportedStates());
});

const { runDomainScraper } = require("./scrapers/domainScraper");
app.get("/api/test-domains", async (req, res) => {
  const total = await runDomainScraper();
  res.json({ message: `Domain scan complete. ${total} registered typo domain(s) found.` });
});

const { runMarketplaceScraper } = require("./scrapers/marketplaceScraper");
app.get("/api/test-marketplace", async (req, res) => {
  const total = await runMarketplaceScraper();
  res.json({ message: `Marketplace scan complete. ${total} new listing(s) found.` });
});

const { runSocialScraper } = require("./scrapers/socialScraper");
app.get("/api/test-social", async (req, res) => {
  const total = await runSocialScraper();
  res.json({ message: `Social scan complete. ${total} new match(es) found.` });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
const { sendAlertIfNewMatches } = require("./services/emailAlert");
app.get("/api/test-email-alert", async (req, res) => {
  const result = await sendAlertIfNewMatches();
  res.json(result);
});
