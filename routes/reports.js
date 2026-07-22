const express = require('express');
const router  = express.Router();
const { generatePDF } = require('../services/pdfGenerator');

// POST /api/reports/pdf
// Body (all optional): { keywords: [], dateFrom: "YYYY-MM-DD", dateTo: "YYYY-MM-DD", status: "new" }
router.post('/pdf', async (req, res) => {
  try {
    const { keywords, dateFrom, dateTo, status } = req.body || {};
    const reportStatus = status === 'all' ? null : (status || 'new');
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
