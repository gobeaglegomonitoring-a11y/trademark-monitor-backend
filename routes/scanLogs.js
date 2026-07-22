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
    // Any process restart can strand an unfinished row. Finalize all stale
    // scraper logs so the UI never presents abandoned work as still running.
    const staleBefore = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: staleRows, error: staleError } = await supabase
      .from('scan_logs')
      .select('id, error_log')
      .is('completed_at', null)
      .lt('started_at', staleBefore);
    if (staleError) throw staleError;
    for (const row of staleRows || []) {
      const { error: updateError } = await supabase.from('scan_logs').update({
        completed_at: new Date().toISOString(),
        error_log: row.error_log
          ? `${row.error_log} | Abandoned: backend stopped before scan completion`
          : 'Abandoned: backend stopped before scan completion',
      }).eq('id', row.id);
      if (updateError) throw updateError;
    }

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
