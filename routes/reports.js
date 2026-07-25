const express = require('express');
const router  = express.Router();
const { generatePDF, countMatches } = require('../services/pdfGenerator');

// generatePDF() itself now caps how many rows any single report section
// renders (see MAX_ROWS_PER_SECTION in pdfGenerator.js), so it stays fast
// and safe no matter how large the underlying dataset is -- this is just a
// sanity ceiling against a truly unbounded/abusive request, not the primary
// safeguard anymore.
const SANITY_MAX_PDF_ROWS = 50000;

// POST /api/reports/pdf
// Body (all optional): { keywords: [], dateFrom: "YYYY-MM-DD", dateTo: "YYYY-MM-DD", status: "new" }
router.post('/pdf', async (req, res) => {
  try {
    const { keywords, dateFrom, dateTo, status } = req.body || {};
    const reportStatus = status === 'all' ? null : (status || 'new');

    const rowCount = await countMatches({ keywords, dateFrom, dateTo, status: reportStatus });
    if (rowCount > SANITY_MAX_PDF_ROWS) {
      return res.status(400).json({
        error: 'Too many matches for one report',
        detail: `This selection has ${rowCount} matches. Narrow the filters -- e.g. a date range or a single keyword -- and try again.`,
        rowCount,
        limit: SANITY_MAX_PDF_ROWS,
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
