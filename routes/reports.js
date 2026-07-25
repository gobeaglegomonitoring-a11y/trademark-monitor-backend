const express = require('express');
const router  = express.Router();
const { generatePDF, countMatches } = require('../services/pdfGenerator');

// A large unfiltered export has been observed to hang Puppeteer long enough
// that Render kills the whole backend process -- this takes the live site
// down for every user, not just the one requesting the export.
const MAX_PDF_ROWS = 500;

// POST /api/reports/pdf
// Body (all optional): { keywords: [], dateFrom: "YYYY-MM-DD", dateTo: "YYYY-MM-DD", status: "new" }
router.post('/pdf', async (req, res) => {
  try {
    const { keywords, dateFrom, dateTo, status } = req.body || {};
    const reportStatus = status === 'all' ? null : (status || 'new');

    const rowCount = await countMatches({ keywords, dateFrom, dateTo, status: reportStatus });
    if (rowCount > MAX_PDF_ROWS) {
      return res.status(400).json({
        error: 'Too many matches for one report',
        detail: `This selection has ${rowCount} matches, which would generate a report too large to render safely (limit: ${MAX_PDF_ROWS}). Narrow the filters -- e.g. a date range, a single keyword, or Status = New -- and try again.`,
        rowCount,
        limit: MAX_PDF_ROWS,
      });
    }

    const pdf = await generatePDF({ keywords, dateFrom, dateTo, status: reportStatus });

    const filename = `trademark-report-${new Date().toISOString().slice(0, 10)}.pdf`;
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      pdf.length,
    });
    res.end(pdf);
  } catch (err) {
    console.error('[PDF] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate PDF', detail: err.message });
  }
});

module.exports = router;
