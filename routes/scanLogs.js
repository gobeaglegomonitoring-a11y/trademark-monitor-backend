const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// GET /api/scan-logs?limit=50
router.get('/', async (req, res) => {
  const parsedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 200)
    : 50;

  try {
    const { data, error } = await supabase
      .from('scan_logs')
      .select('id, scan_type, started_at, completed_at, total_found, error_log')
      .order('started_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('[GET /api/scan-logs] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
