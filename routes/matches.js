const express = require("express");
const router = express.Router();
const supabase = require("../lib/supabase");

const TABLES = {
  trademark:   { table: "trademark_matches",   kwCol: "matched_keyword", nameCol: "filing_name",   sourceCol: "registry",  defaultSource: "Trademark"   },
  domain:      { table: "domain_matches",      kwCol: "keyword_matched", nameCol: "domain",        sourceCol: null,        defaultSource: "Domain"      },
  marketplace: { table: "marketplace_matches", kwCol: "keyword_matched", nameCol: "listing_title",  sourceCol: "platform",  defaultSource: "Marketplace" },
  social:      { table: "social_matches",      kwCol: "keyword_matched", nameCol: "handle_or_url",  sourceCol: "platform",  defaultSource: "Social"      },
};

function normalizeRow(category, cfg, r) {
  return {
    id:         r.id,
    source:     (cfg.sourceCol && r[cfg.sourceCol]) || cfg.defaultSource,
    category,
    keyword:    r[cfg.kwCol],
    match_name: r[cfg.nameCol],
    date_found: r.created_at,
    status:     r.status || "new",
  };
}

// Applies the same filter set to either a data query or a head-count query.
function applyFilters(query, cfg, { keyword, status, dateFrom, dateTo }) {
  if (keyword)  query = query.eq(cfg.kwCol, keyword);
  if (status)   query = query.eq("status", status);
  if (dateFrom) query = query.gte("created_at", dateFrom);
  if (dateTo)   query = query.lte("created_at", dateTo + "T23:59:59");
  return query;
}

function parseFilters(req) {
  const { keyword, status, dateFrom, dateTo } = req.query;
  return {
    keyword:  keyword && keyword !== "all" ? keyword : null,
    status:   status && status !== "all" ? status : null,
    dateFrom: dateFrom || null,
    dateTo:   dateTo || null,
  };
}

// GET /api/matches/summary
// Exact counts (status=new) per category + grand total -- never derived from
// a row payload, so it's accurate no matter how large the tables get.
router.get("/summary", async (req, res) => {
  try {
    const entries = Object.entries(TABLES);
    const counts = await Promise.all(
      entries.map(([, cfg]) =>
        supabase.from(cfg.table).select("id", { count: "exact", head: true }).eq("status", "new")
      )
    );

    const result = { totalNew: 0 };
    entries.forEach(([category], i) => {
      if (counts[i].error) throw new Error(`${category}: ${counts[i].error.message}`);
      const c = counts[i].count || 0;
      result[`${category}New`] = c;
      result.totalNew += c;
    });

    res.json(result);
  } catch (err) {
    console.error("[GET /api/matches/summary] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/matches?page=&pageSize=&source=&keyword=&status=&dateFrom=&dateTo=
// Server-side pagination, filtering, and sorting (newest first). Never loads
// an entire table into memory -- a single-source request paginates that
// table directly; an all-sources request bounds its per-table fetch to
// page*pageSize rows (only as much as could possibly land on this page),
// not the full table, then merges/sorts/slices to the exact requested page.
router.get("/", async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const filters  = parseFilters(req);
    const source   = req.query.source;

    const wantedCategories = source && source !== "all" && TABLES[source]
      ? [source]
      : Object.keys(TABLES);

    if (wantedCategories.length === 1) {
      const category = wantedCategories[0];
      const cfg = TABLES[category];
      const from = (page - 1) * pageSize;

      let dataQuery = supabase.from(cfg.table).select("*").order("created_at", { ascending: false });
      dataQuery = applyFilters(dataQuery, cfg, filters).range(from, from + pageSize - 1);

      let countQuery = supabase.from(cfg.table).select("id", { count: "exact", head: true });
      countQuery = applyFilters(countQuery, cfg, filters);

      const [{ data, error }, { count, error: countErr }] = await Promise.all([dataQuery, countQuery]);
      if (error) throw new Error(error.message);
      if (countErr) throw new Error(countErr.message);

      const rows = (data || []).map((r) => normalizeRow(category, cfg, r));
      return res.json({
        rows, page, pageSize,
        totalRows: count || 0,
        totalPages: Math.max(1, Math.ceil((count || 0) / pageSize)),
      });
    }

    // Combined view across all 4 tables: fetch up to `page*pageSize` rows
    // (newest first) from each table -- enough to guarantee correctness
    // after merging, bounded so it never grows past what this page needs.
    const upTo = page * pageSize;
    const entries = Object.entries(TABLES);

    const dataQueries = entries.map(([, cfg]) => {
      let q = supabase.from(cfg.table).select("*").order("created_at", { ascending: false });
      return applyFilters(q, cfg, filters).range(0, upTo - 1);
    });
    const countQueries = entries.map(([, cfg]) => {
      let q = supabase.from(cfg.table).select("id", { count: "exact", head: true });
      return applyFilters(q, cfg, filters);
    });

    const [dataResults, countResults] = await Promise.all([
      Promise.all(dataQueries),
      Promise.all(countQueries),
    ]);

    let merged = [];
    entries.forEach(([category, cfg], i) => {
      const { data, error } = dataResults[i];
      if (error) throw new Error(`${cfg.table}: ${error.message}`);
      merged.push(...(data || []).map((r) => normalizeRow(category, cfg, r)));
    });
    merged.sort((a, b) => new Date(b.date_found) - new Date(a.date_found));

    let totalRows = 0;
    countResults.forEach(({ count, error }) => {
      if (error) throw new Error(error.message);
      totalRows += count || 0;
    });

    const pageStart = (page - 1) * pageSize;
    const rows = merged.slice(pageStart, pageStart + pageSize);

    res.json({
      rows, page, pageSize, totalRows,
      totalPages: Math.max(1, Math.ceil(totalRows / pageSize)),
    });
  } catch (err) {
    console.error("[GET /api/matches] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/matches/:category/:id
// Updates the status of a match (new / reviewed / dismissed)
router.patch("/:category/:id", async (req, res) => {
  const { category, id } = req.params;
  const { status } = req.body;

  const cfg = TABLES[category];
  if (!cfg) return res.status(400).json({ error: "Invalid category" });

  try {
    const { data, error } = await supabase
      .from(cfg.table)
      .update({ status, reviewed_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    console.error("[PATCH /api/matches] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
